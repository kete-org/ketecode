// Command kete-job-host is the self-hosted job host agent (ADR 0023 rule 6): a root systemd
// service that enrolls the host, polls the platform with signed requests, and runs one machine
// per job through its driver. It never listens on a port. See the module README.
//
//	kete-job-host enroll [--config PATH] [--replace] [--token-file PATH]   token on stdin or in the file
//	kete-job-host run [--config PATH] [--debug]
//	kete-job-host doctor [--config PATH]
//	kete-job-host fingerprint [--config PATH]
//	kete-job-host version
//
// Exit codes: 0 done, 1 failed, 2 usage or configuration, 3 halted (re-enroll or fix the key).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/clock"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/enroll"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fsutil"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

// version is set at build time (-ldflags "-X main.version=…").
var version = "0.0.0-dev"

const usage = `usage: kete-job-host <enroll|run|doctor|fingerprint|version> [--config PATH]
  enroll       generate the host keys and enroll with the token read from stdin
               (--token-file PATH: from a root-only file, removed once the platform answered;
               a dedicated host's boot enrollment after a provider rebuild)
  run          run the agent (the systemd service)
  doctor       check the configuration, keys, state and host
  fingerprint  print the host key fingerprint
  version      print the agent version`

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if code, ok := hidden(args); ok {
		return code
	}
	if len(args) == 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	cmd := args[0]
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.SetOutput(stderr)
	cfgPath := fs.String("config", config.DefaultPath, "configuration file")
	replace := fs.Bool("replace", false, "enroll: re-enroll an enrolled host with new keys")
	tokenFile := fs.String("token-file", "", "enroll: read the token from this root-only file (removed once the platform answered)")
	debug := fs.Bool("debug", false, "run: debug logging")
	if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: level})).With("agent_version", version)

	if cmd == "version" {
		fmt.Fprintln(stdout, version)
		return 0
	}
	cfg, err := config.Load(*cfgPath)
	if cmd == "doctor" && err != nil {
		fmt.Fprintf(stdout, "FAIL %-14s %v\n", "config", err)
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
		return 2
	}
	switch cmd {
	case "enroll":
		return cmdEnroll(cfg, *replace, *tokenFile, stdin, stdout, stderr, log)
	case "run":
		return cmdRun(cfg, stderr, log)
	case "doctor":
		return cmdDoctor(cfg, stdout)
	case "fingerprint":
		k, err := keys.Load(keys.Dir(cfg.StateDir))
		if err != nil {
			fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
			return 1
		}
		fmt.Fprintln(stdout, sig.GroupFingerprint(k.Fingerprint()))
		return 0
	}
	fmt.Fprintln(stderr, usage)
	return 2
}

func requireRoot(stderr io.Writer) bool {
	if os.Geteuid() != 0 {
		fmt.Fprintln(stderr, "kete-job-host: must run as root (its state is root-only, ADR 0023 rule 6)")
		return false
	}
	return true
}

func versions(cfg config.Config) (contract.Versions, error) {
	hk, err := hostKernel()
	if err != nil {
		return contract.Versions{}, err
	}
	v := contract.Versions{Agent: version, HostKernel: hk, Firecracker: cfg.Firecracker, GuestKernel: cfg.GuestKernel}
	return v, v.Validate()
}

func facts(cfg config.Config) (contract.Facts, error) {
	v, err := versions(cfg)
	if err != nil {
		return contract.Facts{}, err
	}
	arch := runtime.GOARCH
	if arch != "amd64" && arch != "arm64" {
		return contract.Facts{}, fmt.Errorf("unsupported architecture %s", arch)
	}
	return contract.Facts{Arch: arch, Driver: cfg.Driver, Slots: cfg.Slots, KVM: kvmPresent(), Reset: cfg.Reset, Versions: v}, nil
}

func cmdEnroll(cfg config.Config, replace bool, tokenFile string, stdin io.Reader, stdout, stderr io.Writer, log *slog.Logger) int {
	if !requireRoot(stderr) {
		return 1
	}
	f, err := facts(cfg)
	if err == nil {
		f.Generation = "g-placeholder" // replaced by enroll.Run; validated there with the real one
		err = f.Validate()
	}
	if err != nil {
		fmt.Fprintf(stderr, "kete-job-host: host facts: %v\n", err)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	_, err = enroll.Run(ctx, enroll.Options{
		Config: cfg, Client: client.New(cfg.Origin, cfg.Authority, nil, client.Options{}), Facts: f,
		Token: stdin, TokenFile: tokenFile, Out: stdout, Log: log, Replace: replace,
	})
	if err != nil {
		fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
		return 1
	}
	return 0
}

func cmdRun(cfg config.Config, stderr io.Writer, log *slog.Logger) int {
	if !requireRoot(stderr) {
		return 1
	}
	drv, err := newDriver(cfg, log)
	if err != nil {
		fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
		return 2
	}
	k, err := keys.Load(keys.Dir(cfg.StateDir))
	if err != nil {
		fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
		return 1
	}
	v, err := versions(cfg)
	if err != nil {
		fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
		return 2
	}
	a, err := agent.New(agent.Options{
		Config: cfg, Keys: k, Driver: drv, Verifier: verifier(cfg),
		Client: client.New(cfg.Origin, cfg.Authority, nil, client.Options{}), Clock: clock.System(), Versions: v, Log: log,
	})
	if err != nil {
		fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The driver prepares the host (the firecracker driver applies the host table) before reconcile.
	if in, ok := drv.(interface{ Init(context.Context) error }); ok {
		if err := in.Init(ctx); err != nil {
			fmt.Fprintf(stderr, "kete-job-host: driver: %v\n", err)
			return 1
		}
	}
	log.Info("started", "driver", cfg.Driver, "slots", cfg.Slots, "platform", cfg.Origin)
	err = a.Run(ctx)
	switch {
	case errors.Is(err, agent.ErrHalted):
		fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
		return 3
	case errors.Is(err, context.Canceled):
		log.Info("stopped")
		return 0
	case err != nil:
		fmt.Fprintf(stderr, "kete-job-host: %v\n", err)
		return 1
	}
	return 0
}

// verifier is the production image signature verifier: cosign keyless signatures by Kete's
// release workflow, checked with sigstore-go against the Sigstore trusted root from TUF (cached
// under the state directory). ADR 0023 rule 17.
func verifier(cfg config.Config) image.Verifier {
	return image.Sigstore{Identity: image.ReleaseIdentity, Trusted: image.TUFTrustedRoot(image.TUFDir(cfg.StateDir))}
}

func cmdDoctor(cfg config.Config, out io.Writer) int {
	failed := false
	check := func(name string, err error) {
		if err != nil {
			failed = true
			fmt.Fprintf(out, "FAIL %-14s %v\n", name, err)
			return
		}
		fmt.Fprintf(out, "ok   %s\n", name)
	}
	note := func(name, msg string) { fmt.Fprintf(out, "note %-14s %s\n", name, msg) }
	check("config", nil) // config.Load: root-owned regular file, no group/other write, no symlink
	check("root", map[bool]error{true: nil, false: errors.New("not running as root")}[os.Geteuid() == 0])
	check("state dir", fsutil.CheckPrivate(cfg.StateDir, true))
	k, err := keys.Load(keys.Dir(cfg.StateDir))
	check("keys", err)
	st, err := state.Load(state.Path(cfg.StateDir))
	if err == nil && !st.Enrolled() {
		err = errors.New("not enrolled (kete-job-host enroll)")
	}
	if err == nil && k.Signing != nil && st.Fingerprint != k.Fingerprint() {
		err = errors.New("the keys are not the ones this host enrolled with")
	}
	if err == nil && st.Halted != "" {
		err = fmt.Errorf("halted (%s): re-enroll with --replace", st.Halted)
	}
	check("enrollment", err)
	synced, err := clock.System().Synced()
	if err == nil && !synced {
		err = errors.New("the kernel reports the clock unsynchronised (NTP)")
	}
	check("clock", err)
	_, err = facts(cfg)
	check("host facts", err)
	if cfg.Driver == contract.DriverFirecracker && !kvmPresent() {
		check("kvm", errors.New("/dev/kvm is missing: the firecracker driver needs KVM"))
	}
	_, err = newDriver(cfg, slog.New(slog.DiscardHandler))
	check("driver", err)
	driverChecks(cfg, check, note)
	if len(cfg.ImageAllowlist) == 0 {
		note("images", "the image allowlist is empty: every assignment fails image_not_allowed")
	}
	if failed {
		return 1
	}
	return 0
}
