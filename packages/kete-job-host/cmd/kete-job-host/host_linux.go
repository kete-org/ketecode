package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/dedicated"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/firecracker"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostnet"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

func hostKernel() (string, error) {
	var u unix.Utsname
	if err := unix.Uname(&u); err != nil {
		return "", err
	}
	r := unix.ByteSliceToString(u.Release[:])
	if r == "" {
		return "", errors.New("uname: empty kernel release")
	}
	return r, nil
}

func kvmPresent() bool {
	fi, err := os.Stat("/dev/kvm")
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// newDriver builds the configured driver (no side effects; each driver's Init applies the host
// table when `run` starts).
func newDriver(cfg config.Config, log *slog.Logger) (driver.Driver, error) {
	store := &image.Store{Dir: filepath.Join(cfg.StateDir, "images"), Arch: runtime.GOARCH}
	prune := func() error {
		allow, err := image.NewAllowlist(cfg.ImageAllowlist)
		if err != nil {
			return err
		}
		if err := store.Prune(allow); err != nil {
			log.Warn("image_cache_prune_failed", "error", err.Error())
		}
		return nil
	}
	switch cfg.Driver {
	case contract.DriverFirecracker:
		if cfg.FC == nil {
			return nil, errors.New("the firecracker driver needs the configuration's firecracker section (kernel at least)")
		}
		if err := prune(); err != nil {
			return nil, err
		}
		return firecracker.New(firecracker.Options{Config: cfg, Images: store, Log: log})
	case contract.DriverDedicated:
		// ADR 0023 rule 8: config.Parse admits only a verified reset (provider_rebuild), and the
		// agent spends the generation at the job's start.
		if err := prune(); err != nil {
			return nil, err
		}
		return dedicated.New(dedicated.Options{Config: cfg, Images: store, Log: log})
	}
	return nil, fmt.Errorf("unknown driver %q", cfg.Driver)
}

// hidden runs the agent's internal subcommands: the dedicated driver's reaper, which the driver
// starts as PID 1 of a job's namespaces (never run it by hand).
func hidden(args []string) (int, bool) {
	if len(args) > 0 && args[0] == dedicated.InitArg {
		return dedicated.RunInit(), true
	}
	return 0, false
}

func versionOutput(bin string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(line), nil
}

// driverChecks are the drivers' doctor checks. Both: cgroup v2 controllers, IP forwarding, the
// tools the driver runs, the uplink, nftables and the host table, free disk space. Firecracker
// (P4): Firecracker and jailer versions, the guest kernel's digest. Dedicated (P5): loop devices,
// the reset and whether this generation already ran its job.
func driverChecks(cfg config.Config, check func(string, error), note func(string, string)) {
	switch {
	case cfg.Driver == contract.DriverFirecracker && cfg.FC != nil:
		firecrackerChecks(cfg, check)
		hostChecks(cfg, cfg.FC.Uplink, cfg.FC.GuestNetwork, cfg.FC.MinFreeGiB, check, note)
	case cfg.Driver == contract.DriverDedicated && cfg.Ded != nil:
		hostChecks(cfg, cfg.Ded.Uplink, cfg.Ded.GuestNetwork, cfg.Ded.MinFreeGiB, check, note)
		_, err := os.Stat("/dev/loop-control")
		check("loop devices", err)
		note("reset", "provider_rebuild: one job per generation; the platform rebuilds this server after it (ADR 0023 rule 8)")
		if st, err := state.Load(state.Path(cfg.StateDir)); err == nil && st.GenerationSpentBy != "" {
			note("generation", fmt.Sprintf("%s ran its job (machine %s): no further job until the platform rebuilds this server", st.Generation, st.GenerationSpentBy))
		}
	}
}

func firecrackerChecks(cfg config.Config, check func(string, error)) {
	fc := cfg.FC
	for _, bin := range []struct{ name, path, want string }{
		{"firecracker", fc.FirecrackerBin, "Firecracker v" + cfg.Firecracker},
		{"jailer", fc.JailerBin, "Jailer v" + cfg.Firecracker},
	} {
		got, err := versionOutput(bin.path)
		if err == nil && got != bin.want {
			err = fmt.Errorf("%s reports %q, the configuration says %q (versions.firecracker)", bin.path, got, bin.want)
		}
		check(bin.name, err)
	}
	sum, err := firecracker.FileSHA256(fc.Kernel)
	if err == nil && !slices.Contains(cfg.KernelAllowlist, sum) {
		err = fmt.Errorf("%s is %s, which is not in kernel_allowlist", fc.Kernel, sum)
	}
	check("guest kernel", err)
}

func hostChecks(cfg config.Config, uplink string, pool netip.Prefix, minFreeGiB int, check func(string, error), note func(string, string)) {
	b, err := os.ReadFile("/sys/fs/cgroup/cgroup.controllers")
	if err == nil {
		have := strings.Fields(string(b))
		for _, c := range []string{"cpu", "memory", "pids"} {
			if !slices.Contains(have, c) {
				err = fmt.Errorf("cgroup v2 controller %s is not available", c)
			}
		}
	}
	check("cgroup v2", err)
	on, err := hostnet.Forwarding()
	if err == nil && !on {
		err = errors.New("net.ipv4.ip_forward is 0 (packaging/install.sh sets it)")
	}
	check("ip forwarding", err)
	for _, tool := range []string{"mkfs.ext4", "ip"} {
		_, err := exec.LookPath(tool)
		check(tool, err)
	}
	if uplink == "" {
		uplink, err = hostnet.DefaultUplink()
	}
	check("uplink", err)
	nft := hostnet.Nft{}
	t := hostnet.Table{Uplink: uplink, Pool: pool, Resolvers: cfg.Resolvers}
	rs, err := t.Render()
	if err == nil {
		err = nft.CheckSyntax(context.Background(), rs)
	}
	check("nftables", err)
	if _, err := nft.Listing(context.Background()); errors.Is(err, hostnet.ErrMissing) {
		note("host table", "not applied (the agent applies it when it starts)")
	} else {
		check("host table", err)
	}
	var st unix.Statfs_t
	err = unix.Statfs(cfg.StateDir, &st)
	if err == nil {
		if free := int64(st.Bavail) * int64(st.Bsize); free < int64(minFreeGiB)<<30 {
			err = fmt.Errorf("%d GiB free in %s, min_free_gib is %d", free>>30, cfg.StateDir, minFreeGiB)
		}
	}
	check("disk space", err)
}
