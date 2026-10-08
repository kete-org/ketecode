//go:build linux

// Command kete-job-entrypoint is a cloud job container's root entrypoint (module README): it sets
// up the machine, guards the network, claims the job, clones the repository, runs `kete job run`
// with its tools under the tool user, and reports the result, the audit log, the proxy log and a
// safe change bundle. Linux-only; it ships in the job image, never with the `kete` CLI.
//
// Stages, by argv[1]: `__launch` (stage 2 of a launch, before anything else), `__isolation_probe`
// (the isolation check's probe, already the tool user), `__run` (the
// scrubbed re-exec, reading the machine configuration from a pipe), default (boot: read and
// validate the environment, or with `--config-fd <n>` the config pipe kete-job-init or the host
// agent wrote, or with `--config-file` the Kubernetes runner's per-job Secret (kubevm), resolve
// the host profile, then re-exec as `__run` with an empty environment).
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/entry"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

func main() {
	if len(os.Args) >= 2 && os.Args[1] == launch.Arg {
		launch.RunStage2()
		return
	}
	if len(os.Args) == 2 && os.Args[1] == isolation.ProbeArg {
		isolation.RunProbe() // as the tool user, launched by the isolation check
		return
	}
	log := phaselog.New(os.Stdout)
	if os.Geteuid() != 0 {
		log.Fail(phaselog.StepBoot, phaselog.CodeRefused)
		os.Exit(2)
	}
	if len(os.Args) == 3 && os.Args[1] == bootenv.RunArg {
		boot, err := bootenv.Receive(os.Args[2])
		if err != nil {
			log.Fail(phaselog.StepBoot, phaselog.CodeInvalid)
			os.Exit(2)
		}
		// SIGTERM never passes through to a job process: it aborts the job (kill everything,
		// exit 1).
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer stop()
		os.Exit(entry.Main(ctx, layout.Default(), boot, os.Stdout))
	}
	var boot bootenv.Values
	var err error
	switch {
	case len(os.Args) == 1:
		boot, err = bootenv.FromEnv(os.Getenv, flyDirExists(layout.Default().FlyDir))
	case len(os.Args) == 3 && os.Args[1] == bootenv.ConfigFDArg:
		var c bootenv.Config
		if c, err = bootenv.ReadConfigFD(os.Args[2]); err == nil {
			boot, err = bootenv.FromConfig(c, os.Getenv)
		}
	case len(os.Args) == 3 && os.Args[1] == bootenv.ConfigFileArg:
		// kubevm: the per-job Secret's file. Only read here; it is unmounted in setup_kubevm,
		// after the shared-kernel check.
		var c bootenv.Config
		if c, err = bootenv.ReadConfigFile(os.Args[2], layout.ConfigFile); err == nil {
			boot, err = bootenv.FromConfig(c, os.Getenv)
		}
	default:
		fmt.Fprintln(os.Stderr, "usage: kete-job-entrypoint [--config-fd <n> | --config-file "+layout.ConfigFile+"] (on Fly configured by KETE_JOB_ID, KETE_JOB_PLATFORM_URL, KETE_JOB_CLAIM_TOKEN, KETE_JOB_STORAGE_HOST; "+hostprofile.Var+" selects the host profile)")
		os.Exit(2)
	}
	if err != nil {
		log.Fail(phaselog.StepBoot, phaselog.CodeInvalid)
		os.Exit(2)
	}
	if err := bootenv.Handover("/proc/self/exe", boot); err != nil {
		log.Fail(phaselog.StepBoot, phaselog.CodeFailed)
		os.Exit(2)
	}
}

// flyDirExists reports whether Fly's directory exists (of any type): a Fly signal. An error other
// than "doesn't exist" also counts (fail closed: the profile must then be fly, whose guard checks).
func flyDirExists(dir string) bool {
	var st unix.Stat_t
	err := unix.Lstat(dir, &st)
	return err == nil || err != unix.ENOENT
}
