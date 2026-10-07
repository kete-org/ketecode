//go:build linux

package dedicated

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostguard"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostnet"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

// The test binary plays three roles: the tests, the reaper (Options.Self with InitArg) and, copied
// into the test root file system with its libraries, the job's entrypoint.
func TestMain(m *testing.M) {
	switch {
	case len(os.Args) > 1 && os.Args[1] == InitArg:
		os.Exit(RunInit())
	case len(os.Args) > 1 && os.Args[1] == "spawn-orphan":
		// Leave a grandchild behind for PID 1 to reap, and exit at once.
		p, err := os.StartProcess(os.Args[0], []string{os.Args[0], "orphan"}, &os.ProcAttr{Files: []*os.File{nil, nil, nil}})
		if err == nil {
			_ = p.Release()
		}
		os.Exit(0)
	case len(os.Args) > 1 && os.Args[1] == "orphan":
		time.Sleep(300 * time.Millisecond)
		os.Exit(0)
	case filepath.Base(os.Args[0]) == "kete-job-entrypoint":
		os.Exit(fakeEntrypoint())
	}
	os.Exit(m.Run())
}

// entrypointReport is what the fake entrypoint prints (one JSON line on stdout).
type entrypointReport struct {
	PID        int    `json:"pid"`
	ConfigFIFO bool   `json:"config_fifo"`
	Config     string `json:"config"`
	Args       string `json:"args"`
	Env        string `json:"env"`
	Hostname   string `json:"hostname"`
	Resolv     string `json:"resolv"`
	Route      bool   `json:"default_route"`
	AgentDir   bool   `json:"agent_dir"`
	Cgroup     string `json:"cgroup"`
	DevDisk    bool   `json:"dev_disk"`
	Zombies    int    `json:"zombies"`
	ExtraFDs   string `json:"extra_fds"`
	Umask      int    `json:"umask"`
	// The facts the entrypoint's shared-kernel guard checks (kete-job-entrypoint hostprofile
	// kernel.go, DedicatedReaper): PID 1's argv, the user and PID namespaces' nsfs inode numbers,
	// container-runtime mount points and marker files.
	PID1Args      []string `json:"pid1_args"`
	UserNS        uint64   `json:"user_ns"`
	PIDNS         uint64   `json:"pid_ns"`
	RuntimeMounts []string `json:"runtime_mounts"`
	MarkerFiles   []string `json:"marker_files"`
	PPID          int      `json:"ppid"`
	PID1Env       string   `json:"pid1_env"`
}

func fakeEntrypoint() int {
	// First, before this process opens anything: which descriptors beyond 0-3 did it inherit?
	var extra []string
	for fd := 4; fd < 64; fd++ {
		if _, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0); err == nil {
			target, _ := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", fd))
			if strings.HasPrefix(target, "/sys/fs/cgroup/") {
				continue // the Go runtime's own (GOMAXPROCS from cgroup cpu.max)
			}
			extra = append(extra, fmt.Sprintf("%d=%s", fd, target))
		}
	}
	r := entrypointReport{PID: os.Getpid(), Args: strings.Join(os.Args[1:], " "), Env: strings.Join(os.Environ(), " "), ExtraFDs: strings.Join(extra, ",")}
	var st unix.Stat_t
	if unix.Fstat(3, &st) == nil {
		r.ConfigFIFO = st.Mode&unix.S_IFMT == unix.S_IFIFO
	}
	b, _ := io.ReadAll(os.NewFile(3, "config"))
	r.Config = string(b)
	r.Hostname, _ = os.Hostname()
	rc, _ := os.ReadFile("/etc/resolv.conf")
	r.Resolv = string(rc)
	if route, err := os.ReadFile("/proc/net/route"); err == nil {
		r.Route = regexp.MustCompile(`(?m)^eth0\s+00000000\s+`).Match(route)
	}
	_, err := os.Stat("/var/lib/kete-job-host")
	r.AgentDir = err == nil
	cg, _ := os.ReadFile("/proc/self/cgroup")
	r.Cgroup = strings.TrimSpace(string(cg))
	ents, _ := os.ReadDir("/dev")
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "sd") || strings.HasPrefix(e.Name(), "vd") || strings.HasPrefix(e.Name(), "loop") || strings.HasPrefix(e.Name(), "nvme") {
			r.DevDisk = true
		}
	}
	r.Umask = unix.Umask(0o022)
	if b, err := os.ReadFile("/proc/1/cmdline"); err == nil {
		r.PID1Args = strings.Split(strings.TrimSuffix(string(b), "\x00"), "\x00")
	}
	for name, dst := range map[string]*uint64{"user": &r.UserNS, "pid": &r.PIDNS} {
		var st unix.Stat_t
		if unix.Stat("/proc/self/ns/"+name, &st) == nil {
			*dst = st.Ino
		}
	}
	if mi, err := os.ReadFile("/proc/self/mountinfo"); err == nil {
		for _, line := range strings.Split(string(mi), "\n") {
			f := strings.Fields(line)
			if len(f) < 5 {
				continue
			}
			for _, p := range []string{"/etc", "/dev/termination-log", "/run/secrets", "/var/run/secrets"} {
				if f[4] == p || strings.HasPrefix(f[4], p+"/") {
					r.RuntimeMounts = append(r.RuntimeMounts, f[4])
				}
			}
		}
	}
	r.PPID = os.Getppid()
	if b, err := os.ReadFile("/proc/1/environ"); err == nil {
		r.PID1Env = strings.ReplaceAll(strings.TrimSuffix(string(b), "\x00"), "\x00", " ")
	} else {
		r.PID1Env = "unreadable: " + err.Error()
	}
	for _, f := range []string{"/.dockerenv", "/run/.containerenv", "/run/systemd/container", "/run/host/container-manager"} {
		if _, err := os.Lstat(f); err == nil {
			r.MarkerFiles = append(r.MarkerFiles, f)
		}
	}
	// An orphan for PID 1: a child that exits at once, leaving a grandchild that exits soon after.
	if p, err := os.StartProcess(os.Args[0], []string{os.Args[0], "spawn-orphan"}, &os.ProcAttr{Files: []*os.File{nil, nil, nil}}); err == nil {
		_, _ = p.Wait()
	}
	time.Sleep(time.Second)
	procs, _ := os.ReadDir("/proc")
	for _, p := range procs {
		if s, err := os.ReadFile("/proc/" + p.Name() + "/stat"); err == nil {
			if i := bytes.LastIndexByte(s, ')'); i > 0 && len(s) > i+2 && s[i+2] == 'Z' {
				r.Zombies++
			}
		}
	}
	line, _ := json.Marshal(r)
	fmt.Println(string(line))
	if strings.Contains(r.Config, `"mode":"sleep"`) {
		for {
			time.Sleep(time.Hour)
		}
	}
	return 7
}

// ---------------------------------------------------------------- environment

type fakeTable struct{}

func (fakeTable) Apply(context.Context, hostnet.Table) (string, error) { return "listing", nil }
func (fakeTable) Check(context.Context, string) error                  { return nil }

type fixedImages struct{ path string }

func (f fixedImages) Rootfs(context.Context, string) (string, error) { return f.path, nil }

// needHost skips unless the test runs as root with loop devices, a writable cgroup v2 with the
// cpu, memory and pids controllers, ip and mkfs.ext4 (Docker --privileged, or CI with sudo).
func needHost(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root")
	}
	for _, p := range []string{"/dev/loop-control", "/sys/fs/cgroup/cgroup.controllers"} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("needs %s", p)
		}
	}
	for _, tool := range []string{"mkfs.ext4", "ip", "ldd"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("needs %s", tool)
		}
	}
	if err := os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1"), 0o644); err != nil {
		t.Skipf("can't enable IP forwarding: %v", err)
	}
	// At a cgroup namespace root (a container) this process must leave the root before the
	// driver can enable controllers there (cgroup v2's no-internal-processes rule).
	if cg, _ := os.ReadFile("/proc/self/cgroup"); strings.TrimSpace(string(cg)) == "0::/" {
		leaf := "/sys/fs/cgroup/kjh-test-init"
		if err := os.MkdirAll(leaf, 0o755); err != nil {
			t.Skipf("cgroup not writable: %v", err)
		}
		procs, _ := os.ReadFile("/sys/fs/cgroup/cgroup.procs")
		for _, p := range strings.Fields(string(procs)) {
			_ = os.WriteFile(filepath.Join(leaf, "cgroup.procs"), []byte(p), 0o644)
		}
	}
}

// buildRootfs makes a small ext4 image holding this test binary as the entrypoint, with every
// library it links (ldd), the way the image store's file would look.
func buildRootfs(t *testing.T, dir string) string {
	t.Helper()
	tree := filepath.Join(dir, "tree")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	copyFile := func(src, dst string, mode os.FileMode) {
		t.Helper()
		b, err := os.ReadFile(src)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, mode); err != nil {
			t.Fatal(err)
		}
	}
	copyFile(self, filepath.Join(tree, EntrypointBin), 0o755)
	out, _ := exec.Command("ldd", self).Output() // "not a dynamic executable" exits 1: nothing to copy
	for _, m := range regexp.MustCompile(`(/[^\s]+) \(0x`).FindAllStringSubmatch(string(out), -1) {
		copyFile(m[1], filepath.Join(tree, m[1]), 0o755)
	}
	for _, d := range []string{"etc", "proc", "sys", "dev", "run", "tmp"} {
		if err := os.MkdirAll(filepath.Join(tree, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// An image whose /etc/resolv.conf is a link out of the root: the reaper replaces the link.
	if err := os.Symlink("/etc/shadow", filepath.Join(tree, "etc/resolv.conf")); err != nil {
		t.Fatal(err)
	}
	img := filepath.Join(dir, "rootfs.ext4")
	if out, err := exec.Command("mkfs.ext4", "-q", "-F", "-L", "kete-root", "-d", tree, img, "128M").CombinedOutput(); err != nil {
		t.Fatalf("mkfs: %v: %s", err, out)
	}
	return img
}

func testDriver(t *testing.T) (*Driver, config.Config) {
	t.Helper()
	root := testroot.Dir(t)
	f := config.File{
		PlatformURL: "https://portal.kete.example", Driver: contract.DriverDedicated, Slots: 1, Reset: contract.ResetProviderRebuild,
		Generation: "g-test-1", StateDir: filepath.Join(root, "state"), Resolvers: []string{"1.1.1.1", "8.8.8.8"},
		Dedicated: &config.DedicatedFile{GuestNetwork: "10.231.0.0/30", MinFreeGiB: 1, PidsMax: 4096},
	}
	raw, _ := json.Marshal(f)
	cfg, err := config.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	self, _ := os.Executable()
	d, err := New(Options{Config: cfg, Images: fixedImages{buildRootfs(t, root)}, Nft: fakeTable{}, Self: self, CheckEvery: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		held, _ := d.List(context.Background())
		for _, id := range held {
			if err := d.Stop(context.Background(), id); err != nil {
				t.Errorf("cleanup stop %s: %v", id, err)
			}
		}
		cancel()
	})
	if err := d.Init(ctx); err != nil {
		t.Fatal(err)
	}
	if b := d.StartsBlocked(); b != "" {
		t.Fatalf("starts blocked: %s", b)
	}
	return d, cfg
}

// configMarker stands for the claim token; built at run time so the binary doesn't hold it.
var configMarker = fmt.Sprintf("%s-%x", "claim", []byte("token-marker"))

const (
	mid  = "5a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
	mid2 = "6b2e3d4c-5f6a-4b7c-9d8e-0f1a2b3c4d5e"
)

func spec(id, mode string) driver.Spec {
	return driver.Spec{
		MachineID: id, JobID: "7c3e4d5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", Image: "registry.test/kete-job@sha256:" + strings.Repeat("a", 64),
		Deadline: time.Now().Add(time.Hour), Resources: contract.Resources{VCPUs: 1, MemoryMiB: 512, ScratchGiB: 1},
		Config: []byte(`{"job":"` + configMarker + `","mode":"` + mode + `"}`),
	}
}

func waitStatus(t *testing.T, d *Driver, id string, want driver.Status, within time.Duration) {
	t.Helper()
	end := time.Now().Add(within)
	for {
		s, err := d.Status(context.Background(), id)
		if err == nil && s == want {
			return
		}
		if time.Now().After(end) {
			b, _ := os.ReadFile(d.consolePath(id))
			t.Fatalf("status %v (%v), want %v; console:\n%s", s, err, want, b)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func readReport(t *testing.T, d *Driver, id string) entrypointReport {
	t.Helper()
	var lines [][]byte
	end := time.Now().Add(20 * time.Second)
	for time.Now().Before(end) {
		got, err := d.Logs(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, got...)
		for _, l := range lines {
			var r entrypointReport
			if json.Unmarshal(l, &r) == nil && r.PID != 0 {
				return r
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	con, _ := os.ReadFile(d.consolePath(id))
	ex, _ := os.ReadFile(d.at(id, "exit"))
	st, _ := d.Status(context.Background(), id)
	t.Fatalf("no entrypoint report; lines: %q; console %q; exit %q; status %v", lines, con, ex, st)
	return entrypointReport{}
}

// assertNoResidue: no machine directory, cgroup, veth, mount or loop device of the driver left.
func assertNoResidue(t *testing.T, d *Driver) {
	t.Helper()
	if held, _ := d.List(context.Background()); len(held) > 0 {
		t.Errorf("held after stop: %v", held)
	}
	if taps, _ := hostnet.Taps(); len(taps) > 0 {
		t.Errorf("veths left: %v", taps)
	}
	mi, _ := os.ReadFile("/proc/self/mountinfo")
	if bytes.Contains(mi, []byte(d.dir+"/")) {
		t.Errorf("mounts left under %s", d.dir)
	}
	end := time.Now().Add(5 * time.Second)
	for {
		out, _ := exec.Command("losetup", "-a").Output()
		if !bytes.Contains(out, []byte(d.dir)) {
			return
		}
		if time.Now().After(end) {
			t.Errorf("loop devices left: %s", out)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// ---------------------------------------------------------------- tests

// TestJobRunsAndExits (AC6): the entrypoint runs under the reaper (PID 1), with the config on a
// FIFO as fd 3, the dedicated profile, its own hostname, network and cgroup namespace, a fresh
// resolv.conf (not the image's link), no disk device and no agent directory; the orphan it leaves
// is reaped; its end is `exited`; Stop leaves nothing.
func TestJobRunsAndExits(t *testing.T) {
	needHost(t)
	d, cfg := testDriver(t)
	ctx := context.Background()
	if err := d.Start(ctx, spec(mid, "exit")); err != nil {
		t.Fatal(err)
	}
	r := readReport(t, d, mid)
	switch {
	case r.PID <= 1:
		t.Errorf("entrypoint pid %d (the reaper is PID 1)", r.PID)
	case !r.ConfigFIFO || r.Config != string(spec(mid, "exit").Config):
		t.Errorf("config pipe: fifo %v, %q", r.ConfigFIFO, r.Config)
	case r.Args != "--config-fd 3":
		t.Errorf("args %q", r.Args)
	case r.Env != "PATH=/usr/sbin:/usr/bin:/sbin:/bin KETE_JOB_HOST_PROFILE=dedicated":
		t.Errorf("env %q", r.Env)
	case r.Hostname != Hostname:
		t.Errorf("hostname %q", r.Hostname)
	case r.Resolv != "nameserver 1.1.1.1\nnameserver 8.8.8.8\n":
		t.Errorf("resolv.conf %q", r.Resolv)
	case !r.Route:
		t.Error("no default route via eth0")
	case r.AgentDir:
		t.Error("the agent's directory is visible")
	case r.Cgroup != "0::/":
		t.Errorf("cgroup %q, want the namespace root", r.Cgroup)
	case r.DevDisk:
		t.Error("a disk device is visible in /dev")
	case r.Zombies != 0:
		t.Errorf("%d zombies: the reaper didn't reap the orphan", r.Zombies)
	case r.ExtraFDs != "":
		t.Errorf("descriptors beyond 0-3 leaked into the entrypoint: %s", r.ExtraFDs)
	case r.Umask != 0o022:
		t.Errorf("umask %o", r.Umask)
	}
	// What the entrypoint's shared-kernel guard requires of a dedicated job (kete-job-entrypoint
	// hostprofile.DedicatedReaper): the initial user namespace, a PID namespace of its own, the
	// reaper as PID 1 with argv exactly [<exe>, InitArg] and as the entrypoint's parent, no
	// container-runtime mount or marker, no `container=` in PID 1's environment.
	const initUserNS, initPIDNS = 0xEFFFFFFD, 0xEFFFFFFC
	switch {
	case r.UserNS != initUserNS:
		t.Errorf("user namespace %#x, want the initial one", r.UserNS)
	case r.PIDNS == 0 || r.PIDNS == initPIDNS:
		t.Errorf("pid namespace %#x, want one of the job's own", r.PIDNS)
	case len(r.PID1Args) != 2 || r.PID1Args[1] != InitArg:
		t.Errorf("PID 1 argv %q, want [<exe> %s]", r.PID1Args, InitArg)
	case len(r.RuntimeMounts) != 0:
		t.Errorf("container-runtime mount points %q", r.RuntimeMounts)
	case len(r.MarkerFiles) != 0:
		t.Errorf("container marker files %q", r.MarkerFiles)
	case r.PPID != 1:
		t.Errorf("the entrypoint's parent is %d, want the reaper (PID 1)", r.PPID)
	case strings.HasPrefix(r.PID1Env, "unreadable") || strings.Contains(" "+r.PID1Env, " container="):
		t.Errorf("PID 1's environment %q", r.PID1Env)
	}
	// The cgroup limits are on the machine's cgroup.
	for _, f := range []struct{ name, want string }{{"cpu.max", "100000 100000"}, {"memory.max", "536870912"}, {"pids.max", "4096"}} {
		if b, err := os.ReadFile(filepath.Join(d.cgroup(mid), f.name)); err != nil || strings.TrimSpace(string(b)) != f.want {
			t.Errorf("%s = %q (%v), want %s", f.name, b, err, f.want)
		}
	}
	waitStatus(t, d, mid, driver.StatusExited, 20*time.Second)
	if b, _ := os.ReadFile(d.at(mid, "exit")); string(b) != "exited 7\n" {
		t.Errorf("exit file %q", b)
	}
	// Nothing on the host holds the configuration (the pipe only).
	_ = filepath.WalkDir(cfg.StateDir, func(p string, e fs.DirEntry, err error) error {
		if err == nil && e.IsDir() && (p == d.at(mid, "lower") || p == d.at(mid, "root")) {
			return filepath.SkipDir // the image's content (this test binary, which holds the marker)
		}
		if err == nil && e.Type().IsRegular() && !strings.HasSuffix(p, ".ext4") && !strings.HasSuffix(p, ".img") && !strings.HasSuffix(p, "console.log") {
			if b, _ := os.ReadFile(p); bytes.Contains(b, []byte(configMarker)) {
				t.Errorf("%s holds the configuration", p)
			}
		}
		return nil
	})
	if err := d.Stop(ctx, mid); err != nil {
		t.Fatal(err)
	}
	if s, _ := d.Status(ctx, mid); s != driver.StatusGone {
		t.Errorf("status after stop %v", s)
	}
	assertNoResidue(t, d)
	if err := d.Stop(ctx, mid); err != nil {
		t.Fatalf("second stop: %v", err)
	}
}

// TestOneAtATimeStopAndCrash: a second machine is refused while one is held; Stop kills a running
// job; a reaper killed from outside is `crashed`; an unknown machine stops fine.
func TestOneAtATimeStopAndCrash(t *testing.T) {
	needHost(t)
	d, _ := testDriver(t)
	ctx := context.Background()
	if err := d.Start(ctx, spec(mid, "sleep")); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, d, mid, driver.StatusRunning, 10*time.Second)
	readReport(t, d, mid)
	if err := d.Start(ctx, spec(mid2, "sleep")); err == nil || !strings.Contains(err.Error(), "one job at a time") {
		t.Fatalf("second start: %v", err)
	}
	if held, _ := d.List(ctx); len(held) != 1 || held[0] != mid {
		t.Fatalf("held %v", held)
	}
	r, err := d.load(mid)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Kill(r.PID, unix.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, d, mid, driver.StatusCrashed, 10*time.Second)
	if err := d.Stop(ctx, mid); err != nil {
		t.Fatal(err)
	}
	assertNoResidue(t, d)

	if err := d.Start(ctx, spec(mid2, "sleep")); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, d, mid2, driver.StatusRunning, 10*time.Second)
	sctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := d.Stop(sctx, mid2); err != nil {
		t.Fatal(err)
	}
	assertNoResidue(t, d)
	if err := d.Stop(ctx, "0e1d2c3b-4a5f-4e6d-8c7b-6a5f4e3d2c1b"); err != nil {
		t.Fatalf("unknown machine: %v", err)
	}
}

// TestStartFailureCleansUp: a reaper that fails before the entrypoint (no entrypoint in the image)
// fails Start; Stop then leaves nothing.
func TestStartFailureCleansUp(t *testing.T) {
	needHost(t)
	d, _ := testDriver(t)
	dir := t.TempDir()
	tree := filepath.Join(dir, "tree")
	if err := os.MkdirAll(filepath.Join(tree, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	img := filepath.Join(dir, "empty.ext4")
	if out, err := exec.Command("mkfs.ext4", "-q", "-F", "-d", tree, img, "16M").CombinedOutput(); err != nil {
		t.Fatalf("mkfs: %v: %s", err, out)
	}
	d.o.Images = fixedImages{img}
	err := d.Start(context.Background(), spec(mid, "exit"))
	if err == nil || !strings.Contains(err.Error(), "entrypoint") {
		t.Fatalf("start without an entrypoint: %v", err)
	}
	if err := d.Stop(context.Background(), mid); err != nil {
		t.Fatal(err)
	}
	assertNoResidue(t, d)
}

// TestReaperRefusesOutsideItsNamespace: run as an ordinary process, the reaper refuses.
func TestReaperRefusesOutsideItsNamespace(t *testing.T) {
	self, _ := os.Executable()
	cmd := exec.Command(self, InitArg)
	out, err := cmd.CombinedOutput()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 1 || !bytes.Contains(out, []byte("PID 1")) {
		t.Fatalf("%v: %s", err, out)
	}
}

// TestInitRefusesInAContainer: the host guard runs first in Init; a refusal writes nothing (no
// machines directory, no parent cgroup, no table).
func TestInitRefusesInAContainer(t *testing.T) {
	root := t.TempDir()
	f := config.File{
		PlatformURL: "https://portal.kete.example", Driver: contract.DriverDedicated, Slots: 1, Reset: contract.ResetProviderRebuild,
		Generation: "g-test-1", StateDir: filepath.Join(root, "state"), Resolvers: []string{"1.1.1.1"},
		Dedicated: &config.DedicatedFile{GuestNetwork: "10.231.0.0/30", MinFreeGiB: 1, PidsMax: 4096},
	}
	raw, _ := json.Marshal(f)
	cfg, err := config.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	d, err := New(Options{Config: cfg, Images: fixedImages{"/nonexistent"}, Nft: fakeTable{}, CgroupRoot: filepath.Join(root, "cgroup"),
		HostGuard: func() error { return hostguard.ErrContainer }})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Init(context.Background()); !errors.Is(err, hostguard.ErrContainer) {
		t.Fatalf("Init: %v", err)
	}
	for _, p := range []string{d.dir, filepath.Join(root, "cgroup")} {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("%s was created", p)
		}
	}
}
