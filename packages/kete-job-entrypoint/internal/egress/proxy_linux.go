//go:build linux

package egress

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/setup"
)

// ApplyFirewall renders the ruleset with `kete-egress nft --config -`, installs it with
// `nft -f -` and checks it with `nft list table inet kete_egress`.
func ApplyFirewall(ctx context.Context, egressBin, nftBin string, cfg []byte, timeout time.Duration) error {
	run := func(stdin []byte, name string, args ...string) ([]byte, error) {
		cctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		cmd := exec.CommandContext(cctx, name, args...)
		cmd.Env = launch.StageEnv
		cmd.Stdin = bytes.NewReader(stdin)
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		return out.Bytes(), nil
	}
	rules, err := run(cfg, egressBin, "nft", "--config", "-")
	if err != nil {
		return err
	}
	if _, err := run(rules, nftBin, "-f", "-"); err != nil {
		return err
	}
	out, err := run(nil, nftBin, "list", "table", "inet", "kete_egress")
	if err != nil {
		return err
	}
	if !bytes.Contains(out, []byte("kete_egress")) {
		return errors.New("nft: table inet kete_egress is missing")
	}
	return nil
}

// Manager owns what root keeps across proxy instances: the three listeners and the request log.
type Manager struct {
	EgressBin  string
	LaunchExe  string
	CgroupDir  string
	ProxyUID   uint32
	ProxyGID   uint32
	StderrPath string
	CAPath     string
	Ready      time.Duration
	StopWait   time.Duration

	listeners []*os.File
	log       *os.File
}

// Open binds 127.0.0.1:{a,b,r} and opens the request log (root 0600, O_APPEND).
func (m *Manager) Open(ports [3]int, logPath string) error {
	for _, p := range ports {
		ln, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: p})
		if err != nil {
			m.Close()
			return err
		}
		f, err := ln.File()
		_ = ln.Close()
		if err != nil {
			m.Close()
			return err
		}
		m.listeners = append(m.listeners, f)
	}
	lf, err := setup.CreateRootFile(logPath, true)
	if err != nil {
		m.Close()
		return err
	}
	m.log = lf
	return nil
}

// Close releases the listeners and the log.
func (m *Manager) Close() {
	for _, f := range m.listeners {
		_ = f.Close()
	}
	m.listeners = nil
	if m.log != nil {
		_ = m.log.Close()
		m.log = nil
	}
}

// Proxy is one running instance.
type Proxy struct {
	proc    *launch.Process
	ctl     *os.File
	control *Control
	mu      sync.Mutex
	caPEM   []byte
	planned atomic.Bool
	stopped chan struct{}
	timeout time.Duration
	stopW   time.Duration
}

// Start launches an instance with cfg and waits for "ready"; it writes the CA to CAPath.
func (m *Manager) Start(cfg []byte) (*Proxy, error) {
	if len(m.listeners) != 3 || m.log == nil {
		return nil, errors.New("egress: manager not open")
	}
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	// Non-blocking, so the os.File uses the poller and read deadlines work.
	if err := syscall.SetNonblock(pair[0], true); err != nil {
		syscall.Close(pair[0])
		syscall.Close(pair[1])
		return nil, err
	}
	ours := os.NewFile(uintptr(pair[0]), "egress-ctl-root")
	theirs := os.NewFile(uintptr(pair[1]), "egress-ctl-proxy")
	defer theirs.Close()
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		ours.Close()
		return nil, err
	}
	defer stdinR.Close()
	go func() {
		_, _ = stdinW.Write(cfg)
		_ = stdinW.Close()
	}()
	errf, err := setup.CreateRootFile(m.StderrPath, true)
	if err != nil {
		ours.Close()
		return nil, err
	}
	defer errf.Close()
	extra := append(append([]*os.File{}, m.listeners...), m.log, theirs)
	proc, err := launch.Start(launch.Options{
		Exe: m.LaunchExe, CgroupDir: m.CgroupDir,
		Stdin: stdinR, Stdout: errf, Stderr: errf, Extra: extra, Timeout: m.Ready,
	}, launch.Spec{
		Path: m.EgressBin, Argv: []string{m.EgressBin, "serve", "--config", "-"},
		Env: launch.StageEnv, UID: m.ProxyUID, GID: m.ProxyGID, Groups: []uint32{},
		OOMScoreAdj: -1000, Umask: 0o077, NoNewPrivs: true, Dir: "/",
	})
	// Only the proxy may hold its end now: its exit must reach ours as EOF.
	_ = theirs.Close()
	_ = stdinR.Close()
	if err != nil {
		ours.Close()
		return nil, err
	}
	p := &Proxy{proc: proc, ctl: ours, control: NewControl(ours), stopped: make(chan struct{}), timeout: m.Ready, stopW: m.StopWait}
	_ = ours.SetDeadline(time.Now().Add(m.Ready))
	ca, err := p.control.ReadReady()
	_ = ours.SetDeadline(time.Time{})
	if err != nil {
		p.planned.Store(true)
		_ = ours.Close()
		proc.Wait(m.StopWait)
		return nil, err
	}
	p.caPEM = ca
	if err := setup.WriteFileAtomic(m.CAPath, ca, 0, 0, 0o644); err != nil {
		p.Stop()
		return nil, err
	}
	return p, nil
}

// CAPEM is this instance's CA certificate.
func (p *Proxy) CAPEM() []byte { return p.caPEM }

func (p *Proxy) call(fn func() error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	_ = p.ctl.SetDeadline(time.Now().Add(p.timeout))
	defer p.ctl.SetDeadline(time.Time{})
	return fn()
}

// Phase moves the instance forward.
func (p *Proxy) Phase(phase string) error {
	return p.call(func() error { return p.control.Phase(phase) })
}

// Stats asks for the counters.
func (p *Proxy) Stats() (Stats, error) {
	var s Stats
	err := p.call(func() error {
		var err error
		s, err = p.control.Stats()
		return err
	})
	return s, err
}

// Exited is closed when the proxy process has exited.
func (p *Proxy) Exited() <-chan struct{} { return p.proc.Done() }

// Planned reports whether the exit was asked for (Stop).
func (p *Proxy) Planned() bool { return p.planned.Load() }

// Stop closes the control socket (the proxy closes its connections and exits 0) and waits.
func (p *Proxy) Stop() {
	p.planned.Store(true)
	_ = p.ctl.Close()
	p.proc.Wait(p.stopW)
}

// Kill SIGKILLs the instance (tests: an unplanned proxy death).
func (p *Proxy) Kill() { p.proc.Signal(syscall.SIGKILL) }

// Pid is the proxy's pid.
func (p *Proxy) Pid() int { return p.proc.Pid }
