// Command kete-root-helper is the root process job mode uses to run a job's tools as a fixed,
// unprivileged tool user (module README). It is Linux-only, ships in the (future) job container
// image, and is never installed alongside the `kete` CLI.
package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/cgroup"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/config"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/server"
)

const minKernelMajor, minKernelMinor = 5, 11

func main() {
	// __exec dispatch runs before any flag parsing or logging: this invocation is stage 2 (the
	// short-lived in-child privilege drop), re-exec'd by stage 1 via /proc/self/exe (module
	// README "Spawn sequence").
	if len(os.Args) >= 2 && os.Args[1] == "__exec" {
		launch.RunStage2()
		return
	}

	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	ensureNoNewPrivs() // re-execs and never returns if NNP wasn't already set

	if os.Geteuid() != 0 {
		return fmt.Errorf("kete-root-helper must run as root (uid 0)")
	}
	if err := checkKernelVersion(); err != nil {
		return err
	}

	cfg, err := config.Parse(args)
	if err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}

	if err := cgroup.StartupCheck(cfg.ToolCgroup); err != nil {
		return err
	}

	rootFD, err := unix.Open(cfg.WorktreeRoot, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("--worktree-root %q: %w", cfg.WorktreeRoot, err)
	}

	helperExe, err := os.Readlink("/proc/self/exe")
	if err != nil {
		return fmt.Errorf("readlink /proc/self/exe: %w", err)
	}

	ln, err := server.Listen(cfg.Socket, cfg.KeteUID)
	if err != nil {
		return err
	}

	launcher := launch.NewLauncher(launch.Config{
		HelperExe:    helperExe,
		RootFD:       rootFD,
		WorktreeRoot: cfg.WorktreeRoot,
		ToolCgroup:   cfg.ToolCgroup,
		ToolUID:      cfg.ToolUID,
		ToolGID:      cfg.ToolGID,
		MaxProcesses: cfg.MaxProcesses,
		SpawnRate:    cfg.SpawnRate,
		SpawnBurst:   cfg.SpawnBurst,
	})

	logger := log.New(os.Stderr, "", 0)
	logger.Printf(`{"event":"listening","socket":%q}`, cfg.Socket)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		logger.Printf(`{"event":"shutdown"}`)
		_ = ln.Close()
		launcher.Shutdown()
		os.Exit(0)
	}()

	serveCfg := server.Config{
		KeteUID:      cfg.KeteUID,
		MaxFrame:     cfg.MaxFrame,
		MaxProcesses: cfg.MaxProcesses,
		WorktreeRoot: cfg.WorktreeRoot,
		EnvAllow:     cfg.EnvAllow,
		EnvSet:       cfg.EnvSet,
		SpawnRate:    cfg.SpawnRate,
		SpawnBurst:   cfg.SpawnBurst,
	}
	return server.Serve(ln, launcher, serveCfg, logger)
}

// ensureNoNewPrivs guarantees the helper itself runs with no_new_privs set — required so nothing
// it starts can regain privilege through a setuid or file-capability binary (module README
// "Start-up configuration"). prctl is per-thread and Go has threads running before main, so
// setting it here would not cover the whole process; instead, if it isn't already set, the
// process re-execs itself in full (the same running inode, via /proc/self/exe) after locking this
// goroutine to its OS thread and setting the bit on that thread — the exec then applies it
// process-wide.
func ensureNoNewPrivs() {
	runtime.LockOSThread()
	got, err := unix.PrctlRetInt(unix.PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0)
	if err == nil && got == 1 {
		runtime.UnlockOSThread()
		return
	}
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fmt.Fprintf(os.Stderr, "kete-root-helper: PR_SET_NO_NEW_PRIVS: %v\n", err)
		os.Exit(1)
	}
	if err := unix.Exec("/proc/self/exe", os.Args, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "kete-root-helper: re-exec for no_new_privs: %v\n", err)
		os.Exit(1)
	}
}

func checkKernelVersion() error {
	var uts unix.Utsname
	if err := unix.Uname(&uts); err != nil {
		return fmt.Errorf("uname: %w", err)
	}
	release := unix.ByteSliceToString(uts.Release[:])
	major, minor, err := parseKernelVersion(release)
	if err != nil {
		return fmt.Errorf("kernel release %q: %w", release, err)
	}
	if major < minKernelMajor || (major == minKernelMajor && minor < minKernelMinor) {
		return fmt.Errorf("kernel %s is older than the minimum %d.%d", release, minKernelMajor, minKernelMinor)
	}
	return nil
}

func parseKernelVersion(release string) (major int, minor int, err error) {
	parts := strings.SplitN(release, ".", 3)
	if len(parts) < 2 {
		return 0, 0, fmt.Errorf("unexpected format")
	}
	major, err = strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, err
	}
	minor, err = strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, err
	}
	return major, minor, nil
}
