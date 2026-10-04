//go:build linux

package dedicated

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// RunInit is the reaper, `kete-job-host __dedicated-init`: PID 1 of the job's namespaces, started
// by Driver.Start with the descriptors fdConfig..fdExit. It waits for the agent's InitSpec, sets
// up the job's network, mounts and root, starts the entrypoint with the configuration pipe, reaps
// every child until the entrypoint exits, kills what is left and records the end. It returns the
// process exit code. Errors before the entrypoint runs go to the agent on fdReport (Start fails);
// nothing of the job runs then.
func RunInit() int {
	// unshare(CLONE_NEWCGROUP) changes this thread only: the cgroup2 mount and the entrypoint's
	// fork must happen on the same thread, so the main goroutine stays on it for good.
	runtime.LockOSThread()
	// The agent's descriptors reach nobody else: not the ip commands, not the entrypoint (which
	// gets the configuration pipe explicitly as its fd 3).
	for fd := fdConfig; fd <= fdExit; fd++ {
		unix.CloseOnExec(fd)
	}
	// The agent's unit runs with umask 077; the job's files (resolv.conf, hosts) need the usual.
	unix.Umask(0o022)
	report := os.NewFile(fdReport, "report")
	fail := func(stage string, err error) int {
		if report != nil {
			fmt.Fprintf(report, "error: %s: %v\n", stage, err)
		}
		fmt.Fprintf(os.Stderr, "kete-job-host dedicated init: %s: %v\n", stage, err)
		return 1
	}
	if os.Getpid() != 1 {
		return fail("pid", errors.New("the dedicated init runs only as PID 1 of a job's namespaces"))
	}
	spec, err := readSpec(os.NewFile(fdControl, "control"))
	if err != nil {
		return fail("spec", err)
	}
	if err := initNetwork(spec); err != nil {
		return fail("network", err)
	}
	if err := initMounts(spec.Root); err != nil {
		return fail("mounts", err)
	}
	if err := pivot(spec.Root); err != nil {
		return fail("pivot", err)
	}
	if err := initEtc(spec); err != nil {
		return fail("etc", err)
	}
	cfg := os.NewFile(fdConfig, "config")
	null, err := os.OpenFile("/dev/null", os.O_RDWR, 0)
	if err != nil {
		return fail("devnull", err)
	}
	p, err := os.StartProcess(EntrypointBin, []string{EntrypointBin, ConfigFDArg, "3"}, &os.ProcAttr{
		Dir: "/", Env: guestEnv, Files: []*os.File{null, os.Stdout, os.Stderr, cfg},
	})
	cfg.Close()
	null.Close()
	if err != nil {
		return fail("entrypoint", err)
	}
	pid := p.Pid
	_ = p.Release()
	fmt.Fprintln(report, "ok")
	report.Close()
	// The reaper must outlive an out-of-memory job: the kernel's OOM killer picks a job process,
	// never PID 1 (set after the fork, so the entrypoint and its descendants keep the default).
	_ = os.WriteFile("/proc/self/oom_score_adj", []byte("-1000"), 0o644)
	code := reap(pid)
	// The job ends with its entrypoint: nothing it started outlives it (PID 1 leaving would kill
	// the rest anyway; this way the end is recorded after they are gone).
	_ = unix.Kill(-1, unix.SIGKILL)
	reapRemaining(5 * time.Second)
	if code < 0 {
		// The entrypoint's end was never seen: no exit record, so Status says crashed.
		fmt.Fprintln(os.Stderr, "kete-job-host dedicated init: lost the entrypoint's wait status")
		return 1
	}
	if f := os.NewFile(fdExit, "exit"); f != nil {
		fmt.Fprintf(f, "exited %d\n", code)
		_ = f.Sync()
		f.Close()
	}
	return 0
}

func readSpec(f *os.File) (InitSpec, error) {
	if f == nil {
		return InitSpec{}, errors.New("no control pipe")
	}
	defer f.Close()
	line, err := bufio.NewReaderSize(io.LimitReader(f, 16<<10), 16<<10).ReadBytes('\n')
	if err != nil {
		return InitSpec{}, fmt.Errorf("control pipe: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	var s InitSpec
	if err := dec.Decode(&s); err != nil {
		return InitSpec{}, err
	}
	return s, s.Validate()
}

// initNetwork configures the job's network namespace with the host's ip binary, before the pivot
// (the image may have no ip). The agent created eth0 here; IPv6 is off (ADR 0023 rule 7: guests
// get no IPv6 route, and the host table drops every IPv6 packet anyway).
func initNetwork(s InitSpec) error {
	// /proc/sys/net is the opener's network namespace: this writes the job's, not the host's.
	for _, f := range []string{"/proc/sys/net/ipv6/conf/all/disable_ipv6", "/proc/sys/net/ipv6/conf/default/disable_ipv6"} {
		if err := os.WriteFile(f, []byte("1"), 0o644); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, args := range [][]string{
		{"link", "set", "dev", "lo", "up"},
		{"addr", "add", s.Address, "dev", "eth0"},
		{"link", "set", "dev", "eth0", "up"},
		{"route", "add", "default", "via", s.Gateway, "dev", "eth0"},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		cmd := exec.CommandContext(ctx, s.IPBin, args...)
		cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
		out, err := cmd.CombinedOutput()
		cancel()
		if err != nil {
			return fmt.Errorf("ip %s: %v: %s", strings.Join(args, " "), err, bytes.TrimSpace(limit(out, 256)))
		}
	}
	return nil
}

type devNode struct {
	name         string
	major, minor uint32
}

// devNodes are the job's only devices (Docker's default set): no disk, no host console.
var devNodes = []devNode{{"null", 1, 3}, {"zero", 1, 5}, {"full", 1, 7}, {"random", 1, 8}, {"urandom", 1, 9}, {"tty", 5, 0}}

// initMounts makes every mount private (nothing propagates to or from the host), then mounts the
// job's /proc (its PID namespace), a read-only /sys, a tmpfs /dev with the fixed nodes, devpts and
// /dev/shm, /run, and cgroup2 in a cgroup namespace rooted at the machine's cgroup.
func initMounts(root string) error {
	if err := unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""); err != nil {
		return fmt.Errorf("make / private: %w", err)
	}
	const nsne = unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC
	at := func(p string) string { return filepath.Join(root, p) }
	steps := []struct {
		src, target, fstype string
		flags               uintptr
		data                string
	}{
		{"proc", "proc", "proc", nsne, ""},
		{"sysfs", "sys", "sysfs", nsne | unix.MS_RDONLY, ""},
		{"tmpfs", "dev", "tmpfs", unix.MS_NOSUID | unix.MS_NOEXEC, "mode=0755,size=1m,nr_inodes=64"},
	}
	for _, m := range steps {
		if err := mkdirIn(root, m.target); err != nil {
			return err
		}
		if err := unix.Mount(m.src, at(m.target), m.fstype, m.flags, m.data); err != nil {
			return fmt.Errorf("mount %s: %w", m.target, err)
		}
	}
	for _, d := range devNodes {
		p := at("dev/" + d.name)
		if err := unix.Mknod(p, unix.S_IFCHR|0o666, int(unix.Mkdev(d.major, d.minor))); err != nil {
			return fmt.Errorf("mknod %s: %w", d.name, err)
		}
		if err := os.Chmod(p, 0o666); err != nil { // the umask applied to mknod
			return err
		}
	}
	for _, d := range []string{"dev/pts", "dev/shm"} {
		if err := os.Mkdir(at(d), 0o755); err != nil {
			return err
		}
	}
	if err := unix.Mount("devpts", at("dev/pts"), "devpts", unix.MS_NOSUID|unix.MS_NOEXEC, "newinstance,ptmxmode=0666,mode=0620,gid=5"); err != nil {
		return fmt.Errorf("mount devpts: %w", err)
	}
	if err := unix.Mount("tmpfs", at("dev/shm"), "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=1777"); err != nil {
		return fmt.Errorf("mount /dev/shm: %w", err)
	}
	for link, target := range map[string]string{"ptmx": "pts/ptmx", "fd": "/proc/self/fd", "stdin": "/proc/self/fd/0", "stdout": "/proc/self/fd/1", "stderr": "/proc/self/fd/2"} {
		if err := os.Symlink(target, at("dev/"+link)); err != nil {
			return err
		}
	}
	if err := mkdirIn(root, "run"); err != nil {
		return err
	}
	if err := unix.Mount("tmpfs", at("run"), "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0755"); err != nil {
		return fmt.Errorf("mount /run: %w", err)
	}
	// This process was cloned into the machine's cgroup; a cgroup namespace rooted there makes it
	// the job's /sys/fs/cgroup, which the entrypoint subdivides (as under Docker's private
	// cgroupns). The locked thread keeps the namespace for the mount and the entrypoint's fork.
	if err := unix.Unshare(unix.CLONE_NEWCGROUP); err != nil {
		return fmt.Errorf("cgroup namespace: %w", err)
	}
	if err := unix.Mount("cgroup2", at("sys/fs/cgroup"), "cgroup2", nsne, "nsdelegate"); err != nil {
		// nsdelegate is a per-superblock option; a host mounted without it refuses the change.
		if err2 := unix.Mount("cgroup2", at("sys/fs/cgroup"), "cgroup2", nsne, ""); err2 != nil {
			return fmt.Errorf("mount cgroup2: %w", err)
		}
	}
	return nil
}

// mkdirIn creates root/rel when missing, refusing a symlink anywhere on the way (the image is
// signed and allowlisted, but a link must never move a mount onto a host path).
func mkdirIn(root, rel string) error {
	cur := root
	for _, part := range strings.Split(rel, "/") {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		switch {
		case errors.Is(err, os.ErrNotExist):
			if err := os.Mkdir(cur, 0o755); err != nil {
				return err
			}
		case err != nil:
			return err
		case !fi.IsDir():
			return fmt.Errorf("%s is not a directory", strings.TrimPrefix(cur, root))
		}
	}
	return nil
}

// pivot makes root the job's / and drops the host's tree from this mount namespace.
func pivot(root string) error {
	if err := unix.Chdir(root); err != nil {
		return err
	}
	if err := unix.PivotRoot(".", "."); err != nil {
		return fmt.Errorf("pivot_root: %w", err)
	}
	// The old root is stacked under the new one at "."; detach it.
	if err := unix.Unmount(".", unix.MNT_DETACH); err != nil {
		return fmt.Errorf("detach the host root: %w", err)
	}
	return unix.Chdir("/")
}

// initEtc sets the hostname and writes resolv.conf and hosts inside the job's root (after the
// pivot, so no link in the image can point them at a host file).
func initEtc(s InitSpec) error {
	if err := unix.Sethostname([]byte(Hostname)); err != nil {
		return err
	}
	var rc strings.Builder
	for _, r := range s.Resolvers {
		rc.WriteString("nameserver " + r + "\n")
	}
	if err := replaceFile("/etc/resolv.conf", rc.String()); err != nil {
		return err
	}
	return replaceFile("/etc/hosts", "127.0.0.1\tlocalhost\n127.0.1.1\t"+Hostname+"\n")
}

func replaceFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// reap waits for every child until pid exits and returns its exit code (128+n for a signal).
// Orphans re-parented to this PID 1 are reaped on the way, so none lingers as a zombie.
func reap(pid int) int {
	for {
		var ws unix.WaitStatus
		got, err := unix.Wait4(-1, &ws, 0, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return -1
		}
		if got != pid {
			continue
		}
		switch {
		case ws.Exited():
			return ws.ExitStatus()
		case ws.Signaled():
			return 128 + int(ws.Signal())
		}
	}
}

// reapRemaining reaps whatever is left until no child remains or d passes.
func reapRemaining(d time.Duration) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		var ws unix.WaitStatus
		_, err := unix.Wait4(-1, &ws, unix.WNOHANG, nil)
		if errors.Is(err, unix.ECHILD) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func limit(b []byte, n int) []byte {
	if len(b) > n {
		return b[:n]
	}
	return b
}
