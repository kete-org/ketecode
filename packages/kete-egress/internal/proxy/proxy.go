// Package proxy is the TLS-terminating egress proxy (module README "Security model"; ADR 0019
// rule 4). It serves three loopback listeners — port A for the kete user, B for the tool user and
// R for root — and for each accepted connection: checks the peer's uid, reads one
// `CONNECT host:443`, checks the host against the current phase's allowlist for that port,
// terminates TLS with a leaf from the per-VM CA (the SNI must equal the CONNECT host), then serves
// HTTP/1.1 requests whose Host must equal the CONNECT host, forwarding each to that host — resolved
// and dialled by the proxy itself, verified against the system roots — never to a client-supplied
// Host.
package proxy

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/blocked"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/ca"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/control"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/peeruid"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/policy"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/registry"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/reqlog"
)

// Deps is everything the proxy needs, built by main from the configuration and the inherited fds.
type Deps struct {
	Config    *config.Config
	Listeners map[config.Port]net.Listener
	Log       *reqlog.Log
	CA        *ca.CA
	Phase     *phase.State
	// Fatal is called on an unrecoverable runtime failure (a listener dying); main exits 1.
	Fatal func(error)
	// UpstreamRoots verifies upstream servers. main passes the system roots, loaded before the
	// job CA exists, so the job CA can never verify an upstream, plus a v2 configuration's
	// upstream.ca_bundle_file. Required.
	UpstreamRoots *x509.CertPool
	// ProxyAuth is `username:password` for the v2 upstream proxy (from upstream.proxy_auth_file;
	// "" none). Never logged.
	ProxyAuth string
}

// Proxy is one running proxy.
type Proxy struct {
	cfg       *config.Config
	policy    *policy.Policy
	registry  *registry.Rules
	log       *reqlog.Log
	ca        *ca.CA
	phase     *phase.State
	listeners map[config.Port]net.Listener
	rproxies  map[config.Port]*httputil.ReverseProxy
	fatal     func(error)

	// Seams for in-package tests only; New never changes them from the production defaults.
	peerUID       func(client, listener netip.AddrPort) (uint32, error)
	resolve       func(ctx context.Context, host string) ([]netip.Addr, error)
	isBlocked     func(netip.Addr) bool
	isForbidden   func(netip.Addr) bool
	upstreamRoots *x509.CertPool
	upstreamPort  int
	// upstreamProxyPort replaces the v2 upstream proxy's port when dialling (in-package tests).
	upstreamProxyPort int
	proxyAuth         string
	// proxyAuthBlockedUntil (UnixNano) is the 407 breaker: upstream dials fail fast until then.
	proxyAuthBlockedUntil atomic.Int64
	streamIdle            time.Duration
	transports            map[config.Port]*http.Transport

	mu      sync.Mutex
	conns   map[*clientConn]struct{}
	perPort map[config.Port]int
	closed  bool

	requests atomic.Int64
	refused  atomic.Int64
	wg       sync.WaitGroup // accept loops
	handlers sync.WaitGroup // connection handlers
}

// closeWait bounds how long Close waits for in-flight handlers to write their log lines.
const closeWait = 5 * time.Second

type option func(*Proxy)

// New builds a proxy; Serve starts it.
func New(d Deps) (*Proxy, error) {
	return newProxy(d)
}

func newProxy(d Deps, opts ...option) (*Proxy, error) {
	if d.Config == nil || d.Log == nil || d.CA == nil || d.Phase == nil || d.UpstreamRoots == nil {
		return nil, errors.New("proxy: incomplete dependencies")
	}
	for _, port := range config.Ports {
		if d.Listeners[port] == nil {
			return nil, fmt.Errorf("proxy: no listener for port %s", port)
		}
	}
	reg, err := registry.NewRules(d.Config.Registries, d.Config.Limits.RegistryRequests)
	if err != nil {
		return nil, err
	}
	p := &Proxy{
		cfg:           d.Config,
		policy:        policy.New(d.Config),
		registry:      reg,
		log:           d.Log,
		ca:            d.CA,
		phase:         d.Phase,
		listeners:     d.Listeners,
		fatal:         d.Fatal,
		peerUID:       peeruid.Lookup,
		resolve:       newResolver(d.Config.Resolvers),
		isBlocked:     blocked.Contains,
		isForbidden:   blocked.IsForbidden,
		upstreamRoots: d.UpstreamRoots,
		proxyAuth:     d.ProxyAuth,
		upstreamPort:  443,
		streamIdle:    StreamIdle,
		conns:         map[*clientConn]struct{}{},
		perPort:       map[config.Port]int{},
	}
	if p.fatal == nil {
		p.fatal = func(error) {}
	}
	for _, o := range opts {
		o(p)
	}
	p.transports = map[config.Port]*http.Transport{}
	p.rproxies = map[config.Port]*httputil.ReverseProxy{}
	for _, port := range config.Ports {
		tr := p.newTransport()
		p.transports[port] = tr
		p.rproxies[port] = p.newReverseProxy(tr)
	}
	return p, nil
}

// Serve starts an accept loop per listener and returns at once.
func (p *Proxy) Serve() {
	for _, port := range config.Ports {
		p.wg.Add(1)
		go p.acceptLoop(port, p.listeners[port])
	}
}

// Close stops accepting, closes every client connection, waits (at most closeWait) for the
// handlers to finish so their log lines are written, then writes a summary line for every port
// with rate-limited refusals not yet reported.
func (p *Proxy) Close() {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
	for _, ln := range p.listeners {
		_ = ln.Close()
	}
	p.wg.Wait() // no accept loop can start a handler after this
	p.mu.Lock()
	for cc := range p.conns {
		_ = cc.raw.Close()
	}
	p.mu.Unlock()
	done := make(chan struct{})
	go func() { p.handlers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(closeWait):
	}
	p.log.FlushSuppressed()
	for _, tr := range p.transports {
		tr.CloseIdleConnections()
	}
}

// SetPhase moves to next and closes every open connection whose (port, host) the new phase no
// longer allows. It returns how many it closed.
func (p *Proxy) SetPhase(next phase.Phase) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.phase.Set(next); err != nil {
		return 0, err
	}
	n := 0
	for cc := range p.conns {
		if cc.host != "" && !p.policy.Allowed(next, cc.port, cc.host) {
			_ = cc.raw.Close()
			n++
		}
	}
	return n, nil
}

// Stats is the "stats" control reply.
func (p *Proxy) Stats() control.Stats {
	return control.Stats{
		Requests:         p.requests.Load(),
		Refused:          p.refused.Load(),
		RegistryRequests: p.registry.Count(),
		LogBytes:         p.log.Written(),
		LogFull:          p.log.Full(),
		JobLogFull:       p.log.JobFull(),
	}
}

func (p *Proxy) acceptLoop(port config.Port, ln net.Listener) {
	defer p.wg.Done()
	backoff := time.Duration(0)
	for {
		c, err := ln.Accept()
		if err != nil {
			p.mu.Lock()
			closed := p.closed
			p.mu.Unlock()
			if closed {
				return
			}
			if temporaryAcceptError(err) {
				if backoff == 0 {
					backoff = acceptBackoffMin
				} else if backoff *= 2; backoff > acceptBackoffMax {
					backoff = acceptBackoffMax
				}
				time.Sleep(backoff)
				continue
			}
			p.fatal(fmt.Errorf("accept on port %s: %w", port, err))
			return
		}
		backoff = 0
		p.handlers.Add(1)
		go func() {
			defer p.handlers.Done()
			p.handle(port, c)
		}()
	}
}

func temporaryAcceptError(err error) bool {
	for _, e := range []syscall.Errno{syscall.EMFILE, syscall.ENFILE, syscall.ENOBUFS, syscall.ENOMEM, syscall.ECONNABORTED, syscall.EINTR} {
		if errors.Is(err, e) {
			return true
		}
	}
	return false
}

// clientConn is one accepted client connection.
type clientConn struct {
	raw  net.Conn
	port config.Port
	host string // the CONNECT host, once admitted (guarded by Proxy.mu)
}

func (p *Proxy) admit(cc *clientConn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || len(p.conns) >= MaxConnsTotal || p.perPort[cc.port] >= MaxConnsPerPort[cc.port] {
		return false
	}
	p.conns[cc] = struct{}{}
	p.perPort[cc.port]++
	return true
}

func (p *Proxy) release(cc *clientConn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.conns[cc]; ok {
		delete(p.conns, cc)
		p.perPort[cc.port]--
	}
}

// bindHost records host on cc if the current phase allows it, atomically with SetPhase, so a
// phase change can't slip between the allowlist check and the registration.
func (p *Proxy) bindHost(cc *clientConn, host string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.policy.Allowed(p.phase.Get(), cc.port, host) {
		return false
	}
	cc.host = host
	return true
}

func (p *Proxy) entry(port config.Port, method, host, target string) reqlog.Entry {
	return reqlog.Entry{
		Phase:  string(p.phase.Get()),
		User:   port.String(),
		Port:   p.cfg.Ports[port],
		Method: method,
		Host:   host,
		Path:   logPath(target),
	}
}

// refuseLog counts a refusal and writes its line, rate-limited per port (nothing is written once
// the log is full).
func (p *Proxy) refuseLog(e reqlog.Entry, status int, reason string) {
	p.refused.Add(1)
	e.Status = status
	e.Reason = reason
	_ = p.log.Refusal(int(e.Port), e.User == config.PortRoot.String(), e)
}

// logPath is the request target without its query, never logged.
func logPath(target string) string {
	for i := 0; i < len(target); i++ {
		if target[i] == '?' {
			return target[:i]
		}
	}
	return target
}

var discardLog = log.New(io.Discard, "", 0)
