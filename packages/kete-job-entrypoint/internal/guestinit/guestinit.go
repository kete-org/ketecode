// Package guestinit is kete-job-init (module README "kete-job-init"; kete-code-platform ADR 0023
// rules 13-15): PID 1 of a microvm (the host agent's firecracker driver) or cloudvm (a provider VM
// per job) guest. It mounts the guest's file systems, checks the network the kernel configured
// from its `ip=` argument (microvm) or configures it with its own DHCP client (cloudvm,
// internal/dhcp), reads the job's configuration once as root (microvm: the read-only
// config disk, then removes the device; cloudvm: the provider's user data, then drops the metadata
// service for every user), starts the entrypoint with the values on a pipe, reaps orphans, and
// powers the machine off when the entrypoint exits. It writes only phase lines to the console.
// No systemd, SSH server, cloud-init or provider guest agent runs in the guest.
//
// This file is the orchestration (Run) over a Deps interface, so it is tested with fakes; the
// configuration parsers are pure (config.go, userdata.go); init_linux.go is the real machine.
package guestinit

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
	pl "github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

// Power is how the guest ends.
type Power int

const (
	// PowerOff powers the machine off (cloudvm: the provider VM stops; also every failure before
	// the mode is known, so a cloud VM never boot-loops).
	PowerOff Power = iota
	// Restart is a guest reboot, which Firecracker treats as the VM exiting (it virtualizes no
	// power-off on x86_64): microvm.
	Restart
)

// Mode is the guest's kind, decided by the configuration found.
type Mode string

const (
	ModeMicroVM Mode = "microvm"
	ModeCloudVM Mode = "cloudvm"
)

// Deps are the machine operations Run orders.
type Deps interface {
	// Mounts finishes the guest's file systems (cgroup2, /run, /dev/shm).
	Mounts() error
	// Network brings loopback up, configures the uplink by DHCP when the command line says so
	// (cloudvm), waits for the interface and default route, and writes /etc/resolv.conf from the
	// command line's or the kernel's resolvers.
	Network(ctx context.Context) error
	// FindConfigDisk returns the config disk's device, or "" when there is none.
	FindConfigDisk() (string, error)
	// ReadConfigDisk reads and validates the config disk (ParseConfigDisk).
	ReadConfigDisk(dev string) (bootenv.Config, error)
	// RemoveConfigDisk detaches the device from the guest and confirms it's gone.
	RemoveConfigDisk(dev string) error
	// Provider names the cloud provider from the firmware (hostprofile.ProviderForDMI), or "".
	Provider() string
	// UserData fetches the provider's user data once.
	UserData(ctx context.Context, provider string) ([]byte, error)
	// MetadataDrop installs and confirms hostprofile.MetadataDropRuleset.
	MetadataDrop(ctx context.Context) error
	// StartEntrypoint starts the entrypoint with payload on its config pipe (--config-fd 3).
	StartEntrypoint(payload []byte) (pid int, err error)
	// Wait reaps children until pid exits (forwarding SIGTERM/SIGINT to it) and returns its exit
	// code (128+n for a signal).
	Wait(pid int) int
	// Shutdown kills every remaining process, reaps, syncs and ends the machine as p says.
	Shutdown(p Power)
}

// Run is stage 2 of kete-job-init: it never starts the entrypoint unless every step before it
// succeeded, and it always ends in Shutdown (Restart only for a microvm whose mode is known). It
// returns the power action taken (for tests; on a real machine Shutdown doesn't return).
func Run(ctx context.Context, d Deps, log *pl.Logger) (taken Power) {
	power := PowerOff
	// A panic anywhere in the steps (a Deps call included) powers off: never a live machine without
	// a working PID 1, never the entrypoint after a step that didn't finish.
	defer func() {
		if r := recover(); r != nil {
			log.Fail(pl.StepInitPower, pl.CodeFailed)
			d.Shutdown(PowerOff)
			taken = PowerOff
		}
	}()
	step := func(s pl.Step, fn func() error) bool {
		log.Start(s)
		if err := fn(); err != nil {
			var code pl.Code = pl.CodeFailed
			var ce *codeError
			if errors.As(err, &ce) {
				code = ce.code
			}
			log.FailErr(s, code, err)
			return false
		}
		log.OK(s)
		return true
	}
	end := func(p Power) Power {
		log.Start(pl.StepInitPower)
		d.Shutdown(p)
		return p
	}
	if !step(pl.StepInitMount, d.Mounts) {
		return end(power)
	}
	if !step(pl.StepInitNet, func() error { return d.Network(ctx) }) {
		return end(power)
	}
	var cfg bootenv.Config
	var mode Mode
	if !step(pl.StepInitConfig, func() error {
		var err error
		cfg, mode, err = readConfig(ctx, d)
		return err
	}) {
		return end(power)
	}
	if mode == ModeMicroVM {
		power = Restart
	}
	if mode == ModeCloudVM && !step(pl.StepInitMetadata, func() error { return d.MetadataDrop(ctx) }) {
		return end(power)
	}
	payload, err := json.Marshal(cfg)
	cfg = bootenv.Config{}
	if err != nil {
		log.FailErr(pl.StepInitStart, pl.CodeFailed, err)
		return end(power)
	}
	log.Start(pl.StepInitStart)
	pid, err := d.StartEntrypoint(payload)
	clear(payload)
	if err != nil {
		log.FailErr(pl.StepInitStart, pl.CodeFailed, err)
		return end(power)
	}
	log.Exited(pl.StepInitStart, d.Wait(pid))
	return end(power)
}

// readConfig finds the configuration: a config disk makes the guest a microvm (the disk is
// removed once read); without one it is a cloudvm, whose firmware must name a known provider
// and whose user data must say cloudvm and that provider.
func readConfig(ctx context.Context, d Deps) (bootenv.Config, Mode, error) {
	dev, err := d.FindConfigDisk()
	if err != nil {
		return bootenv.Config{}, "", err
	}
	if dev != "" {
		cfg, err := d.ReadConfigDisk(dev)
		if err != nil {
			return bootenv.Config{}, "", &codeError{code: pl.CodeInvalid, err: err}
		}
		if err := d.RemoveConfigDisk(dev); err != nil {
			return bootenv.Config{}, "", err
		}
		return cfg, ModeMicroVM, nil
	}
	provider := d.Provider()
	if provider == "" {
		return bootenv.Config{}, "", &codeError{code: pl.CodeMissing, err: errors.New("no config disk and no known provider")}
	}
	raw, err := d.UserData(ctx, provider)
	if err != nil {
		return bootenv.Config{}, "", err
	}
	defer clear(raw)
	cfg, err := ParseUserData(raw, provider)
	if err != nil {
		return bootenv.Config{}, "", &codeError{code: pl.CodeInvalid, err: err}
	}
	return cfg, ModeCloudVM, nil
}

// ParseUserData validates a cloudvm's user data: one config object (bootenv.ParseConfig) for
// profile cloudvm and the provider the firmware names.
func ParseUserData(raw []byte, provider string) (bootenv.Config, error) {
	cfg, err := bootenv.ParseConfig(raw)
	if err != nil {
		return bootenv.Config{}, err
	}
	if cfg.HostProfile != string(hostprofile.CloudVM) {
		return bootenv.Config{}, errors.New("user data: host_profile must be cloudvm")
	}
	if cfg.HostProvider != provider {
		return bootenv.Config{}, errors.New("user data: host_provider differs from the firmware's provider")
	}
	return cfg, nil
}

// codeError carries a fixed phase code for a step's failure.
type codeError struct {
	code pl.Code
	err  error
}

func (e *codeError) Error() string { return e.err.Error() }
func (e *codeError) Unwrap() error { return e.err }
