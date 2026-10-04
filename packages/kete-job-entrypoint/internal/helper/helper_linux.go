//go:build linux

package helper

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/setup"
)

// Options say how to run the helper.
type Options struct {
	Bin        string
	LaunchExe  string
	CgroupDir  string // the system cgroup
	StderrPath string
	Ready      time.Duration
	StopWait   time.Duration
}

// Helper is the running helper.
type Helper struct {
	proc   *launch.Process
	socket string
	stopW  time.Duration
}

// Start launches the helper as root (oom −1000, umask 002 so tools create group-writable files
// in the setgid worktree) and waits for its socket: a socket owned by the kete uid, mode 0600.
func Start(o Options, f Flags) (*Helper, error) {
	errf, err := setup.CreateRootFile(o.StderrPath, true)
	if err != nil {
		return nil, err
	}
	defer errf.Close()
	proc, err := launch.Start(launch.Options{
		Exe: o.LaunchExe, CgroupDir: o.CgroupDir, Stdout: errf, Stderr: errf, Timeout: o.Ready,
	}, launch.Spec{
		Path: o.Bin, Argv: append([]string{o.Bin}, f.Args()...), Env: launch.StageEnv,
		KeepRoot: true, Groups: []uint32{}, OOMScoreAdj: -1000, Umask: 0o002, NoNewPrivs: true, Dir: "/",
	})
	if err != nil {
		return nil, err
	}
	h := &Helper{proc: proc, socket: f.Socket, stopW: o.StopWait}
	deadline := time.Now().Add(o.Ready)
	for {
		var st unix.Stat_t
		if err := unix.Lstat(f.Socket, &st); err == nil {
			if st.Mode&unix.S_IFMT == unix.S_IFSOCK && st.Uid == f.KeteUID && st.Mode&0o777 == 0o600 {
				return h, nil
			}
		}
		select {
		case <-proc.Done():
			return nil, errors.New("helper: exited before its socket was ready")
		default:
		}
		if time.Now().After(deadline) {
			h.Stop()
			return nil, fmt.Errorf("helper: socket %s not ready", f.Socket)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Exited is closed when the helper has exited.
func (h *Helper) Exited() <-chan struct{} { return h.proc.Done() }

// Stop SIGTERMs the helper (it closes its listener and kills every leaf), waits, SIGKILLs if
// needed, and unlinks the socket.
func (h *Helper) Stop() {
	h.proc.Signal(syscall.SIGTERM)
	h.proc.Wait(h.stopW)
	_ = os.Remove(h.socket)
}

// Kill SIGKILLs the helper at once (the hard deadline).
func (h *Helper) Kill() {
	h.proc.Signal(syscall.SIGKILL)
	h.proc.Wait(time.Second)
	_ = os.Remove(h.socket)
}
