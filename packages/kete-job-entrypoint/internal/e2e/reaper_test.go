//go:build e2e && linux

package e2e

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
)

// TestMain lets e2e.test stand in for kete-job-host's dedicated reaper (`e2e.test
// __dedicated-init`, scripts/e2e.sh): the job container's PID 1, which starts the image's
// entrypoint the way the reaper does.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == hostprofile.DedicatedInitArg {
		os.Exit(standInReaper())
	}
	os.Exit(m.Run())
}

const entrypointBin = "/usr/local/libexec/kete/kete-job-entrypoint"

// standInReaper is a test-only stand-in for the dedicated reaper inside a Docker container. The
// entrypoint's shared-kernel guard refuses Docker's set-up (hostprofile kernel.go), so this
// rebuilds the reaper's: PID 1 with the reaper's argv, no mount Docker made under /etc (each file
// mount's content is copied into the container's own file first), no /.dockerenv. It is still a
// container on a shared kernel, which is why e2e.sh saves and restores the sysctls the entrypoint
// sets. The config arrives on stdin (`docker run -i`) and is handed on as the entrypoint's stdin.
func standInReaper() int {
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, "e2e stand-in reaper:", err)
		return 1
	}
	if os.Getpid() != 1 {
		return fail(errors.New("must be PID 1 of the job container"))
	}
	if err := unix.Mount("", "/", "", unix.MS_REC|unix.MS_PRIVATE, ""); err != nil {
		return fail(err)
	}
	mi, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return fail(err)
	}
	var points []string
	for _, line := range strings.Split(string(mi), "\n") {
		if mp := hostprofile.RuntimeMountIn(line); mp != "" {
			points = append(points, mp)
		}
	}
	sort.Slice(points, func(i, j int) bool { return len(points[i]) > len(points[j]) }) // deepest first
	for _, mp := range points {
		fi, err := os.Stat(mp)
		if err != nil {
			return fail(err)
		}
		var content []byte
		if fi.Mode().IsRegular() {
			if content, err = readAll(mp, 16<<20); err != nil {
				return fail(err)
			}
		}
		if err := unix.Unmount(mp, unix.MNT_DETACH); err != nil {
			return fail(fmt.Errorf("unmount %s: %w", mp, err))
		}
		if fi.Mode().IsRegular() {
			if err := os.WriteFile(mp, content, 0o644); err != nil {
				return fail(err)
			}
		}
	}
	for _, f := range hostprofile.ContainerMarkerFiles {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fail(err)
		}
	}
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, unix.SIGTERM, unix.SIGINT)
	p, err := os.StartProcess(entrypointBin, []string{entrypointBin, "--config-fd", "0"}, &os.ProcAttr{
		Dir: "/", Env: []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "KETE_JOB_HOST_PROFILE=dedicated"},
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
	})
	if err != nil {
		return fail(err)
	}
	pid := p.Pid
	go func() {
		for s := range sigs {
			_ = unix.Kill(pid, s.(syscall.Signal))
		}
	}()
	code := -1
	for code < 0 {
		var ws unix.WaitStatus
		got, err := unix.Wait4(-1, &ws, 0, nil)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return fail(err)
		}
		if got != pid {
			continue
		}
		switch {
		case ws.Exited():
			code = ws.ExitStatus()
		case ws.Signaled():
			code = 128 + int(ws.Signal())
		}
	}
	_ = unix.Kill(-1, unix.SIGKILL)
	return code
}

func readAll(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err == nil && int64(len(b)) > max {
		err = errors.New(path + " is too large")
	}
	return b, err
}
