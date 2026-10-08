package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/textproto"
	"strings"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/hostname"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/policy"
)

// connectHead is the parsed CONNECT request line and headers.
type connectHead struct {
	method string
	target string
	proto  string
	header textproto.MIMEHeader
}

var errConnectTooLarge = errors.New("CONNECT head too large")

// readConnectHead reads one request head of at most ConnectHeaderBytes and returns it with any
// bytes the reader buffered past it (the start of the client's TLS handshake).
func readConnectHead(r io.Reader) (connectHead, []byte, error) {
	lr := &io.LimitedReader{R: r, N: ConnectHeaderBytes}
	br := bufio.NewReaderSize(lr, ConnectHeaderBytes)
	tp := textproto.NewReader(br)
	line, err := tp.ReadLine()
	if err != nil {
		if lr.N == 0 {
			return connectHead{}, nil, errConnectTooLarge
		}
		return connectHead{}, nil, err
	}
	parts := strings.Split(line, " ")
	if len(parts) != 3 {
		return connectHead{}, nil, fmt.Errorf("malformed request line %q", line)
	}
	h := connectHead{method: parts[0], target: parts[1], proto: parts[2]}
	hdr, err := tp.ReadMIMEHeader()
	if err != nil {
		if lr.N == 0 {
			return h, nil, errConnectTooLarge
		}
		return h, nil, err
	}
	h.header = hdr
	rest := make([]byte, br.Buffered())
	_, _ = io.ReadFull(br, rest)
	return h, rest, nil
}

// prefixConn replays bytes already read past the CONNECT head before reading the socket.
type prefixConn struct {
	net.Conn
	r io.Reader
}

func (c *prefixConn) Read(b []byte) (int, error) { return c.r.Read(b) }

func writeStatus(w io.Writer, status int) {
	_, _ = fmt.Fprintf(w, "HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", status, http.StatusText(status))
}

// handle runs one client connection from accept to close.
func (p *Proxy) handle(port config.Port, raw net.Conn) {
	cc := &clientConn{raw: raw, port: port}
	defer raw.Close()
	if !p.admit(cc) {
		p.refuseLog(p.entry(port, "CONNECT", "", ""), 0, policy.ReasonConnLimit)
		return
	}
	defer p.release(cc)

	// D5: the socket connecting to this port must belong to the port's user.
	if !p.peerOK(port, raw) {
		p.refuseLog(p.entry(port, "CONNECT", "", ""), 0, policy.ReasonPeerUID)
		return
	}

	_ = raw.SetDeadline(time.Now().Add(ConnectTimeout))
	head, rest, err := readConnectHead(raw)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errConnectTooLarge) {
			status = http.StatusRequestHeaderFieldsTooLarge
		}
		writeStatus(raw, status)
		p.refuseLog(p.entry(port, head.method, "", ""), status, policy.ReasonBadConnect)
		return
	}
	if head.method != http.MethodConnect {
		// Includes plain-HTTP absolute-form proxying: only CONNECT tunnels are served.
		writeStatus(raw, http.StatusMethodNotAllowed)
		p.refuseLog(p.entry(port, head.method, "", ""), http.StatusMethodNotAllowed, policy.ReasonUnsupported)
		return
	}
	authHost, _, _ := net.SplitHostPort(head.target)
	if head.proto != "HTTP/1.1" || head.header.Get("Content-Length") != "" || head.header.Get("Transfer-Encoding") != "" {
		writeStatus(raw, http.StatusBadRequest)
		p.refuseLog(p.entry(port, "CONNECT", authHost, ""), http.StatusBadRequest, policy.ReasonBadConnect)
		return
	}
	// host is the allowlist entry (v1: the host, port 443 only; v2: the bare host for 443, else
	// `host:port`); sniHost is its host name, which the TLS leaf and the SNI must name.
	host, sniHost, err := p.authority(head.target)
	if err != nil {
		reason := policy.ReasonBadHost
		if errors.Is(err, hostname.ErrPort) {
			reason = policy.ReasonPort
		}
		writeStatus(raw, http.StatusForbidden)
		p.refuseLog(p.entry(port, "CONNECT", authHost, ""), http.StatusForbidden, reason)
		return
	}
	if hosts := head.header.Values("Host"); len(hosts) > 0 {
		hh, err := p.hostHeader(hosts[0])
		if len(hosts) != 1 || err != nil || hh != host {
			writeStatus(raw, http.StatusBadRequest)
			p.refuseLog(p.entry(port, "CONNECT", host, ""), http.StatusBadRequest, policy.ReasonHostMismatch)
			return
		}
	}
	if p.log.FullFor(port == config.PortRoot) {
		writeStatus(raw, http.StatusServiceUnavailable)
		p.refused.Add(1)
		return
	}
	if !p.bindHost(cc, host) {
		writeStatus(raw, http.StatusForbidden)
		p.refuseLog(p.entry(port, "CONNECT", host, ""), http.StatusForbidden, policy.ReasonNotAllowed)
		return
	}
	if _, err := io.WriteString(raw, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		return
	}

	// Client-side TLS with a leaf for exactly the CONNECT host; the SNI must equal it.
	ic := newIdleConn(&prefixConn{Conn: raw, r: io.MultiReader(bytes.NewReader(rest), raw)})
	sniMismatch := false
	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
		// No resumption: every connection gets a full handshake, and so the SNI check.
		SessionTicketsDisabled: true,
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			sni, err := hostname.Normalize(hello.ServerName)
			if err != nil || sni != sniHost {
				sniMismatch = true
				return nil, fmt.Errorf("SNI %q is not the CONNECT host", hello.ServerName)
			}
			return p.ca.Leaf(sniHost)
		},
	}
	tc := tls.Server(ic, tlsCfg)
	ctx, cancel := context.WithTimeout(context.Background(), ClientTLSTimeout)
	err = tc.HandshakeContext(ctx)
	cancel()
	if err != nil {
		reason := policy.ReasonTLS
		if sniMismatch {
			reason = policy.ReasonSNIMismatch
		}
		p.refuseLog(p.entry(port, "CONNECT", host, ""), 0, reason)
		return
	}
	_ = raw.SetDeadline(time.Time{})

	stopWatch := ic.watch(p.streamIdle, func() {
		e := p.entry(port, "CONNECT", host, "")
		e.Reason = policy.ReasonIdle
		_ = p.log.Refusal(int(e.Port), port == config.PortRoot, e)
	})
	defer stopWatch()
	p.serveHTTP(cc, tc)
}

// authority parses a CONNECT target into its allowlist entry and host name: v1 accepts port 443
// only; v2 any port (whether the entry is allowed is the allowlist's question).
func (p *Proxy) authority(target string) (entry, host string, err error) {
	if p.cfg.Version == config.VersionV2 {
		return hostname.AuthorityEntry(target)
	}
	h, err := hostname.Authority(target)
	return h, h, err
}

// hostHeader parses a Host header into the allowlist spelling the CONNECT host has.
func (p *Proxy) hostHeader(v string) (string, error) {
	if p.cfg.Version == config.VersionV2 {
		return hostname.HostHeaderEntry(v)
	}
	return hostname.HostHeader(v)
}

func (p *Proxy) peerOK(port config.Port, raw net.Conn) bool {
	ra, ok1 := raw.RemoteAddr().(*net.TCPAddr)
	la, ok2 := raw.LocalAddr().(*net.TCPAddr)
	if !ok1 || !ok2 {
		return false
	}
	client := netip.AddrPortFrom(addrOf(ra), uint16(ra.Port))
	listener := netip.AddrPortFrom(addrOf(la), uint16(la.Port))
	uid, err := p.peerUID(client, listener)
	return err == nil && uid == p.cfg.UIDs.ForPort(port)
}

func addrOf(a *net.TCPAddr) netip.Addr {
	ad, _ := netip.AddrFromSlice(a.IP)
	return ad.Unmap()
}

// oneConnListener hands http.Server exactly one connection, then blocks until it's closed.
type oneConnListener struct {
	conn   net.Conn
	used   bool
	done   chan struct{}
	closed bool
	mu     chan struct{}
}

func newOneConnListener(c net.Conn) *oneConnListener {
	l := &oneConnListener{conn: c, done: make(chan struct{}), mu: make(chan struct{}, 1)}
	l.mu <- struct{}{}
	return l
}

func (l *oneConnListener) Accept() (net.Conn, error) {
	<-l.mu
	if !l.used {
		l.used = true
		l.mu <- struct{}{}
		return l.conn, nil
	}
	l.mu <- struct{}{}
	<-l.done
	return nil, net.ErrClosed
}

func (l *oneConnListener) Close() error {
	<-l.mu
	if !l.closed {
		l.closed = true
		close(l.done)
	}
	l.mu <- struct{}{}
	return nil
}

func (l *oneConnListener) Addr() net.Addr { return l.conn.LocalAddr() }
