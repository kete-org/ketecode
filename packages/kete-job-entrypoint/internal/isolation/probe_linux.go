//go:build linux

package isolation

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

// SysNet is the real Net: plain sockets and open(2), as whoever runs it.
type SysNet struct{}

// inconclusive marks resource errors: the attempt said nothing about the target.
func inconclusive(err error) error {
	for _, e := range []error{unix.EMFILE, unix.ENFILE, unix.ENOBUFS, unix.ENOMEM} {
		if errors.Is(err, e) {
			return fmt.Errorf("%w: %w", ErrInconclusive, err)
		}
	}
	return err
}

func (SysNet) DialTCP(ctx context.Context, addr string) error {
	c, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return inconclusive(err)
	}
	return c.Close()
}

// DialUnix counts EAGAIN as reached: the kernel checks permission before the backlog, so a full
// backlog means the connect was allowed.
func (SysNet) DialUnix(ctx context.Context, path string) error {
	c, err := (&net.Dialer{}).DialContext(ctx, "unix", path)
	if errors.Is(err, unix.EAGAIN) {
		return nil
	}
	if err != nil {
		return inconclusive(err)
	}
	return c.Close()
}

// dnsQuery asks for kete-isolation-probe.invalid A, recursion desired.
var dnsQuery = func() []byte {
	q := []byte{0x4b, 0x45, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, label := range []string{"kete-isolation-probe", "invalid"} {
		q = append(q, byte(len(label)))
		q = append(q, label...)
	}
	return append(q, 0, 0, 1, 0, 1)
}()

// ExchangeDNS returns nil when any datagram comes back: a resolver answered (even with an error
// rcode), so it is reachable.
func (SysNet) ExchangeDNS(ctx context.Context, addr string) error {
	c, err := (&net.Dialer{}).DialContext(ctx, "udp", addr)
	if err != nil {
		return inconclusive(err)
	}
	defer c.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	}
	if _, err := c.Write(dnsQuery); err != nil {
		return err
	}
	buf := make([]byte, 512)
	if _, err := c.Read(buf); err != nil {
		return err
	}
	return nil
}

func (SysNet) OpenDir(path string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return inconclusive(err)
	}
	return unix.Close(fd)
}

// OpenFile opens path read-only without following a final symlink; O_NONBLOCK so a FIFO or a
// device never blocks the attempt, O_NOCTTY so a terminal never becomes the probe's.
func (SysNet) OpenFile(path string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return inconclusive(err)
	}
	return unix.Close(fd)
}

// RunProbe is entered from main when os.Args[1] == ProbeArg (stage 2 has already dropped to the
// tool user): it reads the request from fd 3, runs it, writes the answer (one code and a newline)
// to stdout and exits 0. It never returns.
func RunProbe() {
	f := os.NewFile(3, "request")
	req, err := DecodeRequest(f)
	_ = f.Close()
	ans := phaselog.CodeProbe
	if err == nil {
		ans = Check(context.Background(), req, SysNet{})
	}
	_, _ = os.Stdout.Write([]byte(string(ans) + "\n"))
	os.Exit(0)
}

// Options say how the probe is launched: as the tool user, the way the helper runs a tool (its
// uid, the job group as its only gid, no supplementary groups, no_new_privs), in its cgroup.
type Options struct {
	Exe       string // re-executed twice: as launch stage 2, then as the probe (/proc/self/exe)
	CgroupDir string // empty keeps the caller's
	UID, GID  uint32
	Timeout   time.Duration // the whole run, launch to answer; past it the probe is killed
}

// Run launches the probe with req and returns nil when every probe passed, else a *Failure.
func Run(ctx context.Context, o Options, req Request) error {
	body, err := EncodeRequest(req)
	if err != nil {
		return &Failure{Reason: phaselog.CodeProbe, Err: err}
	}
	if o.Timeout <= 0 {
		o.Timeout = DefaultDeadline + 10*time.Second
	}
	reqR, reqW, err := os.Pipe()
	if err != nil {
		return &Failure{Reason: phaselog.CodeProbe, Err: err}
	}
	defer reqW.Close()
	outR, outW, err := os.Pipe()
	if err != nil {
		reqR.Close()
		return &Failure{Reason: phaselog.CodeProbe, Err: err}
	}
	defer outR.Close()
	p, err := launch.Start(launch.Options{Exe: o.Exe, CgroupDir: o.CgroupDir, Stdout: outW, Extra: []*os.File{reqR}}, launch.Spec{
		Path: o.Exe, Argv: []string{o.Exe, ProbeArg}, Env: []string{"PATH=/usr/bin:/bin"},
		UID: o.UID, GID: o.GID, Groups: []uint32{}, OOMScoreAdj: 0, Umask: 0o077, NoNewPrivs: true, Dir: "/",
	})
	reqR.Close()
	outW.Close()
	if err != nil {
		return &Failure{Reason: phaselog.CodeProbe, Err: err}
	}
	defer p.Wait(time.Second)
	go func() {
		_, _ = reqW.Write(body)
		_ = reqW.Close()
	}()
	deadline := time.Now().Add(o.Timeout)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	_ = outR.SetReadDeadline(deadline)
	// Cancellation (SIGTERM aborts the job) interrupts the read at once and kills the probe.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-ctx.Done():
			p.Signal(unix.SIGKILL)
			_ = outR.SetReadDeadline(time.Now())
		case <-stop:
		}
	}()
	out, err := io.ReadAll(io.LimitReader(outR, 64))
	if err != nil {
		p.Signal(unix.SIGKILL)
		if ctx.Err() != nil {
			return &Failure{Reason: phaselog.CodeProbe, Err: ctx.Err()}
		}
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return &Failure{Reason: phaselog.CodeProbe, Err: context.DeadlineExceeded}
		}
		return &Failure{Reason: phaselog.CodeProbe, Err: err}
	}
	select {
	case <-p.Done():
	case <-ctx.Done():
		p.Signal(unix.SIGKILL)
		return &Failure{Reason: phaselog.CodeProbe, Err: ctx.Err()}
	case <-time.After(time.Until(deadline)):
		p.Signal(unix.SIGKILL)
		return &Failure{Reason: phaselog.CodeProbe, Err: context.DeadlineExceeded}
	}
	if code := p.ExitCode(); code != 0 {
		return &Failure{Reason: phaselog.CodeProbe, Err: exitError(code)}
	}
	ans := ParseAnswer(bytes.TrimSpace(out))
	if ans == OK {
		return nil
	}
	return &Failure{Reason: ans}
}

type exitError int

func (e exitError) Error() string { return "isolation probe exited " + strconv.Itoa(int(e)) }

// ErrorClass is the fixed phase-log class.
func (e exitError) ErrorClass() (string, int) { return "exit", int(e) }

// ControlListeners are the root-owned listeners the controls connect to: TCP on an unprivileged
// loopback port the firewall lets the tool user reach, and an abstract unix socket (no file, so no
// mode; anyone in the network namespace may connect). Accepted connections are closed at once.
type ControlListeners struct {
	TCP, Unix net.Listener
}

// TCPAddr and UnixName are the control targets.
func (c *ControlListeners) TCPAddr() string  { return c.TCP.Addr().String() }
func (c *ControlListeners) UnixName() string { return c.Unix.Addr().String() }

// Close closes both.
func (c *ControlListeners) Close() {
	_ = c.TCP.Close()
	_ = c.Unix.Close()
}

// Listen opens the control listeners. The caller closes them after Run.
func Listen() (*ControlListeners, error) {
	t, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Close()
		return nil, err
	}
	u, err := net.Listen("unix", "@kete-isolation-control-"+hex.EncodeToString(nonce[:]))
	if err != nil {
		t.Close()
		return nil, err
	}
	for _, ln := range []net.Listener{t, u} {
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				_ = c.Close()
			}
		}()
	}
	return &ControlListeners{TCP: t, Unix: u}, nil
}
