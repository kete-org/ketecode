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
)

// Images builds an image's verified read-only root file system (image.Store).
type Images interface {
	Rootfs(ctx context.Context, ref string) (string, error)
}

// TableManager applies the host table and checks it (hostnet.Nft).
type TableManager interface {
	Apply(ctx context.Context, t hostnet.Table) (string, error)
	Check(ctx context.Context, want string) error
}

// Options configure the driver.
type Options struct {
	Config config.Config // with Ded set
	Images Images
	Nft    TableManager // default hostnet.Nft{}
	IP     hostnet.IP
	Log    *slog.Logger
	// CgroupRoot is the cgroup v2 mount (default /sys/fs/cgroup).
	CgroupRoot string
	// Mkfs is mkfs.ext4 (default: from PATH).
	Mkfs string
	// Self is the executable started as the reaper with InitArg (default /proc/self/exe: the
	// agent's own binary). Tests pass their test binary.
	Self string
	// CheckEvery is the host table and disk check period (default 30 s).
	CheckEvery time.Duration
}

// Driver is the dedicated driver.
type Driver struct {
	o        Options
	ded      config.Dedicated
	dir      string // <state>/dedicated
	cgParent string

	startMu sync.Mutex // one machine at a time: allocation (file I/O; never held with mu)

	mu        sync.Mutex // cached health (StartsBlocked runs under the agent's lock)
	uplink    string
	listing   string
	tableLost bool
	blocked   string
}

var _ driver.Driver = (*Driver)(nil)
var _ driver.Preparer = (*Driver)(nil)
var _ driver.Blocker = (*Driver)(nil)
var _ driver.IsolationGuard = (*Driver)(nil)

// New builds the driver (no side effects; Init applies the host table).
func New(o Options) (*Driver, error) {
	if o.Config.Driver != contract.DriverDedicated || o.Config.Ded == nil {
		return nil, errors.New("dedicated: the configuration is not a dedicated host's")
	}
	if o.Config.Reset != contract.ResetProviderRebuild {
		// ADR 0023 rule 8; config.Parse already refuses anything else.
		return nil, errors.New("dedicated: refusing to run without a verified reset (provider_rebuild)")
	}
	if len(o.Config.Resolvers) == 0 {
		return nil, errors.New("dedicated: the configuration names no resolvers (the job needs public DNS, ADR 0023 rule 7)")
	}
	if strings.ContainsAny(o.Config.StateDir, ",:") {
		// The overlay's mount options are built from paths under it.
		return nil, errors.New("dedicated: state_dir must not contain ',' or ':'")
	}
	if o.Images == nil {
		return nil, errors.New("dedicated: an image store is required")
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
	if o.Self == "" {
		o.Self = "/proc/self/exe"
	}
	return &Driver{
		o: o, ded: *o.Config.Ded,
		dir:      filepath.Join(o.Config.StateDir, "dedicated"),
		cgParent: filepath.Join(o.CgroupRoot, ParentCgroup),
	}, nil
}

// Init prepares the host: the machines directory, the parent cgroup, stray veths, IP forwarding
// and the host table (applied and checked). A table that can't be applied blocks starts
// (`host_table`) rather than stopping the agent. Then it re-checks the table's health and free
// disk space every CheckEvery until ctx ends.
func (d *Driver) Init(ctx context.Context) error {
	if err := os.MkdirAll(d.dir, 0o700); err != nil {
		return err
	}
	if err := d.ensureCgroupParent(); err != nil {
		return err
	}
	if err := d.removeStrayVeths(ctx); err != nil {
		return err
	}
	if !forwardingOn() {
		d.o.Log.Error("driver_unhealthy", "why", "net.ipv4.ip_forward is not 1 (packaging/install.sh sets it)")
	}
	uplink := d.ded.Uplink
	if uplink == "" {
		var err error
		if uplink, err = hostnet.DefaultUplink(); err != nil {
			return err
		}
	}
	d.mu.Lock()
	d.uplink = uplink
	d.mu.Unlock()
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
	d.check()
	go func() {
		t := time.NewTicker(d.o.CheckEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				d.check()
			}
		}
	}()
	return nil
}

func (d *Driver) table() hostnet.Table {
	return hostnet.Table{Uplink: d.uplink, Pool: d.ded.GuestNetwork, Resolvers: d.o.Config.Resolvers}
}

func (d *Driver) check() {
	d.mu.Lock()
	lost := d.tableLost || d.listing == ""
	d.mu.Unlock()
	reason := ""
	switch {
	case lost:
		reason = contract.BlockedHostTable
	case !forwardingOn():
		reason = contract.BlockedDriverUnhealthy
	case freeBytes(d.o.Config.StateDir) < int64(d.ded.MinFreeGiB)<<30:
		reason = contract.BlockedDiskSpace
	}
	d.mu.Lock()
	d.blocked = reason
	d.mu.Unlock()
}

// ErrIsolationLost means the host table is missing or differs from what Init applied.
var ErrIsolationLost = errors.New("dedicated: host isolation lost")

// CheckIsolation implements driver.IsolationGuard (as the firecracker driver's): a missing or
// changed host table marks it lost (starts blocked until the agent restarts) and returns an
// error, upon which the agent destroys the job.
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
			return err
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

// Prepare implements driver.Preparer: the image's verified read-only root file system.
func (d *Driver) Prepare(ctx context.Context, ref string) error {
	_, err := d.o.Images.Rootfs(ctx, ref)
	return err
}

// ---------------------------------------------------------------- per-machine state

// record is the driver's file for one machine (no configuration, no token).
type record struct {
	MachineID     string    `json:"machine_id"`
	JobID         string    `json:"job_id"`
	PID           int       `json:"pid,omitempty"`
	PIDStart      uint64    `json:"pid_start,omitempty"`
	Created       time.Time `json:"created"`
	ConsoleOffset int64     `json:"console_offset"`
}

func (d *Driver) mdir(id string) string        { return filepath.Join(d.dir, id) }
func (d *Driver) cgroup(id string) string      { return filepath.Join(d.cgParent, id) }
func (d *Driver) at(id, name string) string    { return filepath.Join(d.mdir(id), name) }
func (d *Driver) consolePath(id string) string { return d.at(id, "console.log") }

// The machine directory's mount points, innermost first (the order they are unmounted in).
var mountDirs = []string{"root", "scratch", "lower"}

func (d *Driver) load(id string) (record, error) {
	b, err := os.ReadFile(d.at(id, "job.json"))
	if err != nil {
		return record{}, err
	}
	var r record
	if err := json.Unmarshal(b, &r); err != nil {
		return record{}, err
	}
	if r.MachineID != id {
		return record{}, errors.New("dedicated: job.json names another machine")
	}
	return r, nil
}

func (d *Driver) save(r record) error {
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	tmp := d.at(r.MachineID, "job.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.at(r.MachineID, "job.json"))
}

// allocate creates the machine's directory, refusing while any other machine exists (one job
// at a time on a dedicated host).
func (d *Driver) allocate(spec driver.Spec) (record, error) {
	d.startMu.Lock()
	defer d.startMu.Unlock()
	held, err := d.List(context.Background())
	if err != nil {
		return record{}, err
	}
	if len(held) > 0 {
		return record{}, fmt.Errorf("dedicated: machine %s is still held; one job at a time", held[0])
	}
	if err := os.Mkdir(d.mdir(spec.MachineID), 0o700); err != nil {
		return record{}, err
	}
	r := record{MachineID: spec.MachineID, JobID: spec.JobID, Created: time.Now().UTC()}
	return r, d.save(r)
}

// ---------------------------------------------------------------- Start

// Start implements driver.Driver. On error the agent calls Stop, which removes whatever was made.
func (d *Driver) Start(ctx context.Context, spec driver.Spec) error {
	if !contract.ValidUUID(spec.MachineID) {
		return errors.New("dedicated: invalid machine id")
	}
	if b := d.StartsBlocked(); b != "" {
		return fmt.Errorf("dedicated: starts are blocked (%s)", b)
	}
	// ADR 0023 rule 7 (and rule 8's veth): the table is re-checked before the start.
	if err := d.CheckIsolation(ctx); err != nil {
		return err
	}
	limits, err := CgroupLimits(spec.Resources, d.ded.PidsMax)
	if err != nil {
		return err
	}
	if len(spec.Config) == 0 || len(spec.Config) > 8192 {
		return errors.New("dedicated: the machine configuration is missing or too large")
	}
	rootfs, err := d.o.Images.Rootfs(ctx, spec.Image)
	if err != nil {
		return err
	}
	rec, err := d.allocate(spec)
	if err != nil {
		return err
	}
	slot, err := hostnet.SlotNet(d.ded.GuestNetwork, 0)
	if err != nil {
		return err
	}
	root, err := d.buildRoot(ctx, spec, rootfs)
	if err != nil {
		return err
	}
	if err := d.ensureCgroupParent(); err != nil {
		return err
	}
	cg := d.cgroup(spec.MachineID)
	if err := os.Mkdir(cg, 0o755); err != nil {
		return fmt.Errorf("dedicated: machine cgroup: %w", err)
	}
	for _, f := range limits {
		if err := os.WriteFile(filepath.Join(cg, f.Name), []byte(f.Value), 0o644); err != nil {
			return fmt.Errorf("dedicated: cgroup %s: %w", f.Name, err)
		}
	}
	l, err := d.launch(spec, cg)
	if err != nil {
		return err
	}
	defer l.close()
	rec.PID = l.pid
	if rec.PIDStart, err = procStart(l.pid); err != nil {
		return fmt.Errorf("dedicated: reaper start time: %w", err)
	}
	if err := d.save(rec); err != nil {
		return err
	}
	if err := d.o.IP.CreateVeth(ctx, slot, l.pid); err != nil {
		return err
	}
	resolvers := make([]string, len(d.o.Config.Resolvers))
	for i, r := range d.o.Config.Resolvers {
		resolvers[i] = r.String()
	}
	is := InitSpec{Root: root, IPBin: d.o.IP.Path(), Address: slot.Guest.String() + "/30", Gateway: slot.Gateway.String(), Resolvers: resolvers}
	if err := is.Validate(); err != nil {
		return err
	}
	line, _ := json.Marshal(is)
	if _, err := l.control.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("dedicated: the reaper's control pipe: %w", err)
	}
	l.control.Close()
	l.control = nil
	if err := l.awaitReady(ctx); err != nil {
		return err
	}
	d.o.Log.Info("job_started", "machine_id", spec.MachineID, "pid", l.pid)
	return nil
}

// buildRoot loop-mounts the image's root file system read-only at lower/, a fresh sparse ext4
// scratch file (resources.scratch_gib) at scratch/, and their overlay at root/.
func (d *Driver) buildRoot(ctx context.Context, spec driver.Spec, rootfs string) (string, error) {
	id := spec.MachineID
	for _, n := range mountDirs {
		if err := os.Mkdir(d.at(id, n), 0o700); err != nil {
			return "", err
		}
	}
	// The job's / is the overlay's root directory: it must be traversable by the job's users.
	if err := os.Chmod(d.at(id, "root"), 0o755); err != nil {
		return "", err
	}
	if err := mountLoop(rootfs, d.at(id, "lower"), true, unix.MS_NOSUID|unix.MS_NODEV); err != nil {
		return "", err
	}
	scratch := d.at(id, "scratch.img")
	if err := d.mkScratch(ctx, scratch, spec.Resources.ScratchGiB); err != nil {
		return "", err
	}
	if err := mountLoop(scratch, d.at(id, "scratch"), false, unix.MS_NOSUID|unix.MS_NODEV); err != nil {
		return "", err
	}
	upper, work := d.at(id, "scratch/upper"), d.at(id, "scratch/work")
	for _, p := range []string{upper, work} {
		if err := os.Mkdir(p, 0o755); err != nil {
			return "", err
		}
	}
	if err := os.Chmod(upper, 0o755); err != nil { // the umask applied to Mkdir
		return "", err
	}
	opts := "lowerdir=" + d.at(id, "lower") + ",upperdir=" + upper + ",workdir=" + work
	if err := unix.Mount("overlay", d.at(id, "root"), "overlay", unix.MS_NOSUID|unix.MS_NODEV, opts); err != nil {
		return "", fmt.Errorf("dedicated: mount the overlay root: %w", err)
	}
	return d.at(id, "root"), nil
}

// mkScratch creates the sparse scratch file and formats it.
func (d *Driver) mkScratch(ctx context.Context, path string, gib int) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if err := f.Truncate(int64(gib) << 30); err != nil {
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
	cmd := exec.CommandContext(ctx, mkfs, "-q", "-F", "-t", "ext4", "-L", ScratchLabel, "-m", "0", "-O", "^has_journal",
		"-E", "root_owner=0:0,lazy_itable_init=1,nodiscard", path)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("dedicated: mkfs scratch: %v: %s", err, strings.TrimSpace(string(limit(out, 512))))
	}
	return nil
}

// launched is a started reaper and the agent's ends of its pipes.
type launched struct {
	pid     int
	control *os.File
	report  *os.File
}

func (l *launched) close() {
	if l.control != nil {
		l.control.Close()
	}
	l.report.Close()
}

// awaitReady waits for the reaper's verdict: "ok" once the entrypoint runs.
func (l *launched) awaitReady(ctx context.Context) error {
	type res struct {
		line string
		err  error
	}
	ch := make(chan res, 1)
	go func() {
		s, err := bufio.NewReader(io.LimitReader(l.report, 4096)).ReadString('\n')
		ch <- res{strings.TrimSpace(s), err}
	}()
	select {
	case r := <-ch:
		switch {
		case r.line == "ok":
			return nil
		case strings.HasPrefix(r.line, "error: "):
			return fmt.Errorf("dedicated: the reaper failed: %s", strings.TrimPrefix(r.line, "error: "))
		case r.err != nil:
			return fmt.Errorf("dedicated: the reaper exited before the job started (%v)", r.err)
		}
		return fmt.Errorf("dedicated: unexpected reaper report %q", r.line)
	case <-ctx.Done():
		l.report.Close() // unblocks the reader
		return fmt.Errorf("dedicated: the reaper never reported: %w", ctx.Err())
	}
}

// launch starts the reaper: PID 1 of new mount, PID, network, IPC and UTS namespaces, cloned
// straight into the machine's cgroup (CLONE_INTO_CGROUP), in its own session, with the
// configuration on a pipe (written here and closed: it waits in the kernel's pipe buffer until
// the entrypoint reads it, never on disk). The reaper is this process's child until the agent
// exits; a goroutine reaps it, and afterwards init does.
func (d *Driver) launch(spec driver.Spec, cg string) (*launched, error) {
	id := spec.MachineID
	cfgR, cfgW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer cfgR.Close()
	_, err = cfgW.Write(spec.Config) // at most 8 KiB: below any pipe's capacity, never blocks
	if cerr := cfgW.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	ctlR, ctlW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer ctlR.Close()
	repR, repW, err := os.Pipe()
	if err != nil {
		ctlW.Close()
		return nil, err
	}
	defer repW.Close()
	l := &launched{control: ctlW, report: repR}
	fail := func(err error) (*launched, error) {
		l.close()
		return nil, err
	}
	exitF, err := os.OpenFile(d.at(id, "exit"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return fail(err)
	}
	defer exitF.Close()
	console, err := os.OpenFile(d.consolePath(id), os.O_WRONLY|os.O_CREATE|os.O_APPEND|unix.O_NOFOLLOW, 0o600)
	if err != nil {
		return fail(err)
	}
	defer console.Close()
	null, err := os.Open(os.DevNull)
	if err != nil {
		return fail(err)
	}
	defer null.Close()
	cgf, err := os.OpenFile(cg, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail(err)
	}
	defer cgf.Close()
	cmd := exec.Command(d.o.Self, InitArg)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, console, console
	cmd.ExtraFiles = []*os.File{cfgR, ctlR, repW, exitF} // fds 3, 4, 5, 6
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:      true,
		Cloneflags:  unix.CLONE_NEWNS | unix.CLONE_NEWPID | unix.CLONE_NEWNET | unix.CLONE_NEWIPC | unix.CLONE_NEWUTS,
		UseCgroupFD: true,
		CgroupFD:    int(cgf.Fd()),
	}
	if err := cmd.Start(); err != nil {
		return fail(fmt.Errorf("dedicated: start the reaper: %w", err))
	}
	l.pid = cmd.Process.Pid
	go func() { _ = cmd.Wait() }()
	if !d.inCgroup(l.pid, id) {
		_ = cmd.Process.Kill()
		return fail(errors.New("dedicated: the reaper is not in its cgroup"))
	}
	return l, nil
}

// ---------------------------------------------------------------- Status, Stop, List, Logs

// Status implements driver.Driver.
func (d *Driver) Status(_ context.Context, id string) (driver.Status, error) {
	if !contract.ValidUUID(id) {
		return driver.StatusGone, nil
	}
	r, err := d.load(id)
	if errors.Is(err, fs.ErrNotExist) {
		if d.anyResidue(id) {
			return driver.StatusCrashed, nil
		}
		return driver.StatusGone, nil
	}
	if err != nil {
		return 0, err
	}
	if r.PID > 1 && d.alive(r) {
		return driver.StatusRunning, nil
	}
	if r.PID == 0 {
		return driver.StatusCrashed, nil
	}
	// The reaper writes "exited <code>" once the entrypoint has ended (the job ended, whatever
	// its code); a reaper that died without it crashed (or was killed).
	if b, err := os.ReadFile(d.at(id, "exit")); err == nil && bytes.HasPrefix(b, []byte("exited ")) {
		return driver.StatusExited, nil
	}
	return driver.StatusCrashed, nil
}

func (d *Driver) alive(r record) bool {
	start, err := procStart(r.PID)
	return err == nil && start == r.PIDStart && d.inCgroup(r.PID, r.MachineID)
}

// inCgroup reports pid in the machine's cgroup or below it (the entrypoint moves the reaper into
// a leaf of its own cgroup tree).
func (d *Driver) inCgroup(pid int, id string) bool {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(d.o.CgroupRoot, d.cgroup(id))
	if err != nil {
		return false
	}
	got := strings.TrimSpace(string(b))
	want := "0::/" + rel
	return got == want || strings.HasPrefix(got, want+"/")
}

func (d *Driver) anyResidue(id string) bool {
	for _, p := range []string{d.mdir(id), d.cgroup(id)} {
		if _, err := os.Lstat(p); err == nil {
			return true
		}
	}
	return false
}

// Stop implements driver.Driver: kill every process of the machine's cgroup tree, remove the
// tree, the veth, the mounts (overlay, scratch, image) and the machine directory (scratch file
// included). Idempotent; nil once nothing is left.
func (d *Driver) Stop(ctx context.Context, id string) error {
	if !contract.ValidUUID(id) {
		return errors.New("dedicated: invalid machine id")
	}
	r, rErr := d.load(id)
	residue := d.anyResidue(id)
	if err := d.killCgroup(ctx, id); err != nil {
		return err
	}
	if rErr == nil && r.PID > 1 {
		if start, err := procStart(r.PID); err == nil && start == r.PIDStart {
			_ = unix.Kill(r.PID, unix.SIGKILL)
			if err := waitGone(ctx, r.PID, r.PIDStart); err != nil {
				return err
			}
		}
	}
	if residue {
		// The veth goes with the job's network namespace; a leftover host side is removed.
		if slot, err := hostnet.SlotNet(d.ded.GuestNetwork, 0); err == nil {
			if err := d.o.IP.DeleteTap(ctx, slot.Tap); err != nil {
				return err
			}
		}
	}
	for _, n := range mountDirs {
		if err := unmount(d.at(id, n)); err != nil {
			return err
		}
	}
	for _, n := range mountDirs {
		mp, err := isMountPoint(d.at(id, n))
		if err != nil {
			return err
		}
		if mp {
			// Never delete through a mount: that would remove the image's or the job's files.
			return fmt.Errorf("dedicated: %s is still mounted", d.at(id, n))
		}
	}
	if err := os.RemoveAll(d.mdir(id)); err != nil {
		return err
	}
	if d.anyResidue(id) {
		return errors.New("dedicated: machine residue remains after stop")
	}
	return nil
}

// killCgroup kills the machine's whole cgroup tree (cgroup.kill is recursive), waits until it is
// empty and removes it bottom-up (the entrypoint makes sub-cgroups inside its namespace).
func (d *Driver) killCgroup(ctx context.Context, id string) error {
	cg := d.cgroup(id)
	if _, err := os.Lstat(cg); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	killFile := os.WriteFile(filepath.Join(cg, "cgroup.kill"), []byte("1"), 0o200) == nil
	for {
		b, err := os.ReadFile(filepath.Join(cg, "cgroup.events"))
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err == nil && bytes.Contains(b, []byte("populated 0")) {
			break
		}
		if !killFile {
			_ = filepath.WalkDir(cg, func(p string, e fs.DirEntry, err error) error {
				if err == nil && e.IsDir() {
					if b, err := os.ReadFile(filepath.Join(p, "cgroup.procs")); err == nil {
						for _, f := range strings.Fields(string(b)) {
							if pid, err := strconv.Atoi(f); err == nil && pid > 1 {
								_ = unix.Kill(pid, unix.SIGKILL)
							}
						}
					}
				}
				return nil
			})
		}
		if err := sleepCtx(ctx, 20*time.Millisecond); err != nil {
			return fmt.Errorf("dedicated: the job's processes didn't exit: %w", err)
		}
	}
	var dirs []string
	if err := filepath.WalkDir(cg, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	}); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	slices.Reverse(dirs) // children before parents
	for _, p := range dirs {
		for {
			err := unix.Rmdir(p)
			if err == nil || errors.Is(err, unix.ENOENT) {
				break
			}
			if !errors.Is(err, unix.EBUSY) {
				return fmt.Errorf("dedicated: remove cgroup %s: %w", p, err)
			}
			if err := sleepCtx(ctx, 20*time.Millisecond); err != nil {
				return fmt.Errorf("dedicated: remove cgroup %s: %w", p, err)
			}
		}
	}
	return nil
}

// List implements driver.Driver: every machine with a directory or a cgroup.
func (d *Driver) List(context.Context) ([]string, error) {
	seen := map[string]bool{}
	for _, dir := range []string{d.dir, d.cgParent} {
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
	r, err := d.load(id)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(d.consolePath(id), os.O_RDWR|unix.O_NOFOLLOW, 0)
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
	if fi.Size() < r.ConsoleOffset {
		r.ConsoleOffset = 0
	}
	buf := make([]byte, min(fi.Size()-r.ConsoleOffset, logsPerCall))
	n, err := f.ReadAt(buf, r.ConsoleOffset)
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
		lines = append(lines, append([]byte(nil), bytes.TrimRight(buf[consumed:consumed+i], "\r")...))
		consumed += i + 1
	}
	if consumed == 0 && len(buf) >= consoleLineMax {
		consumed = len(buf)
	}
	r.ConsoleOffset += int64(consumed)
	if r.ConsoleOffset >= consoleMax && r.ConsoleOffset == fi.Size() {
		if err := f.Truncate(0); err == nil {
			r.ConsoleOffset = 0
		}
	}
	if consumed > 0 {
		if err := d.save(r); err != nil {
			return nil, err
		}
	}
	return lines, nil
}

// ---------------------------------------------------------------- host helpers

func (d *Driver) ensureCgroupParent() error {
	if _, err := os.Stat(filepath.Join(d.o.CgroupRoot, "cgroup.controllers")); err != nil {
		return errors.New("dedicated: cgroup v2 is not mounted at " + d.o.CgroupRoot)
	}
	if err := os.Mkdir(d.cgParent, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	for _, f := range []string{filepath.Join(d.o.CgroupRoot, "cgroup.subtree_control"), filepath.Join(d.cgParent, "cgroup.subtree_control")} {
		if err := os.WriteFile(f, []byte("+cpu +memory +pids"), 0o644); err != nil {
			return fmt.Errorf("dedicated: enable cgroup controllers in %s: %w", f, err)
		}
	}
	return nil
}

// removeStrayVeths deletes kjh* devices when no machine is held (a host side left by a crash).
func (d *Driver) removeStrayVeths(ctx context.Context) error {
	held, err := d.List(ctx)
	if err != nil || len(held) > 0 {
		return err
	}
	taps, err := hostnet.Taps()
	if err != nil {
		return err
	}
	for _, t := range taps {
		if err := d.o.IP.DeleteTap(ctx, t); err != nil {
			return err
		}
		d.o.Log.Warn("stray_veth_removed", "device", t)
	}
	return nil
}

func forwardingOn() bool {
	ok, err := hostnet.Forwarding()
	return err == nil && ok
}

func freeBytes(dir string) int64 {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize)
}

// procStart is /proc/<pid>/stat's starttime (field 22), the PID's identity against reuse; a
// zombie counts as gone.
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
			return fmt.Errorf("dedicated: the reaper didn't exit: %w", err)
		}
	}
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
