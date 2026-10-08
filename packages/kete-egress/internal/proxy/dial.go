package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/policy"
)

// dialError carries the log reason for an upstream dial failure.
type dialError struct {
	reason string
	err    error
}

func (e *dialError) Error() string { return fmt.Sprintf("%s: %v", e.reason, e.err) }
func (e *dialError) Unwrap() error { return e.err }

var errBlocked = errors.New("destination is in a blocked range")

// newResolver resolves names only through servers (the configuration's resolvers, never
// /etc/resolv.conf's nameservers). Names are queried rooted ("name.") so no search list applies.
func newResolver(servers []netip.AddrPort) func(ctx context.Context, host string) ([]netip.Addr, error) {
	var next atomic.Uint32
	r := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			s := servers[int(next.Add(1)-1)%len(servers)]
			d := net.Dialer{Timeout: ResolveTimeout}
			return d.DialContext(ctx, network, s.String())
		},
	}
	return func(ctx context.Context, host string) ([]netip.Addr, error) {
		ctx, cancel := context.WithTimeout(ctx, ResolveTimeout)
		defer cancel()
		return r.LookupNetIP(ctx, "ip", host+".")
	}
}

// addrAllowed is the per-connection address rule: v1 refuses every blocked address (the port is
// always 443); v2 adds the forbidden and the internal ranges.
func (p *Proxy) addrAllowed(a netip.Addr, port uint16) bool {
	a = a.Unmap()
	if p.cfg.Version != config.VersionV2 {
		return !p.isBlocked(a)
	}
	// egress-config-v2.md "Behaviour": a forbidden address is refused whatever else says; one
	// inside an internal range is allowed on exactly that range's ports; any other blocked address
	// is refused; the rest only on 443.
	if p.isForbidden(a) {
		return false
	}
	for _, r := range p.cfg.Internal {
		if r.Prefix.Contains(a) {
			return slices.Contains(r.Ports, port)
		}
	}
	return !p.isBlocked(a) && port == 443
}

// usableAddrs resolves host (or takes an IPv4 literal) and keeps the addresses the rules allow on
// port, in order.
func (p *Proxy) usableAddrs(ctx context.Context, host string, port uint16) ([]netip.Addr, error) {
	var addrs []netip.Addr
	if a, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{a}
	} else if addrs, err = p.resolve(ctx, host); err != nil {
		return nil, &dialError{policy.ReasonResolveFailure, err}
	}
	var usable []netip.Addr
	for _, a := range addrs {
		if a = a.Unmap(); p.addrAllowed(a, port) {
			usable = append(usable, a)
		}
	}
	if len(usable) == 0 {
		return nil, &dialError{policy.ReasonResolvedBlock, fmt.Errorf("%s: %w", host, errBlocked)}
	}
	return usable, nil
}

// dialAddrs dials the addresses in order on port; the dialer's Control hook re-checks the exact
// address being connected.
func (p *Proxy) dialAddrs(ctx context.Context, addrs []netip.Addr, port uint16, dialPort int) (net.Conn, error) {
	d := net.Dialer{
		Timeout: UpstreamDialTimeout,
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !p.addrAllowed(ap.Addr().Unmap(), port) {
				return errBlocked
			}
			return nil
		},
	}
	var lastErr error
	for _, a := range addrs {
		c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(a.String(), strconv.Itoa(dialPort)))
		if err == nil {
			return c, nil
		}
		lastErr = err
	}
	return nil, &dialError{policy.ReasonUpstream, lastErr}
}

// dialUpstream is the upstream transport's DialContext. addr is always the connection's allowlist
// entry as `host:port` (443 for a bare host), built by the reverse proxy from the connection
// state, never from a client's Host. The destination is resolved with the proxy's own resolver
// and every address the rules refuse is dropped — also when the connection then goes through the
// enterprise proxy (configuration v2 `upstream`), which only carries what is allowed anyway.
func (p *Proxy) dialUpstream(ctx context.Context, network, addr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, &dialError{policy.ReasonUpstream, err}
	}
	pn, err := strconv.Atoi(portStr)
	if err != nil || pn < 1 || pn > 65535 {
		return nil, &dialError{policy.ReasonUpstream, fmt.Errorf("bad port %q", portStr)}
	}
	port := uint16(pn)
	if p.cfg.Version != config.VersionV2 && port != 443 {
		return nil, &dialError{policy.ReasonUpstream, errors.New("configuration v1 dials port 443 only")}
	}
	usable, err := p.usableAddrs(ctx, host, port)
	if err != nil {
		return nil, err
	}
	if up := p.cfg.Upstream; up != nil && !up.Direct[config.Target{Host: host, Port: port}] {
		return p.dialViaUpstream(ctx, up, host, port)
	}
	dialPort := int(port)
	if port == 443 {
		dialPort = p.upstreamPort // 443 except in in-package tests
	}
	return p.dialAddrs(ctx, usable, port, dialPort)
}

// dialViaUpstream opens `CONNECT host:port` through the enterprise proxy (TLS to an https proxy,
// verified against the upstream roots) with the configured credentials, and returns the tunnel.
// Any answer but 2xx refuses the connection (no retry, no other credentials).
func (p *Proxy) dialViaUpstream(ctx context.Context, up *config.Upstream, host string, port uint16) (net.Conn, error) {
	proxyHost := up.Host
	if up.Addr.IsValid() {
		proxyHost = up.Addr.String()
	}
	addrs, err := p.usableAddrs(ctx, proxyHost, up.Port)
	if err != nil {
		var de *dialError
		if errors.As(err, &de) {
			return nil, &dialError{policy.ReasonUpstreamProxy, de.err}
		}
		return nil, &dialError{policy.ReasonUpstreamProxy, err}
	}
	dialPort := int(up.Port)
	if p.upstreamProxyPort != 0 {
		dialPort = p.upstreamProxyPort // in-package tests only
	}
	c, err := p.dialAddrs(ctx, addrs, up.Port, dialPort)
	if err != nil {
		var de *dialError
		if errors.As(err, &de) {
			return nil, &dialError{policy.ReasonUpstreamProxy, de.err}
		}
		return nil, &dialError{policy.ReasonUpstreamProxy, err}
	}
	if up.Scheme == "https" {
		tc := tls.Client(c, &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: p.upstreamRoots, ServerName: up.Host})
		hctx, cancel := context.WithTimeout(ctx, UpstreamTLSTimeout)
		err := tc.HandshakeContext(hctx)
		cancel()
		if err != nil {
			c.Close()
			return nil, &dialError{policy.ReasonUpstreamProxy, err}
		}
		c = tc
	}
	target := net.JoinHostPort(host, strconv.Itoa(int(port)))
	head := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if p.proxyAuth != "" {
		head += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(p.proxyAuth)) + "\r\n"
	}
	head += "\r\n"
	deadline := time.Now().Add(UpstreamHeaderTime)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = c.SetDeadline(deadline)
	if _, err := c.Write([]byte(head)); err != nil {
		c.Close()
		return nil, &dialError{policy.ReasonUpstreamProxy, err}
	}
	br := bufio.NewReaderSize(c, 4096)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		c.Close()
		return nil, &dialError{policy.ReasonUpstreamProxy, err}
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		c.Close()
		// Never the answer's body or headers: a proxy's error page may echo credentials.
		return nil, &dialError{policy.ReasonUpstreamProxy, fmt.Errorf("CONNECT answered %d", resp.StatusCode)}
	}
	_ = c.SetDeadline(time.Time{})
	if br.Buffered() > 0 {
		return &bufferedConn{Conn: c, r: br}, nil
	}
	return c, nil
}

// bufferedConn reads what the CONNECT answer's reader already buffered first.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.r.Read(b) }
