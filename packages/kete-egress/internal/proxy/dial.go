package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"sync/atomic"
	"syscall"

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

// dialUpstream is the upstream transport's DialContext. addr is always "<CONNECT host>:443",
// built by the reverse proxy from the connection state, never from a client's Host. It resolves
// the name with the proxy's own resolver, drops every blocked address, and dials the rest in order;
// the dialer's Control hook re-checks the exact address being connected.
func (p *Proxy) dialUpstream(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, &dialError{policy.ReasonUpstream, err}
	}
	addrs, err := p.resolve(ctx, host)
	if err != nil {
		return nil, &dialError{policy.ReasonResolveFailure, err}
	}
	var usable []netip.Addr
	for _, a := range addrs {
		a = a.Unmap()
		if !p.isBlocked(a) {
			usable = append(usable, a)
		}
	}
	if len(usable) == 0 {
		return nil, &dialError{policy.ReasonResolvedBlock, fmt.Errorf("%s: %w", host, errBlocked)}
	}
	d := net.Dialer{
		Timeout: UpstreamDialTimeout,
		Control: func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || p.isBlocked(ap.Addr().Unmap()) {
				return errBlocked
			}
			return nil
		},
	}
	var lastErr error
	for _, a := range usable {
		c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(a.String(), strconv.Itoa(p.upstreamPort)))
		if err == nil {
			return c, nil
		}
		lastErr = err
	}
	return nil, &dialError{policy.ReasonUpstream, lastErr}
}
