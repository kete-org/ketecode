//go:build linux

// Package launch is stage 1 (the helper side of a spawn, still root; this file) and stage 2 (the
// short-lived in-child privilege drop, stage2_linux.go) of the module README's "Spawn sequence".
// Launcher is the seam internal/server spawns and kills processes through; server_test.go fakes
// it, so this file carries no protocol framing — only OS state.
package launch

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/cgroup"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/policy"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/protocol"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/ratelimit"
)

// statusReadDeadline bounds how long stage 1 waits for stage 2 to report SPAWNED or ERROR
// (module README "Spawn sequence", step 8).
const statusReadDeadline = 10 * time.Second

// statusMaxSize bounds the status pipe read (module README "Spawn sequence", step 8: "≤ 4 KiB").
const statusMaxSize = 4096

// Config is the Launcher's fixed configuration, taken directly from the validated flags
// (internal/config) — never from a request.
type Config struct {
	// HelperExe is re-exec'd for stage 2 — always "/proc/self/exe" (the running inode; see the
	// module README "Spawn sequence" for why a path string is never used here).
	HelperExe string
	// RootFD is an O_PATH fd for --worktree-root, opened once at start-up and kept for the life
	// of the process; every spawn's cwd is anchored to this fd, never a path.
	RootFD       int
	WorktreeRoot string
	ToolCgroup   string
	ToolUID      uint32
	ToolGID      uint32
	MaxProcesses int
	SpawnRate    float64
	SpawnBurst   int
}

// StdioMode is how one of a spawned process's standard streams is connected.
type StdioMode int

const (
	StdioNull StdioMode = iota
	StdioPipe
)

// SpawnRequest is what a caller asks the Launcher to start. Argv/Env/Cwd must already have passed
// internal/policy's checks — Launcher does the openat2 pre-check and the authoritative stage-2
// check, but not the syntactic ones.
type SpawnRequest struct {
	Argv   []string
	Env    []string // "NAME=VALUE", already filtered to the allowlist and merged with --env-set
	Cwd    string
	Stdin  StdioMode
	Stdout StdioMode
	Stderr StdioMode
}

// Error is a Launcher failure with the protocol error code it should be reported as.
type Error struct {
	Code    protocol.ErrorCode
	Message string
}

func (e *Error) Error() string { return e.Message }

// ExitResult is what a Process's Exit channel delivers once: exactly one of Code/Signal is set.
type ExitResult struct {
	Code   *int
	Signal *string
}

// Process is a running (or just-exited) spawn. Every field a fake Launcher needs to construct in
// a test (server/server_test.go) is exported; the real launcher's own bookkeeping stays private.
type Process struct {
	ID     string
	Pid    int
	Stdin  io.WriteCloser // nil unless SpawnRequest.Stdin == StdioPipe
	Stdout io.ReadCloser  // nil unless SpawnRequest.Stdout == StdioPipe
	Stderr io.ReadCloser  // nil unless SpawnRequest.Stderr == StdioPipe
	// ExitCh delivers exactly one ExitResult when the leader is reaped.
	ExitCh <-chan ExitResult

	leafPath string
	pidfdMu  sync.Mutex
	pidfd    int // -1 once closed/reaped
	exitCh   chan ExitResult
}

// Launcher owns the leaf cgroups and live-process bookkeeping for one helper process.
type Launcher struct {
	cfg Config

	mu      sync.Mutex
	counter uint64
	live    map[string]*Process
	// instance makes leaf names unique per helper process: a leaf a previous helper left behind
	// (its rmdir can lag the last process's exit) must never collide with this helper's spawns.
	instance int

	bucket *ratelimit.Bucket
}

// NewLauncher creates a Launcher from validated Config.
func NewLauncher(cfg Config) *Launcher {
	return &Launcher{
		cfg:      cfg,
		live:     make(map[string]*Process),
		bucket:   ratelimit.New(cfg.SpawnRate, cfg.SpawnBurst, nil),
		instance: os.Getpid(),
	}
}

// LiveCount reports the number of spawns currently tracked (reserved through Spawn, not yet
// Released).
func (l *Launcher) LiveCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.live)
}

// Spawn validates rate/concurrency, then runs the two-stage exec (module README "Spawn
// sequence"). Callers must already have run internal/policy's ValidateArgv/ValidateEnv/ValidateCwd.
func (l *Launcher) Spawn(req SpawnRequest) (*Process, error) {
	rel := policy.RelativeCwd(req.Cwd, l.cfg.WorktreeRoot)

	// Step 2: pre-check as root — early, friendly error; not the security check (stage 2 repeats
	// this as the tool user, which is authoritative).
	if err := l.precheckCwd(rel); err != nil {
		return nil, err
	}

	// Step 3: rate/concurrency.
	if !l.bucket.Allow() {
		return nil, &Error{Code: protocol.ErrorRate, Message: "spawn rate limit exceeded"}
	}
	l.mu.Lock()
	if len(l.live) >= l.cfg.MaxProcesses {
		l.mu.Unlock()
		return nil, &Error{Code: protocol.ErrorBusy, Message: "too many live processes"}
	}
	l.counter++
	id := fmt.Sprintf("p%d-%d", l.instance, l.counter)
	l.live[id] = nil // reserve the slot before releasing the lock
	l.mu.Unlock()

	proc, err := l.doSpawn(id, rel, req)

	l.mu.Lock()
	if err != nil {
		delete(l.live, id)
	} else {
		l.live[id] = proc
	}
	l.mu.Unlock()

	return proc, err
}

func (l *Launcher) precheckCwd(rel string) error {
	how := unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS,
	}
	fd, err := unix.Openat2(l.cfg.RootFD, rel, &how)
	if err != nil {
		return &Error{Code: protocol.ErrorCwd, Message: fmt.Sprintf("cwd: %v", err)}
	}
	_ = unix.Close(fd)
	return nil
}

func internalErr(what string, err error) error {
	return &Error{Code: protocol.ErrorInternal, Message: fmt.Sprintf("%s: %v", what, err)}
}

func (l *Launcher) doSpawn(id, rel string, req SpawnRequest) (proc *Process, rerr error) {
	leafFD, leafPath, err := cgroup.CreateLeaf(l.cfg.ToolCgroup, id)
	if err != nil {
		return nil, internalErr("create leaf", err)
	}
	leafRemoved := false
	defer func() {
		_ = unix.Close(leafFD)
		if rerr != nil && !leafRemoved {
			_ = cgroup.RemoveLeaf(leafPath)
		}
	}()

	stdinChild, stdinParent, err := ioPipe(req.Stdin, true)
	if err != nil {
		return nil, internalErr("stdin pipe", err)
	}
	defer func() {
		_ = stdinChild.Close()
		if rerr != nil && stdinParent != nil {
			_ = stdinParent.Close()
		}
	}()
	stdoutChild, stdoutParent, err := ioPipe(req.Stdout, false)
	if err != nil {
		return nil, internalErr("stdout pipe", err)
	}
	defer func() {
		_ = stdoutChild.Close()
		if rerr != nil && stdoutParent != nil {
			_ = stdoutParent.Close()
		}
	}()
	stderrChild, stderrParent, err := ioPipe(req.Stderr, false)
	if err != nil {
		return nil, internalErr("stderr pipe", err)
	}
	defer func() {
		_ = stderrChild.Close()
		if rerr != nil && stderrParent != nil {
			_ = stderrParent.Close()
		}
	}()

	specR, specW, err := os.Pipe()
	if err != nil {
		return nil, internalErr("spec pipe", err)
	}
	defer func() { _ = specR.Close() }()

	statusR, statusW, err := os.Pipe()
	if err != nil {
		return nil, internalErr("status pipe", err)
	}
	defer func() { _ = statusW.Close() }()

	pidfd := -1
	pid, err := syscall.ForkExec(l.cfg.HelperExe, []string{"kete-root-helper", "__exec"}, &syscall.ProcAttr{
		// Never nil: nil would inherit the helper's own environment.
		Env: []string{},
		Files: []uintptr{
			stdinChild.Fd(), stdoutChild.Fd(), stderrChild.Fd(),
			specR.Fd(), uintptr(l.cfg.RootFD), statusW.Fd(),
		},
		Sys: &syscall.SysProcAttr{
			UseCgroupFD: true,
			CgroupFD:    leafFD,
			PidFD:       &pidfd,
			Setsid:      true,
		},
	})
	_ = stdinChild.Close()
	_ = stdoutChild.Close()
	_ = stderrChild.Close()
	_ = specR.Close()
	_ = statusW.Close()
	if err != nil {
		return nil, internalErr("fork/exec", err)
	}

	spec := stage2Spec{Argv: req.Argv, Env: req.Env, Rel: rel, UID: l.cfg.ToolUID, GID: l.cfg.ToolGID}
	body, err := json.Marshal(spec)
	if err != nil {
		_ = unix.PidfdSendSignal(pidfd, syscall.SIGKILL, nil, 0)
		_ = specW.Close()
		reapPidfd(pidfd)
		return nil, internalErr("marshal spec", err)
	}
	if _, err := specW.Write(body); err != nil {
		_ = unix.PidfdSendSignal(pidfd, syscall.SIGKILL, nil, 0)
		_ = specW.Close()
		reapPidfd(pidfd)
		return nil, internalErr("write spec", err)
	}
	_ = specW.Close()

	_ = statusR.SetReadDeadline(time.Now().Add(statusReadDeadline))
	data, readErr := io.ReadAll(io.LimitReader(statusR, statusMaxSize+1))
	_ = statusR.Close()

	if readErr != nil {
		// Timeout or another read failure: group-kill the leaf and reap.
		_ = unix.PidfdSendSignal(pidfd, syscall.SIGKILL, nil, 0)
		reapPidfd(pidfd)
		l.killGroup(leafPath, syscall.SIGKILL)
		_ = cgroup.RemoveLeaf(leafPath)
		leafRemoved = true
		return nil, &Error{Code: protocol.ErrorInternal, Message: fmt.Sprintf("stage 2 status: %v", readErr)}
	}

	if len(data) > 0 {
		// An explicit failure: stage 2 wrote {code, errno} and exited before execve.
		reapPidfd(pidfd)
		_ = cgroup.RemoveLeaf(leafPath)
		leafRemoved = true
		var status stage2Status
		code := protocol.ErrorInternal
		message := "spawn failed"
		if err := json.Unmarshal(data, &status); err == nil {
			message = status.Code
			switch status.Code {
			case "cwd":
				code = protocol.ErrorCwd
			case "not_found":
				code = protocol.ErrorNotFound
			case "exec":
				code = protocol.ErrorExec
			case "identity":
				code = protocol.ErrorIdentity
			case "nnp":
				code = protocol.ErrorNNP
			default:
				code = protocol.ErrorInternal
			}
		}
		return nil, &Error{Code: code, Message: message}
	}

	// Success: EOF with 0 bytes means CLOSE_RANGE_CLOEXEC closed fd 5 at the tool's execve.
	exitCh := make(chan ExitResult, 1)
	proc = &Process{
		ID:       id,
		Pid:      pid,
		ExitCh:   exitCh,
		leafPath: leafPath,
		pidfd:    pidfd,
		exitCh:   exitCh,
	}
	// Assigned only when non-nil: stdinParent etc. are *os.File, and a nil *os.File wrapped in
	// the io.WriteCloser/io.ReadCloser interface fields would compare != nil (a classic Go trap)
	// even though there is no pipe, which would make callers try to use it.
	if stdinParent != nil {
		proc.Stdin = stdinParent
	}
	if stdoutParent != nil {
		proc.Stdout = stdoutParent
	}
	if stderrParent != nil {
		proc.Stderr = stderrParent
	}
	go l.reap(proc)

	return proc, nil
}

// reap blocks until the leader has exited (via its pidfd, immune to pid reuse), then delivers the
// result on proc.ExitCh. It uses WNOWAIT so the zombie survives for the wait4 call that actually
// extracts the exit code/signal — reads never race a pid recycle, because the kernel keeps a
// zombie's pid reserved until it is reaped.
func (l *Launcher) reap(proc *Process) {
	var info unix.Siginfo
	_ = unix.Waitid(unix.P_PIDFD, proc.pidfd, &info, unix.WEXITED|unix.WNOWAIT, nil)

	var wstatus syscall.WaitStatus
	_, _ = syscall.Wait4(proc.Pid, &wstatus, 0, nil)

	result := ExitResult{}
	if wstatus.Signaled() {
		name := signalName(wstatus.Signal())
		result.Signal = &name
	} else {
		code := wstatus.ExitStatus()
		result.Code = &code
	}

	proc.pidfdMu.Lock()
	if proc.pidfd >= 0 {
		_ = unix.Close(proc.pidfd)
		proc.pidfd = -1
	}
	proc.pidfdMu.Unlock()

	proc.exitCh <- result
	close(proc.exitCh)
}

func reapPidfd(pidfd int) {
	var info unix.Siginfo
	_ = unix.Waitid(unix.P_PIDFD, pidfd, &info, unix.WEXITED, nil)
	_ = unix.Close(pidfd)
}

// Kill signals a running spawn. scope "process" signals only the leader (pidfd); "group" signals
// every process left in the leaf (module README "Kill").
func (l *Launcher) Kill(proc *Process, signalNameStr string, scope string) error {
	sig, ok := signalByName(signalNameStr)
	if !ok {
		return &Error{Code: protocol.ErrorBadRequest, Message: fmt.Sprintf("unsupported signal %q", signalNameStr)}
	}
	if scope == "process" {
		proc.pidfdMu.Lock()
		defer proc.pidfdMu.Unlock()
		if proc.pidfd < 0 {
			return nil // already reaped: a no-op, matching pidfd_send_signal's own behavior
		}
		if err := unix.PidfdSendSignal(proc.pidfd, sig, nil, 0); err != nil && err != unix.ESRCH {
			return internalErr("kill", err)
		}
		return nil
	}
	l.killGroup(proc.leafPath, sig)
	return nil
}

// killGroup signals every process currently in the leaf. For SIGKILL it freezes the leaf first so
// nothing can fork away between listing cgroup.procs and signalling, and loops (re-verifying each
// pid's cgroup membership before signalling it, since pidfd_open+re-check makes pid reuse
// harmless) until the leaf reports empty or 10 rounds pass.
func (l *Launcher) killGroup(leafPath string, sig syscall.Signal) {
	freeze := sig == syscall.SIGKILL
	for round := 0; round < 10; round++ {
		if freeze {
			_ = cgroup.Freeze(leafPath, true)
		}
		pids, err := cgroup.Procs(leafPath)
		if err != nil || len(pids) == 0 {
			if freeze {
				_ = cgroup.Freeze(leafPath, false)
			}
			return
		}
		for _, pid := range pids {
			pidfd, err := unix.PidfdOpen(pid, 0)
			if err != nil {
				continue
			}
			owner, err := cgroup.OwnCgroup(pid)
			if err != nil || owner != leafPath {
				_ = unix.Close(pidfd)
				continue
			}
			_ = unix.PidfdSendSignal(pidfd, sig, nil, 0)
			_ = unix.Close(pidfd)
		}
		if freeze {
			_ = cgroup.Freeze(leafPath, false)
		}
		populated, err := cgroup.Populated(leafPath)
		if err == nil && !populated {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Release is called when a spawn's connection closes, or once the leader has exited and both
// piped output streams reached EOF (module README "Lifetime", D4): nothing a tool call starts
// outlives it. It force-kills whatever remains in the leaf and removes it.
func (l *Launcher) Release(proc *Process) {
	l.killGroup(proc.leafPath, syscall.SIGKILL)
	// killGroup already waits for the leaf to report empty (or gives up after 10 rounds), but
	// rmdir can still race the kernel's own bookkeeping by a beat; retry briefly rather than
	// leaking the leaf directory for the life of the helper process.
	var err error
	for attempt := 0; attempt < 10; attempt++ {
		if err = cgroup.RemoveLeaf(proc.leafPath); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "{\"event\":\"leaf_remove_failed\",\"spawn\":%q,\"error\":%q}\n", proc.ID, err.Error())
	}
	l.mu.Lock()
	delete(l.live, proc.ID)
	l.mu.Unlock()
}

// Shutdown force-kills and removes every live spawn's leaf. Called on helper shutdown (SIGTERM
// from the entrypoint): "close the listener, kill all leaves, exit" (module README "Lifetime").
func (l *Launcher) Shutdown() {
	l.mu.Lock()
	procs := make([]*Process, 0, len(l.live))
	for _, proc := range l.live {
		if proc != nil {
			procs = append(procs, proc)
		}
	}
	l.mu.Unlock()
	for _, proc := range procs {
		l.Release(proc)
	}
}

func ioPipe(mode StdioMode, input bool) (child *os.File, parent *os.File, err error) {
	if mode == StdioNull {
		flag := os.O_RDONLY
		if !input {
			flag = os.O_WRONLY
		}
		f, err := os.OpenFile(os.DevNull, flag, 0)
		if err != nil {
			return nil, nil, err
		}
		return f, nil, nil
	}
	r, w, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	if input {
		return r, w, nil
	}
	return w, r, nil
}

func signalName(sig syscall.Signal) string {
	switch sig {
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGHUP:
		return "SIGHUP"
	case syscall.SIGQUIT:
		return "SIGQUIT"
	case syscall.SIGUSR1:
		return "SIGUSR1"
	case syscall.SIGUSR2:
		return "SIGUSR2"
	default:
		return sig.String()
	}
}
