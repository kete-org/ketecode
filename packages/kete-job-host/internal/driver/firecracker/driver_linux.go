//go:build linux

package firecracker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostnet"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
)

// Options configure the driver.
type Options struct {
	Config config.Config // with FC set
	Images *image.Store
	// Nft applies and checks the host table (default hostnet.Nft{}; tests pass a fake).
	Nft TableManager
	IP  hostnet.IP
	Log *slog.Logger
	// CgroupRoot is the cgroup v2 mount (default /sys/fs/cgroup).
	CgroupRoot string
	// Mkfs is mkfs.ext4 (default: from PATH).
	Mkfs string
	// CheckEvery is the host table and disk check period (default 30 s).
	CheckEvery time.Duration
}

// TableManager applies the host table and checks it against the listing Apply returned
// (hostnet.Nft).
type TableManager interface {
	Apply(ctx context.Context, t hostnet.Table) (string, error)
	Check(ctx context.Context, want string) error
}

// Driver is the firecracker driver.
type Driver struct {
	o        Options
	fc       config.Firecracker
	vmsDir   string
	jailBase string
	cgParent string
	execName string

	slotMu sync.Mutex // slot allocation (file I/O; never held with mu)

	mu        sync.Mutex // the cached health below (StartsBlocked runs under the agent's lock)
	uplink    string
	listing   string // the host table's listing right after applying it
	tableLost bool   // the table went missing or changed (sticky until restart)
	blocked   string
	kernel    string // sha256:<hex> of the kernel at Init
}

var _ driver.Driver = (*Driver)(nil)
var _ driver.Preparer = (*Driver)(nil)
var _ driver.Blocker = (*Driver)(nil)
var _ driver.IsolationGuard = (*Driver)(nil)

// New builds the driver (no side effects; Init applies the host table).
func New(o Options) (*Driver, error) {
	if o.Config.FC == nil {
		return nil, errors.New("firecracker: the configuration has no firecracker section")
	}
	if len(o.Config.Resolvers) == 0 {
		return nil, errors.New("firecracker: the configuration names no resolvers (guests need public DNS, ADR 0023 rule 7)")
	}
	if o.Images == nil {
		return nil, errors.New("firecracker: an image store is required")
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.CgroupRoot == "" {
		o.CgroupRoot = "/sys/fs/cgroup"
	}
	if o.CheckEvery <= 0 {
		o.CheckEvery = 30 * time.Second
	}
	if o.Nft == nil {
		o.Nft = hostnet.Nft{}
	}
	fc := *o.Config.FC
	return &Driver{
		o: o, fc: fc,
		vmsDir:   filepath.Join(o.Config.StateDir, "vms"),
		jailBase: filepath.Join(o.Config.StateDir, "jail"),
		cgParent: filepath.Join(o.CgroupRoot, ParentCgroup),
		execName: filepath.Base(fc.FirecrackerBin),
	}, nil
}

// Init prepares the host: directories, the VMs' parent cgroup, stray taps, the guest kernel's
// digest, and the host table (applied and checked). A table that can't be applied doesn't stop
// the agent: starts stay blocked (`host_table`) and the report says so (ADR 0023 rule 7). Then it
// checks the table and free disk space every CheckEvery until ctx ends.
func (d *Driver) Init(ctx context.Context) error {
	for _, dir := range []string{d.vmsDir, d.jailBase} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	if err := d.ensureCgroupParent(); err != nil {
		return err
	}
	if err := d.removeStrayTaps(ctx); err != nil {
		return err
	}
	if !forwardingOn() {
		d.setBlocked(contract.BlockedDriverUnhealthy)
		d.o.Log.Error("driver_unhealthy", "why", "net.ipv4.ip_forward is not 1 (packaging/install.sh sets it)")
	}
	uplink := d.fc.Uplink
	if uplink == "" {
		var err error
		if uplink, err = hostnet.DefaultUplink(); err != nil {
			return err
		}
	}
	d.mu.Lock()
	d.uplink = uplink
	d.mu.Unlock()
	if sum, err := fileSHA256(d.fc.Kernel); err == nil {
		d.mu.Lock()
		d.kernel = sum
		d.mu.Unlock()
	}
	listing, err := d.o.Nft.Apply(ctx, d.table())
	d.mu.Lock()
	if err != nil {
		d.blocked = contract.BlockedHostTable
		d.mu.Unlock()
		d.o.Log.Error("host_table_apply_failed", "error", err.Error())
	} else {
		d.listing = listing
		d.mu.Unlock()
		d.o.Log.Info("host_table_applied", "uplink", uplink)
	}
	d.check(ctx)
	go func() {
		t := time.NewTicker(d.o.CheckEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				d.check(ctx)
			}
		}
	}()
	return nil
}

func (d *Driver) table() hostnet.Table {
	return hostnet.Table{Uplink: d.uplink, Pool: d.fc.GuestNetwork, Resolvers: d.o.Config.Resolvers}
}

func (d *Driver) setBlocked(r string) {
	d.mu.Lock()
	d.blocked = r
	d.mu.Unlock()
}

// check refreshes the cached block from free disk space and IP forwarding; a lost host table
// (tableLost, sticky until the agent restarts and Init re-applies it) always wins.
func (d *Driver) check(ctx context.Context) {
	d.mu.Lock()
	lost := d.tableLost || d.listing == ""
	d.mu.Unlock()
	reason := ""
	switch {
	case lost:
		reason = contract.BlockedHostTable
	case !forwardingOn():
		reason = contract.BlockedDriverUnhealthy
	case freeBytes(d.o.Config.StateDir) < int64(d.fc.MinFreeGiB)<<30:
		reason = contract.BlockedDiskSpace
	}
	d.setBlocked(reason)
}

func forwardingOn() bool {
	ok, err := hostnet.Forwarding()
	return err == nil && ok
}

// ErrIsolationLost means the host table is missing or differs from what Init applied.
var ErrIsolationLost = errors.New("firecracker: host isolation lost")

// CheckIsolation implements driver.IsolationGuard: it compares the live host table with the
// listing taken when Init applied it. Missing or changed → the table is marked lost (starts
// blocked `host_table` until the agent restarts) and an error wrapping ErrIsolationLost is
// returned, upon which the agent destroys every machine.
func (d *Driver) CheckIsolation(ctx context.Context) error {
	d.mu.Lock()
	listing := d.listing
	d.mu.Unlock()
	err := ErrIsolationLost
	if listing != "" {
		if err = d.o.Nft.Check(ctx, listing); err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return err // our own timeout or shutdown, not evidence about the table
		}
		err = fmt.Errorf("%w: %w", ErrIsolationLost, err)
	}
	d.mu.Lock()
	first := !d.tableLost
	d.tableLost = true
	d.blocked = contract.BlockedHostTable
	d.mu.Unlock()
	if first {
		d.o.Log.Error("host_table_check_failed", "error", err.Error(), "action", "starts are blocked; restart the agent to re-apply the table")
	}
	return err
}

// StartsBlocked implements driver.Blocker (cached; no I/O).
func (d *Driver) StartsBlocked() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.blocked
}

// Prepare implements driver.Preparer: the image's root file system, fetched, verified and
// converted once per digest.
func (d *Driver) Prepare(ctx context.Context, ref string) error {
	_, err := d.o.Images.Rootfs(ctx, ref)
	return err
}

// ---------------------------------------------------------------- per-VM state

// vmState is the driver's record of one VM (no machine configuration, no token).
type vmState struct {
	MachineID     string    `json:"machine_id"`
	JobID         string    `json:"job_id"`
	Slot          int       `json:"slot"`
	UID           int       `json:"uid"`
	PID           int       `json:"pid,omitempty"`
	PIDStart      uint64    `json:"pid_start,omitempty"`
	Created       time.Time `json:"created"`
	ConsoleOffset int64     `json:"console_offset"`
}

func (d *Driver) vmDir(id string) string   { return filepath.Join(d.vmsDir, id) }
func (d *Driver) jailDir(id string) string { return filepath.Join(d.jailBase, d.execName, id) }
func (d *Driver) jailRoot(id string) string {
	return filepath.Join(d.jailDir(id), "root")
}
func (d *Driver) cgroup(id string) string { return filepath.Join(d.cgParent, id) }
func (d *Driver) consolePath(id string) string {
	return filepath.Join(d.vmDir(id), "console.log")
}

func (d *Driver) loadState(id string) (vmState, error) {
	b, err := os.ReadFile(filepath.Join(d.vmDir(id), "vm.json"))
	if err != nil {
		return vmState{}, err
	}
	var s vmState
	if err := json.Unmarshal(b, &s); err != nil {
		return vmState{}, err
	}
	if s.MachineID != id {
		return vmState{}, errors.New("firecracker: vm.json names another machine")
	}
	return s, nil
}

func (d *Driver) saveState(s vmState) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	dir := d.vmDir(s.MachineID)
	tmp := filepath.Join(dir, "vm.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "vm.json"))
}

// allocSlot reserves the lowest free slot for id by writing its vm.json.
func (d *Driver) allocSlot(spec driver.Spec) (vmState, error) {
	d.slotMu.Lock()
	defer d.slotMu.Unlock()
	used := map[int]bool{}
	ents, err := os.ReadDir(d.vmsDir)
	if err != nil {
		return vmState{}, err
	}
	for _, e := range ents {
		if s, err := d.loadState(e.Name()); err == nil {
			used[s.Slot] = true
		}
	}
	for n := 0; n < d.o.Config.Slots; n++ {
		if used[n] {
			continue
		}
		if err := os.Mkdir(d.vmDir(spec.MachineID), 0o700); err != nil {
			return vmState{}, err
		}
		s := vmState{MachineID: spec.MachineID, JobID: spec.JobID, Slot: n, UID: d.fc.UIDBase + n, Created: time.Now().UTC()}
		if err := d.saveState(s); err != nil {
			return vmState{}, err
		}
		return s, nil
	}
	return vmState{}, errors.New("firecracker: no free slot")
}

// ---------------------------------------------------------------- Start

// Start implements driver.Driver. On error the agent calls Stop, which removes whatever was made.
func (d *Driver) Start(ctx context.Context, spec driver.Spec) error {
	if !contract.ValidUUID(spec.MachineID) {
		return errors.New("firecracker: invalid machine id")
	}
	if b := d.StartsBlocked(); b != "" {
		return fmt.Errorf("firecracker: starts are blocked (%s)", b)
	}
	// ADR 0023 rule 7: the table is re-checked before each VM start.
	if err := d.CheckIsolation(ctx); err != nil {
		return err
	}
	r := spec.Resources
	if r.VCPUs < 1 || r.MemoryMiB < 128 || r.ScratchGiB < 1 {
		return errors.New("firecracker: invalid resources")
	}
	rootfs, err := d.o.Images.Rootfs(ctx, spec.Image)
	if err != nil {
		return err
	}
	st, err := d.allocSlot(spec)
	if err != nil {
		return err
	}
	slot, err := hostnet.SlotNet(d.fc.GuestNetwork, st.Slot)
	if err != nil {
		return err
	}
	m := machine{
		ID: spec.MachineID, UID: st.UID, ExecFile: d.fc.FirecrackerBin, ChrootBase: d.jailBase,
		VCPUs: r.VCPUs, MemoryMiB: r.MemoryMiB, OverheadMiB: d.fc.VMMOverheadMiB, ScratchGiB: r.ScratchGiB,
		Slot: slot, Resolvers: d.o.Config.Resolvers, NetMbps: d.fc.NetMbps, DiskMBps: d.fc.DiskMBps, DiskIOPS: d.fc.DiskIOPS,
	}
	root := d.jailRoot(spec.MachineID)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	// The jailed VMM must traverse its chroot's root, never list or write it.
	if err := os.Chmod(root, 0o711); err != nil {
		return err
	}
	if err := d.mountConfigFS(root, st.UID); err != nil {
		return err
	}
	if err := d.populateJail(ctx, root, rootfs, m, spec.Config); err != nil {
		return err
	}
	if err := d.o.IP.CreateTap(ctx, slot, st.UID, st.UID); err != nil {
		return err
	}
	if err := d.ensureCgroupParent(); err != nil {
		return err
	}
	pid, err := d.spawn(ctx, m)
	if err != nil {
		return err
	}
	st.PID = pid
	if st.PIDStart, err = procStart(pid); err != nil {
		return fmt.Errorf("firecracker: VMM start time: %w", err)
	}
	if err := d.saveState(st); err != nil {
		return err
	}
	// The config disk leaves the host as soon as Firecracker holds it open (ADR 0023 rule 13).
	if err := d.waitOpened(ctx, pid, filepath.Join(root, jailConfig)); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(root, jailConfig)); err != nil {
		return fmt.Errorf("firecracker: unlink config disk: %w", err)
	}
	if err := unmountConfigFS(root); err != nil {
		return err
	}
	d.o.Log.Info("vm_started", "machine_id", spec.MachineID, "slot", st.Slot, "pid", pid)
	return nil
}

// populateJail puts the kernel (checked against the allowlist), the root file system, a fresh
// scratch disk, the config disk, the log file and the VM configuration into the jail.
func (d *Driver) populateJail(ctx context.Context, root, rootfs string, m machine, cfg []byte) error {
	kernel := filepath.Join(root, jailKernel)
	if err := linkOrCopy(d.fc.Kernel, kernel); err != nil {
		return fmt.Errorf("firecracker: kernel: %w", err)
	}
	sum, err := fileSHA256(kernel)
	if err != nil {
		return err
	}
	if !slices.Contains(d.o.Config.KernelAllowlist, sum) {
		return fmt.Errorf("firecracker: the guest kernel %s is not in kernel_allowlist", sum)
	}
	if err := linkOrCopy(rootfs, filepath.Join(root, jailRootfs)); err != nil {
		return fmt.Errorf("firecracker: rootfs: %w", err)
	}
	if err := d.scratch(ctx, filepath.Join(root, jailScratch), m); err != nil {
		return err
	}
	disk, err := seal.ConfigDisk(cfg)
	if err != nil {
		return fmt.Errorf("firecracker: config disk: %w", err)
	}
	err = writeOwnedNoSync(filepath.Join(root, jailConfig), disk, m.UID, 0o600)
	clear(disk)
	if err != nil {
		return err
	}
	if err := writeOwned(filepath.Join(root, jailLog), nil, m.UID, 0o600); err != nil {
		return err
	}
	vmc, err := renderVMConfig(m)
	if err != nil {
		return err
	}
	return writeOwned(filepath.Join(root, jailVMJSON), vmc, m.UID, 0o400)
}

// mountConfigFS mounts a 64 KiB tmpfs at the jail's cfg directory, owned by the jail user, for the
// config disk: the claim token lives only in memory on the host, and is gone with the mount.
func (d *Driver) mountConfigFS(root string, uid int) error {
	dir := filepath.Join(root, jailConfigDir)
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	opts := fmt.Sprintf("size=64k,nr_inodes=16,mode=0700,uid=%d,gid=%d", uid, uid)
	if err := unix.Mount("tmpfs", dir, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, opts); err != nil {
		return fmt.Errorf("firecracker: mount the config tmpfs: %w", err)
	}
	return nil
}

// unmountConfigFS detaches the config tmpfs (a VMM holding the disk open keeps its copy).
func unmountConfigFS(root string) error {
	dir := filepath.Join(root, jailConfigDir)
	var st, parent unix.Stat_t
	if err := unix.Lstat(dir, &st); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil
		}
		return err
	}
	if err := unix.Lstat(root, &parent); err != nil {
		return err
	}
	if st.Dev == parent.Dev {
		return nil // not a mount point
	}
	err := unix.Unmount(dir, unix.MNT_DETACH)
	if err == nil || errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOENT) {
		return nil
	}
	return fmt.Errorf("firecracker: unmount the config tmpfs: %w", err)
}

// scratch creates the sparse per-job scratch disk, formatted ext4 with the label kete-job-init
// looks for (P1 handoff), owned by the jail user.
func (d *Driver) scratch(ctx context.Context, path string, m machine) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := f.Truncate(int64(m.ScratchGiB) << 30); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	mkfs := d.o.Mkfs
	if mkfs == "" {
		mkfs = "mkfs.ext4"
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, mkfs, "-q", "-F", "-t", "ext4", "-L", "kete-scratch", "-m", "0", "-O", "^has_journal",
		"-E", "root_owner=0:0,lazy_itable_init=1,nodiscard", path)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("firecracker: mkfs scratch: %v: %s", err, strings.TrimSpace(string(limit(out, 512))))
	}
	return os.Chown(path, m.UID, m.UID)
}

// spawn runs the jailer with the console file as stdout. With --new-pid-ns the jailer forks
// Firecracker into a new PID namespace, writes its PID into the jail and exits; Firecracker is
// then nobody's child here and lives in its own cgroup, so an agent restart doesn't touch it.
func (d *Driver) spawn(ctx context.Context, m machine) (int, error) {
	console, err := os.OpenFile(d.consolePath(m.ID), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return 0, err
	}
	defer console.Close()
	stderrPath := filepath.Join(d.vmDir(m.ID), "jailer.stderr")
	stderr, err := os.OpenFile(stderrPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	defer stderr.Close()
	null, err := os.Open(os.DevNull)
	if err != nil {
		return 0, err
	}
	defer null.Close()
	cmd := exec.Command(d.fc.JailerBin, jailerArgs(m)...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, console, stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("firecracker: jailer: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-done
		return 0, ctx.Err()
	}
	if err != nil {
		msg, _ := os.ReadFile(stderrPath)
		return 0, fmt.Errorf("firecracker: jailer: %v: %s", err, strings.TrimSpace(string(limit(msg, 512))))
	}
	pidFile := filepath.Join(d.jailRoot(m.ID), d.execName+".pid")
	var pid int
	for {
		if b, err := os.ReadFile(pidFile); err == nil {
			if pid, err = strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 1 {
				break
			}
		}
		if err := sleepCtx(ctx, 20*time.Millisecond); err != nil {
			return 0, fmt.Errorf("firecracker: no pid file: %w", err)
		}
	}
	if !d.inCgroup(pid, m.ID) {
		return 0, errors.New("firecracker: the VMM is not in its cgroup")
	}
	return pid, nil
}

// waitOpened waits until the process holds path open (Firecracker opens every drive before
// boot). The jailed VMM sees its files under its own root (pivot_root in a mount namespace), so
// its descriptors are matched by device and inode, not by name.
func (d *Driver) waitOpened(ctx context.Context, pid int, path string) error {
	var want unix.Stat_t
	if err := unix.Stat(path, &want); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	fdDir := filepath.Join("/proc", strconv.Itoa(pid), "fd")
	for {
		ents, err := os.ReadDir(fdDir)
		if err != nil {
			return fmt.Errorf("firecracker: the VMM exited during boot (%v)", err)
		}
		for _, e := range ents {
			var st unix.Stat_t
			if unix.Stat(filepath.Join(fdDir, e.Name()), &st) == nil && st.Dev == want.Dev && st.Ino == want.Ino {
				return nil
			}
		}
		if err := sleepCtx(ctx, 20*time.Millisecond); err != nil {
			return errors.New("firecracker: the VMM never opened the config disk")
		}
	}
}

// ---------------------------------------------------------------- Status, Stop, List, Logs

// Status implements driver.Driver.
func (d *Driver) Status(_ context.Context, id string) (driver.Status, error) {
	if !contract.ValidUUID(id) {
		return driver.StatusGone, nil
	}
	st, err := d.loadState(id)
	if errors.Is(err, fs.ErrNotExist) {
		if d.anyResidue(id) {
			return driver.StatusCrashed, nil
		}
		return driver.StatusGone, nil
	}
	if err != nil {
		return 0, err
	}
	if st.PID > 1 && d.alive(st) {
		return driver.StatusRunning, nil
	}
	if st.PID == 0 {
		return driver.StatusCrashed, nil
	}
	// A guest reboot (kete-job-init's end, or a panic with panic=1) makes Firecracker exit cleanly
	// and log it; anything else is a crash.
	if b, err := readTail(filepath.Join(d.jailRoot(id), jailLog), 64<<10); err == nil && bytes.Contains(b, []byte("Firecracker exiting successfully")) {
		return driver.StatusExited, nil
	}
	return driver.StatusCrashed, nil
}

func (d *Driver) alive(st vmState) bool {
	start, err := procStart(st.PID)
	return err == nil && start == st.PIDStart && d.inCgroup(st.PID, st.MachineID)
}

func (d *Driver) inCgroup(pid int, id string) bool {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(d.o.CgroupRoot, d.cgroup(id))
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(b)) == "0::/"+rel
}

func (d *Driver) anyResidue(id string) bool {
	for _, p := range []string{d.vmDir(id), d.jailDir(id), d.cgroup(id)} {
		if _, err := os.Lstat(p); err == nil {
			return true
		}
	}
	return false
}

// Stop implements driver.Driver: kill every process of the VM's cgroup, remove the cgroup, the
// tap, the jail (disks included) and the record. Idempotent; nil once nothing is left.
func (d *Driver) Stop(ctx context.Context, id string) error {
	if !contract.ValidUUID(id) {
		return errors.New("firecracker: invalid machine id")
	}
	st, stErr := d.loadState(id)
	if err := d.killCgroup(ctx, id); err != nil {
		return err
	}
	if stErr == nil && st.PID > 1 {
		if start, err := procStart(st.PID); err == nil && start == st.PIDStart {
			_ = unix.Kill(st.PID, unix.SIGKILL)
			if err := waitGone(ctx, st.PID, st.PIDStart); err != nil {
				return err
			}
		}
	}
	if stErr == nil {
		if slot, err := hostnet.SlotNet(d.fc.GuestNetwork, st.Slot); err == nil {
			if err := d.o.IP.DeleteTap(ctx, slot.Tap); err != nil {
				return err
			}
		}
	}
	if err := unmountConfigFS(d.jailRoot(id)); err != nil {
		return err
	}
	if err := os.RemoveAll(d.jailDir(id)); err != nil {
		return err
	}
	if err := os.RemoveAll(d.vmDir(id)); err != nil {
		return err
	}
	if d.anyResidue(id) {
		return errors.New("firecracker: VM residue remains after stop")
	}
	return nil
}

func (d *Driver) killCgroup(ctx context.Context, id string) error {
	cg := d.cgroup(id)
	if _, err := os.Lstat(cg); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	// cgroup.kill (Linux 5.14+) kills the whole group at once; without it, every listed pid is
	// killed on each round until the group is empty.
	killFile := os.WriteFile(filepath.Join(cg, "cgroup.kill"), []byte("1"), 0o200) == nil
	for {
		b, err := os.ReadFile(filepath.Join(cg, "cgroup.procs"))
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err == nil && len(bytes.TrimSpace(b)) == 0 {
			break
		}
		if err == nil && !killFile {
			for _, f := range strings.Fields(string(b)) {
				if pid, err := strconv.Atoi(f); err == nil && pid > 1 {
					_ = unix.Kill(pid, unix.SIGKILL)
				}
			}
		}
		if err := sleepCtx(ctx, 20*time.Millisecond); err != nil {
			return fmt.Errorf("firecracker: the VM's processes didn't exit: %w", err)
		}
	}
	for {
		err := unix.Rmdir(cg)
		if err == nil || errors.Is(err, unix.ENOENT) {
			return nil
		}
		if !errors.Is(err, unix.EBUSY) {
			return fmt.Errorf("firecracker: remove cgroup: %w", err)
		}
		if err := sleepCtx(ctx, 20*time.Millisecond); err != nil {
			return fmt.Errorf("firecracker: remove cgroup: %w", err)
		}
	}
}

// List implements driver.Driver: every machine with a record, a jail or a cgroup.
func (d *Driver) List(context.Context) ([]string, error) {
	seen := map[string]bool{}
	for _, dir := range []string{d.vmsDir, filepath.Join(d.jailBase, d.execName), d.cgParent} {
		ents, err := os.ReadDir(dir)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, e := range ents {
			if e.IsDir() && contract.ValidUUID(e.Name()) {
				seen[e.Name()] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	slices.Sort(out)
	return out, nil
}

const (
	logsPerCall    = 256 << 10
	consoleMax     = 8 << 20
	consoleLineMax = 4096
)

// Logs implements driver.Driver: the console's new complete lines (at most 256 KiB per call; the
// agent keeps only phase lines). A console that grew past 8 MiB is truncated once read.
func (d *Driver) Logs(_ context.Context, id string) ([][]byte, error) {
	if !contract.ValidUUID(id) {
		return nil, nil
	}
	st, err := d.loadState(id)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(d.consolePath(id), os.O_RDWR, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() < st.ConsoleOffset {
		st.ConsoleOffset = 0
	}
	buf := make([]byte, min(fi.Size()-st.ConsoleOffset, logsPerCall))
	n, err := f.ReadAt(buf, st.ConsoleOffset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	buf = buf[:n]
	var lines [][]byte
	consumed := 0
	for {
		i := bytes.IndexByte(buf[consumed:], '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimRight(buf[consumed:consumed+i], "\r")
		lines = append(lines, append([]byte(nil), line...))
		consumed += i + 1
	}
	// A partial line longer than any phase line is dropped rather than held forever.
	if consumed == 0 && len(buf) >= consoleLineMax {
		consumed = len(buf)
	}
	st.ConsoleOffset += int64(consumed)
	if st.ConsoleOffset >= consoleMax && st.ConsoleOffset == fi.Size() {
		if err := f.Truncate(0); err == nil {
			st.ConsoleOffset = 0
		}
	}
	if consumed > 0 {
		if err := d.saveState(st); err != nil {
			return nil, err
		}
	}
	return lines, nil
}

// ---------------------------------------------------------------- host helpers

func (d *Driver) ensureCgroupParent() error {
	if _, err := os.Stat(filepath.Join(d.o.CgroupRoot, "cgroup.controllers")); err != nil {
		return errors.New("firecracker: cgroup v2 is not mounted at " + d.o.CgroupRoot)
	}
	if err := os.Mkdir(d.cgParent, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	for _, f := range []string{filepath.Join(d.o.CgroupRoot, "cgroup.subtree_control"), filepath.Join(d.cgParent, "cgroup.subtree_control")} {
		if err := os.WriteFile(f, []byte("+cpu +memory +pids"), 0o644); err != nil {
			return fmt.Errorf("firecracker: enable cgroup controllers in %s: %w", f, err)
		}
	}
	return nil
}

func (d *Driver) removeStrayTaps(ctx context.Context) error {
	taps, err := hostnet.Taps()
	if err != nil {
		return err
	}
	owned := map[string]bool{}
	ents, _ := os.ReadDir(d.vmsDir)
	for _, e := range ents {
		if st, err := d.loadState(e.Name()); err == nil {
			if s, err := hostnet.SlotNet(d.fc.GuestNetwork, st.Slot); err == nil {
				owned[s.Tap] = true
			}
		}
	}
	for _, t := range taps {
		if !owned[t] {
			if err := d.o.IP.DeleteTap(ctx, t); err != nil {
				return err
			}
			d.o.Log.Warn("stray_tap_removed", "tap", t)
		}
	}
	return nil
}

// KernelDigest is the guest kernel's sha256 at Init ("" if unreadable).
func (d *Driver) KernelDigest() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.kernel
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

// FileSHA256 is the "sha256:<hex>" digest of a file (doctor).
func FileSHA256(path string) (string, error) { return fileSHA256(path) }

// linkOrCopy hard-links src to dst (same file system, the usual case), else copies it.
func linkOrCopy(src, dst string) error {
	if err := os.Link(src, dst); err == nil {
		return nil
	} else if !errors.Is(err, unix.EXDEV) {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o444)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// writeOwnedNoSync is writeOwned without fsync (the config disk, on its tmpfs).
func writeOwnedNoSync(path string, data []byte, uid int, mode os.FileMode) error {
	return writeFile(path, data, uid, mode, false)
}

func writeOwned(path string, data []byte, uid int, mode os.FileMode) error {
	return writeFile(path, data, uid, mode, true)
}

func writeFile(path string, data []byte, uid int, mode os.FileMode, sync bool) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chown(uid, uid); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if sync {
		if err := f.Sync(); err != nil {
			f.Close()
			return err
		}
	}
	return f.Close()
}

// procStart is /proc/<pid>/stat's starttime (field 22), the PID's identity against reuse.
func procStart(pid int) (uint64, error) {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, err
	}
	i := bytes.LastIndexByte(b, ')')
	if i < 0 {
		return 0, errors.New("stat")
	}
	f := strings.Fields(string(b[i+1:]))
	if len(f) < 20 {
		return 0, errors.New("stat")
	}
	if f[0] == "Z" || f[0] == "X" {
		return 0, errors.New("zombie")
	}
	return strconv.ParseUint(f[19], 10, 64)
}

func waitGone(ctx context.Context, pid int, start uint64) error {
	for {
		s, err := procStart(pid)
		if err != nil || s != start {
			return nil
		}
		if err := sleepCtx(ctx, 20*time.Millisecond); err != nil {
			return fmt.Errorf("firecracker: the VMM didn't exit: %w", err)
		}
	}
}

func freeBytes(dir string) int64 {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize)
}

func readTail(path string, n int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	off := max(0, fi.Size()-n)
	buf := make([]byte, fi.Size()-off)
	_, err = f.ReadAt(buf, off)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return buf, nil
}

func limit(b []byte, n int) []byte {
	if len(b) > n {
		return b[:n]
	}
	return b
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
