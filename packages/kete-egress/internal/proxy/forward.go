package proxy

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/hostname"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/policy"
)

func http1Only() *http.Protocols {
	var p http.Protocols
	p.SetHTTP1(true)
	return &p
}

// serveHTTP serves the requests on one terminated client connection (D6: HTTP/1.1 only).
func (p *Proxy) serveHTTP(cc *clientConn, tc *tls.Conn) {
	ln := newOneConnListener(tc)
	srv := &http.Server{
		Handler:           p.handler(cc),
		ReadHeaderTimeout: RequestHeaderTime,
		IdleTimeout:       ClientIdle,
		MaxHeaderBytes:    RequestHeaderBytes,
		ErrorLog:          discardLog,
		Protocols:         http1Only(),
		// "OPTIONS *" must reach the handler (and be refused), not Go's built-in answer.
		DisableGeneralOptionsHandler: true,
		ConnState: func(_ net.Conn, s http.ConnState) {
			if s == http.StateClosed || s == http.StateHijacked {
				_ = ln.Close()
			}
		},
	}
	_ = srv.Serve(ln)
}

type ctxKey struct{}

// fwdInfo carries the connection's CONNECT host into the reverse proxy, and the upstream
// failure reason back out.
type fwdInfo struct {
	host   string
	reason string
}

// handler checks every request on the connection, in order, then forwards it.
func (p *Proxy) handler(cc *clientConn) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := cc.host
		e := p.entry(cc.port, r.Method, host, r.RequestURI)
		refuse := func(status int, reason string) {
			w.Header().Set("Connection", "close")
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(status)
			p.refuseLog(e, status, reason)
		}
		if r.ProtoMajor != 1 || r.ProtoMinor != 1 {
			refuse(http.StatusHTTPVersionNotSupported, policy.ReasonProtocol)
			return
		}
		if !strings.HasPrefix(r.RequestURI, "/") {
			refuse(http.StatusBadRequest, policy.ReasonTarget)
			return
		}
		// The domain-fronting check, on every request of the connection.
		if h, err := hostname.HostHeader(r.Host); err != nil || h != host {
			refuse(http.StatusMisdirectedRequest, policy.ReasonHostMismatch)
			return
		}
		// Phases change mid-connection: check the current one again.
		if !p.policy.Allowed(p.phase.Get(), cc.port, host) {
			refuse(http.StatusForbidden, policy.ReasonNotAllowed)
			return
		}
		if r.Header.Get("Upgrade") != "" || headerHasToken(r.Header, "Connection", "upgrade") {
			refuse(http.StatusForbidden, policy.ReasonUpgrade)
			return
		}
		if p.registry.IsRegistry(host) {
			if status, reason := p.registry.Check(host, r); status != 0 {
				refuse(status, reason)
				return
			}
		}
		if r.ContentLength > MaxRequestBody {
			refuse(http.StatusRequestEntityTooLarge, policy.ReasonBodyTooLarge)
			return
		}
		res, err := p.log.Reserve(cc.port == config.PortRoot)
		if err != nil {
			refuse(http.StatusServiceUnavailable, policy.ReasonLogFull)
			return
		}
		p.requests.Add(1)

		body := &countingReader{r: http.MaxBytesReader(w, r.Body, MaxRequestBody)}
		r.Body = body
		info := &fwdInfo{host: host}
		cw := &countingWriter{ResponseWriter: w}
		p.rproxies[cc.port].ServeHTTP(cw, r.WithContext(context.WithValue(r.Context(), ctxKey{}, info)))

		e.Status = cw.status
		if e.Status == 0 {
			e.Status = http.StatusOK
		}
		e.ReqBytes = body.n
		e.RespBytes = cw.n
		e.Reason = info.reason
		res.Write(e)
	})
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, t := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), token) {
				return true
			}
		}
	}
	return false
}

func (p *Proxy) newTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 nil, // never HTTPS_PROXY from the environment
		DialContext:           p.dialUpstream,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: p.upstreamRoots},
		ForceAttemptHTTP2:     false,
		Protocols:             http1Only(),
		DisableCompression:    true,
		TLSHandshakeTimeout:   UpstreamTLSTimeout,
		ResponseHeaderTimeout: UpstreamHeaderTime,
		IdleConnTimeout:       UpstreamIdle,
		MaxConnsPerHost:       UpstreamConnsPerHost,
	}
}

// newReverseProxy forwards to the connection's CONNECT host only — never to r.Host — adds no
// X-Forwarded-* headers, streams responses unbuffered (SSE) and never follows redirects.
func (p *Proxy) newReverseProxy(tr *http.Transport) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			info := pr.In.Context().Value(ctxKey{}).(*fwdInfo)
			pr.Out.URL.Scheme = "https"
			pr.Out.URL.Host = info.host
			pr.Out.Host = info.host
			pr.Out.Header.Del("Proxy-Authorization")
			pr.Out.Header.Del("Proxy-Connection")
		},
		Transport:     tr,
		FlushInterval: -1,
		ErrorLog:      discardLog,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			info, _ := r.Context().Value(ctxKey{}).(*fwdInfo)
			status, reason := http.StatusBadGateway, policy.ReasonUpstream
			var de *dialError
			var mbe *http.MaxBytesError
			switch {
			case errors.As(err, &de):
				reason = de.reason
			case errors.As(err, &mbe):
				status, reason = http.StatusRequestEntityTooLarge, policy.ReasonBodyTooLarge
			}
			if info != nil {
				info.reason = reason
			}
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(status)
		},
	}
}

type countingReader struct {
	r io.ReadCloser
	n int64
}

func (c *countingReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.n += int64(n)
	return n, err
}

func (c *countingReader) Close() error { return c.r.Close() }

type countingWriter struct {
	http.ResponseWriter
	status int
	n      int64
}

func (c *countingWriter) WriteHeader(status int) {
	if c.status == 0 && status >= 200 {
		c.status = status
	}
	c.ResponseWriter.WriteHeader(status)
}

func (c *countingWriter) Write(b []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	n, err := c.ResponseWriter.Write(b)
	c.n += int64(n)
	return n, err
}

// Unwrap lets http.ResponseController reach the real writer's Flush (FlushInterval -1).
func (c *countingWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }
