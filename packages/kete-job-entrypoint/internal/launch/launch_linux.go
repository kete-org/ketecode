//go:build linux

package launch

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Options say where and how stage 2 runs.
type Options struct {
	Exe       string // the entrypoint binary (/proc/self/exe)
	CgroupDir string // joined at clone time; empty keeps the caller's cgroup
	Stdin     *os.File
	Stdout    *os.File
	Stderr    *os.File
	Extra     []*os.File // become fds 3, 4, … in the target
	Timeout   time.Duration
}

// Process is a started target.
type Process struct {
	Pid   int
	cmd   *exec.Cmd
	done  chan struct{}
	mu    sync.Mutex
	state *os.ProcessState
}

// Start runs stage 2 and returns once the target's execve succeeded.
func Start(o Options, s Spec) (*Process, error) {
	if err := s.Validate(); err != nil {
		return nil, err
	}
	if o.Timeout <= 0 {
		o.Timeout = 10 * time.Second
	}
	body, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	specR, specW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer specR.Close()
	defer specW.Close()
	statusR, statusW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer statusR.Close()
	defer statusW.Close()

	cmd := &exec.Cmd{
		Path:       o.Exe,
		Args:       []string{o.Exe, Arg, strconv.Itoa(len(o.Extra))},
		Env:        StageEnv,
		Stdin:      o.Stdin,
		Stdout:     o.Stdout,
		Stderr:     o.Stderr,
		ExtraFiles: append(append([]*os.File{}, o.Extra...), specR, statusW),
	}
	attr := &syscall.SysProcAttr{Setsid: true}
	var cgFD = -1
	if o.CgroupDir != "" {
		cgFD, err = unix.Open(o.CgroupDir, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, err
		}
		defer unix.Close(cgFD)
		attr.UseCgroupFD = true
		attr.CgroupFD = cgFD
	}
	cmd.SysProcAttr = attr
	if o.Stdin == nil {
		devnull, err := os.Open(os.DevNull)
		if err != nil {
			return nil, err
		}
		defer devnull.Close()
		cmd.Stdin = devnull
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	_ = specR.Close()
	_ = statusW.Close()
	p := &Process{Pid: cmd.Process.Pid, cmd: cmd, done: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		p.mu.Lock()
		p.state = cmd.ProcessState
		p.mu.Unlock()
		close(p.done)
	}()

	if _, err := specW.Write(body); err != nil {
		p.kill()
		return nil, err
	}
	_ = specW.Close()

	_ = statusR.SetReadDeadline(time.Now().Add(o.Timeout))
	msg, err := io.ReadAll(io.LimitReader(statusR, 4096))
	if err != nil {
		p.kill()
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return nil, &Error{Code: "timeout"}
		}
		return nil, err
	}
	if len(msg) > 0 {
		<-p.done
		return nil, decodeStatus(msg)
	}
	return p, nil
}

func (p *Process) kill() {
	_ = p.cmd.Process.Kill()
	<-p.done
}

// Done is closed once the target has exited and been reaped.
func (p *Process) Done() <-chan struct{} { return p.done }

// Signal sends sig (a no-op once reaped).
func (p *Process) Signal(sig syscall.Signal) {
	select {
	case <-p.done:
		return
	default:
	}
	_ = p.cmd.Process.Signal(sig)
}

// ExitCode is the exit status once Done (-1 for a signal or while running).
func (p *Process) ExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state == nil {
		return -1
	}
	return p.state.ExitCode()
}

// Wait waits up to d for the exit, then SIGKILLs and waits.
func (p *Process) Wait(d time.Duration) {
	select {
	case <-p.done:
	case <-time.After(d):
		p.kill()
	}
}
