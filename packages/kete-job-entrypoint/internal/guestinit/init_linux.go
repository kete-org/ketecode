//go:build linux

package guestinit

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/dhcp"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
	pl "github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

// GuestArg is argv[1] of stage 2 (re-executed from the overlay root).
const GuestArg = "__guest"

// ScratchLabel is the ext4 label of the microvm's scratch disk (the overlay's upper layer; the
// host agent creates it empty and formatted, and deletes it with the VM).
const ScratchLabel = "kete-scratch"

// Fixed paths.
const (
	entrypointBin = "/usr/local/libexec/kete/kete-job-entrypoint"
	nftBin        = "/usr/sbin/nft"
	resolvConf    = "/etc/resolv.conf"
	pnpFile       = "/proc/net/pnp"
	cmdlineFile   = "/proc/cmdline"
	stageDir      = "/mnt" // the scratch disk's mount point in stage 1 (an empty directory in the image)
)

var guestEnv = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}

// Stage1 is kete-job-init as the kernel starts it: PID 1 on the read-only image root. It mounts
// /proc, /sys and /dev, makes the console its stdio, and when a scratch disk is present builds
// the writable overlay root on it, pivots into it and re-executes stage 2 from there (so PID 1's
// executable is the overlay's kete-job-init, the path the entrypoint checks). It never returns.
func Stage1() {
	if os.Getpid() != 1 {
		fmt.Fprintln(os.Stderr, "kete-job-init runs only as PID 1 of a job guest")
		os.Exit(2)
	}
	// A panic must never leave PID 1 dead with the machine up (the kernel would panic, and with
	// `panic=1` on the guest's command line reboot): power off instead.
	defer powerOffOnPanic()
	mounted := baseMounts()
	console()
	log := pl.New(os.Stdout) // stdout is the console now
	if mounted != nil {
		log.FailErr(pl.StepInitMount, pl.CodeFailed, mounted)
		shutdown(PowerOff)
	}
	log.Start(pl.StepInitRoot)
	dev, err := findScratch(layout.Default().SysBlockDir, layout.Default().DevDir)
	if err != nil {
		log.FailErr(pl.StepInitRoot, pl.CodeFailed, err)
		shutdown(PowerOff)
	}
	if dev == "" {
		// No scratch disk (a cloudvm's root disk is already writable): stay on this root.
		log.OK(pl.StepInitRoot)
		Stage2(log)
		return
	}
	if err := overlayRoot(dev); err != nil {
		log.FailErr(pl.StepInitRoot, pl.CodeFailed, err)
		shutdown(PowerOff)
	}
	log.OK(pl.StepInitRoot)
	bin := layout.Default().InitBin
	err = unix.Exec(bin, []string{bin, GuestArg}, guestEnv)
	log.FailErr(pl.StepInitRoot, pl.CodeFailed, err)
	shutdown(PowerOff)
}

// Stage2 runs the job's guest (Run with the real machine). It never returns.
func Stage2(log *pl.Logger) {
	if os.Getpid() != 1 {
		fmt.Fprintln(os.Stderr, "kete-job-init runs only as PID 1 of a job guest")
		os.Exit(2)
	}
	defer powerOffOnPanic()
	if log == nil {
		log = pl.New(os.Stdout)
	}
	// SIGTERM and SIGINT (ctrl-alt-del with CAD off) are forwarded to the entrypoint by Wait; until
	// then they are ignored, as the kernel ignores them for PID 1 without a handler.
	signal.Ignore(unix.SIGTERM, unix.SIGINT, unix.SIGHUP)
	_ = unix.Reboot(unix.LINUX_REBOOT_CMD_CAD_OFF)
	Run(context.Background(), NewMachine(), log)
	shutdown(PowerOff) // Run always shuts down; this is only reached if Shutdown returned
}

// powerOffOnPanic is deferred by both stages: a recovered panic powers the machine off. (Run also
// recovers, so the Deps-level path is unit tested; a panic in another goroutine still kills PID 1,
// which the guest kernel's `panic=1` turns into a reboot that Firecracker treats as exit.)
func powerOffOnPanic() {
	if recover() != nil {
		shutdown(PowerOff)
	}
}

func statfsType(path string) int64 {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return -1
	}
	return int64(st.Type)
}

// mountIf mounts fstype at target unless a file system of magic is already there.
func mountIf(source, target, fstype string, magic int64, flags uintptr, data string) error {
	if magic != 0 && statfsType(target) == magic {
		return nil
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	if err := unix.Mount(source, target, fstype, flags, data); err != nil {
		return fmt.Errorf("mount %s: %w", target, err)
	}
	return nil
}

func baseMounts() error {
	const nosuidNodevNoexec = unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC
	if err := mountIf("proc", "/proc", "proc", unix.PROC_SUPER_MAGIC, nosuidNodevNoexec, ""); err != nil {
		return err
	}
	if err := mountIf("sysfs", "/sys", "sysfs", unix.SYSFS_MAGIC, nosuidNodevNoexec, ""); err != nil {
		return err
	}
	// devtmpfs reports the tmpfs magic; /dev/null tells whether one is already there.
	if _, err := os.Stat("/dev/null"); err != nil {
		if err := mountIf("devtmpfs", "/dev", "devtmpfs", 0, unix.MS_NOSUID|unix.MS_NOEXEC, "mode=0755"); err != nil {
			return err
		}
	}
	// No shared propagation, so pivot_root works and nothing leaks between mount points.
	return unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, "")
}

// console makes /dev/console the stdio when the kernel couldn't (an image with an empty /dev).
func console() {
	if _, err := unix.FcntlInt(1, unix.F_GETFD, 0); err == nil {
		return
	}
	fd, err := unix.Open("/dev/console", unix.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		return
	}
	for i := 0; i <= 2; i++ {
		_ = unix.Dup3(fd, i, 0)
	}
	if fd > 2 {
		unix.Close(fd)
	}
}

// ext4Label reads an ext4 superblock's volume label (magic 0xEF53 at 1024+56, label at 1024+120).
func ext4Label(r io.ReaderAt) (string, bool) {
	sb := make([]byte, 136)
	if _, err := r.ReadAt(sb, 1024); err != nil {
		return "", false
	}
	if binary.LittleEndian.Uint16(sb[56:58]) != 0xEF53 {
		return "", false
	}
	return string(bytes.TrimRight(sb[120:136], "\x00")), true
}

func findScratch(sysBlock, devDir string) (string, error) {
	devs, err := hostprofile.BlockDevices(sysBlock, devDir)
	if err != nil {
		return "", err
	}
	found := ""
	for _, d := range devs {
		f, err := os.OpenFile(d, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
		if err != nil {
			continue
		}
		label, ok := ext4Label(f)
		f.Close()
		if ok && label == ScratchLabel {
			if found != "" {
				return "", errors.New("more than one scratch disk")
			}
			found = d
		}
	}
	return found, nil
}

// overlayRoot mounts the scratch disk, an overlay of the read-only root with the scratch disk as
// its upper layer, moves /proc, /sys and /dev into it and pivots into it.
func overlayRoot(dev string) error {
	if err := unix.Mount(dev, stageDir, "ext4", unix.MS_NOSUID|unix.MS_NODEV, ""); err != nil {
		return fmt.Errorf("mount scratch: %w", err)
	}
	upper, work, root := filepath.Join(stageDir, "upper"), filepath.Join(stageDir, "work"), filepath.Join(stageDir, "root")
	for _, d := range []string{upper, work, root} {
		if err := os.Mkdir(d, 0o755); err != nil {
			return err
		}
	}
	if err := unix.Mount("overlay", root, "overlay", 0, "lowerdir=/,upperdir="+upper+",workdir="+work); err != nil {
		return fmt.Errorf("mount overlay: %w", err)
	}
	for _, m := range []string{"/proc", "/sys", "/dev"} {
		if err := unix.Mount(m, filepath.Join(root, m), "", unix.MS_MOVE, ""); err != nil {
			return fmt.Errorf("move %s: %w", m, err)
		}
	}
	if err := unix.Chdir(root); err != nil {
		return err
	}
	if err := unix.PivotRoot(".", strings.TrimPrefix(stageDir, "/")); err != nil {
		return fmt.Errorf("pivot_root: %w", err)
	}
	if err := unix.Chroot("."); err != nil {
		return err
	}
	if err := unix.Chdir("/"); err != nil {
		return err
	}
	// The old root (with the scratch mount under it) goes; the overlay keeps the scratch alive.
	return unix.Unmount(stageDir, unix.MNT_DETACH)
}

// Machine is the real Deps.
type Machine struct {
	Paths  layout.Config
	Client UserDataClient
	DHCP   dhcp.Client
}

// NewMachine is the production machine.
func NewMachine() *Machine {
	return &Machine{Paths: layout.Default(), Client: DefaultUserDataClient(), DHCP: dhcp.DefaultClient()}
}

func (m *Machine) Mounts() error {
	if err := mountIf("cgroup2", "/sys/fs/cgroup", "cgroup2", unix.CGROUP2_SUPER_MAGIC, unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, "nsdelegate"); err != nil {
		return err
	}
	if err := mountIf("tmpfs", "/run", "tmpfs", 0, unix.MS_NOSUID|unix.MS_NODEV, "mode=0755"); err != nil {
		return err
	}
	return mountIf("tmpfs", "/dev/shm", "tmpfs", 0, unix.MS_NOSUID|unix.MS_NODEV, "mode=1777")
}

// Network: loopback up, then the uplink. A cloudvm command line (kete.net=dhcp, ParseCmdline)
// has kete-job-init's DHCP client configure it (the kernel's own can't install GCP's or Hetzner's
// off-link gateways) and names the resolvers (kete.dns); otherwise the kernel's `ip=` configured
// it before init ran (microvm) and the resolvers come from the kernel (/proc/net/pnp: the `ip=`
// argument's dns0/dns1), without link-local ones (the metadata service is dropped in cloudvm and
// unreachable in microvm). Either way it then waits (up to 20 s) for an interface with an IPv4
// address and a default route.
func (m *Machine) Network(ctx context.Context) error {
	if err := linkUp("lo"); err != nil {
		return err
	}
	raw, err := os.ReadFile(cmdlineFile)
	if err != nil {
		return err
	}
	nc, err := ParseCmdline(string(raw))
	if err != nil {
		return &codeError{code: pl.CodeInvalid, err: err}
	}
	if nc.DHCP {
		up, err := dhcp.FindUplink()
		if err != nil {
			return err
		}
		dctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		_, err = m.DHCP.Configure(dctx, up)
		cancel()
		if err != nil {
			return err
		}
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		ok, err := uplinkReady(m.Paths.RouteFile)
		if err != nil {
			return err
		}
		if ok {
			break
		}
		if time.Now().After(deadline) {
			return &codeError{code: pl.CodeTimeout, err: errors.New("no uplink with a default route")}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	ns := nc.Resolvers
	if !nc.DHCP {
		f, err := os.Open(pnpFile)
		if err != nil {
			return err
		}
		ns, err = Nameservers(f)
		f.Close()
		if err != nil {
			return err
		}
	}
	var b strings.Builder
	for _, n := range ns {
		b.WriteString("nameserver " + n + "\n")
	}
	tmp := resolvConf + ".kete-init"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, resolvConf)
}

func linkUp(name string) error {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq(name)
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return err
	}
	ifr.SetUint16(ifr.Uint16() | unix.IFF_UP)
	return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr)
}

func uplinkReady(routeFile string) (bool, error) {
	f, err := os.Open(routeFile)
	if err != nil {
		return false, err
	}
	gws, err := hostprofile.DefaultGateways(f)
	f.Close()
	if err != nil || len(gws) == 0 {
		return false, err
	}
	ifs, err := net.Interfaces()
	if err != nil {
		return false, err
	}
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback != 0 || i.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := i.Addrs()
		if err != nil {
			return false, err
		}
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil {
				return true, nil
			}
		}
	}
	return false, nil
}

func (m *Machine) FindConfigDisk() (string, error) {
	return hostprofile.FindConfigDisk(m.Paths.SysBlockDir, m.Paths.DevDir)
}

func (m *Machine) ReadConfigDisk(dev string) (bootenv.Config, error) {
	f, err := os.OpenFile(dev, os.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return bootenv.Config{}, err
	}
	defer f.Close()
	return ParseConfigDisk(f)
}

// RemoveConfigDisk unbinds the device's driver (the block device and its node disappear from the
// guest; the host agent also unlinks the backing file once the VM has started) and confirms it's
// gone.
func (m *Machine) RemoveConfigDisk(dev string) error {
	name := filepath.Base(dev)
	sys := filepath.Join(m.Paths.SysBlockDir, name)
	device, err := filepath.EvalSymlinks(filepath.Join(sys, "device"))
	if err != nil {
		return err
	}
	driver, err := filepath.EvalSymlinks(filepath.Join(device, "driver"))
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(driver, "unbind"), []byte(filepath.Base(device)), 0o200); err != nil {
		return fmt.Errorf("unbind: %w", err)
	}
	if _, err := os.Lstat(sys); !errors.Is(err, os.ErrNotExist) {
		return errors.New("config disk still present after unbind")
	}
	if _, err := os.Lstat(dev); err == nil {
		if err := os.Remove(dev); err != nil {
			return err
		}
	}
	return nil
}

func (m *Machine) Provider() string {
	return hostprofile.ProviderForDMI(func(field string) (string, error) {
		b, err := os.ReadFile(filepath.Join(m.Paths.DMIDir, field))
		return string(b), err
	})
}

func (m *Machine) UserData(ctx context.Context, provider string) ([]byte, error) {
	return m.Client.Fetch(ctx, provider)
}

// MetadataDrop applies hostprofile.MetadataDropRuleset, lists the table back, and confirms the
// metadata address no longer answers (as root, the strongest user).
func (m *Machine) MetadataDrop(ctx context.Context) error {
	if err := ApplyMetadataDrop(ctx, m.Paths.NftBin); err != nil {
		return err
	}
	d := net.Dialer{Timeout: time.Second}
	if c, err := d.DialContext(ctx, "tcp", "169.254.169.254:80"); err == nil {
		c.Close()
		return errors.New("metadata still reachable after the drop")
	}
	return nil
}

// ApplyMetadataDrop installs the table with nft, lists it back as JSON and checks it holds exactly
// the drop rules (hostprofile.VerifyMetadataDrop).
func ApplyMetadataDrop(ctx context.Context, nft string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, nft, "-f", "-")
	cmd.Stdin = strings.NewReader(hostprofile.MetadataDropRuleset())
	cmd.Env = guestEnv
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("nft -f: %w", err)
	}
	list := exec.CommandContext(ctx, nft, "-j", "list", "table", "inet", hostprofile.MetadataDropTable)
	list.Env = guestEnv
	out, err := list.Output()
	if err != nil {
		return fmt.Errorf("nft list: %w", err)
	}
	// The table must hold exactly the drop rules, not merely exist.
	return hostprofile.VerifyMetadataDrop(out)
}

// StartEntrypoint starts the entrypoint (`--config-fd 3`, only PATH in its environment, stdout and
// stderr on the console) with payload on a pipe; payload is at most bootenv.MaxConfig bytes, below
// a pipe's capacity, so the write never blocks.
func (m *Machine) StartEntrypoint(payload []byte) (int, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return 0, err
	}
	defer r.Close()
	if _, err := w.Write(payload); err != nil {
		w.Close()
		return 0, err
	}
	if err := w.Close(); err != nil {
		return 0, err
	}
	null, err := os.Open(os.DevNull)
	if err != nil {
		return 0, err
	}
	defer null.Close()
	p, err := os.StartProcess(entrypointBin, []string{entrypointBin, bootenv.ConfigFDArg, "3"}, &os.ProcAttr{
		Dir: "/", Env: guestEnv, Files: []*os.File{null, os.Stdout, os.Stderr, r},
	})
	if err != nil {
		return 0, err
	}
	pid := p.Pid
	_ = p.Release()
	return pid, nil
}

func (m *Machine) Wait(pid int) int {
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, unix.SIGTERM, unix.SIGINT)
	defer signal.Stop(sigs)
	go func() {
		for s := range sigs {
			if ss, ok := s.(syscall.Signal); ok {
				_ = unix.Kill(pid, ss)
			}
		}
	}()
	return Reap(pid)
}

// Reap waits for every child until pid exits and returns its exit code (128+n when a signal
// ended it). Orphans re-parented to this process are reaped on the way. -1 if pid can't be waited
// for at all.
func Reap(pid int) int {
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

// ReapRemaining reaps whatever is left until no child remains or d passes.
func ReapRemaining(d time.Duration) {
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

func (m *Machine) Shutdown(p Power) { shutdown(p) }

// shutdown kills every other process, reaps them, syncs and reboots or powers off. If the reboot
// call fails (not PID 1 of a guest) it exits 1.
func shutdown(p Power) {
	_ = unix.Kill(-1, unix.SIGKILL)
	ReapRemaining(2 * time.Second)
	unix.Sync()
	cmd := unix.LINUX_REBOOT_CMD_POWER_OFF
	if p == Restart {
		cmd = unix.LINUX_REBOOT_CMD_RESTART
	}
	_ = unix.Reboot(cmd)
	os.Exit(1)
}

// Nameservers reads /proc/net/pnp's `nameserver` lines, dropping link-local, loopback and
// unspecified addresses; none left is an error (the entrypoint needs a resolver it may reach).
func Nameservers(r io.Reader) ([]string, error) {
	sc := bufio.NewScanner(io.LimitReader(r, 64<<10))
	var out []string
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) != 2 || f[0] != "nameserver" {
			continue
		}
		ip := net.ParseIP(f[1])
		if ip == nil || ip.IsLinkLocalUnicast() || ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}
		out = append(out, ip.String())
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, errors.New("no usable resolver from the kernel")
	}
	return out, nil
}
