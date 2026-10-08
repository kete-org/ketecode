package proxy

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/blocked"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/ca"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/reqlog"
)

const testConfig = `{
  "version": 1,
  "uids": { "proxy": 990, "kete": 991, "tool": 992 },
  "ports": { "kete": 81, "tool": 82, "root": 83 },
  "resolvers": ["198.51.100.53:53"],
  "phases": {
    "clone":  { "root": ["github.test"] },
    "agent":  { "kete": ["gateway.test", "platform.test", "front.test", "evil.test", "internal.test"], "tool": ["registry.npm.test"], "root": ["platform.test"] },
    "report": { "root": ["platform.test", "storage.test"] }
  },
  "registries": [ { "host": "registry.npm.test", "kind": "npm" } ]
}`

var upstreamNames = []string{"github.test", "gateway.test", "platform.test", "storage.test", "registry.npm.test", "front.test", "evil.test", "internal.test"}

// syncBuf is a concurrency-safe fake log fd.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// upstream is the fake internet: one TLS server answering for every test name (by SNI) and
// echoing back what it saw.
type upstream struct {
	srv  *httptest.Server
	pool *x509.CertPool
	mu   sync.Mutex
	seen []string // Host of every request
}

type echo struct {
	SNI     string `json:"sni"`
	Host    string `json:"host"`
	Method  string `json:"method"`
	Target  string `json:"target"`
	BodyLen int    `json:"body_len"`
	XFF     string `json:"xff"`
	ProxyAu string `json:"proxy_auth"`
}

// newUpstream starts the fake internet. leaf, if set, issues its certificates instead of the
// fake upstreams' own test CA.
func newUpstream(t *testing.T, leaf func(host string) (*tls.Certificate, error)) *upstream {
	t.Helper()
	testCA, err := ca.NewNamed("Test upstream CA", upstreamNames, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	u := &upstream{pool: x509.NewCertPool()}
	u.pool.AddCert(testCA.Cert())
	u.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.seen = append(u.seen, r.Host)
		u.mu.Unlock()
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://evil.test/", http.StatusFound)
			return
		}
		if r.URL.Path == "/stream" {
			w.Header().Set("Content-Type", "text/event-stream")
			for i := 0; i < 3; i++ {
				fmt.Fprintf(w, "data: %d\n\n", i)
				w.(http.Flusher).Flush()
				time.Sleep(20 * time.Millisecond)
			}
			return
		}
		_ = json.NewEncoder(w).Encode(echo{
			SNI: r.TLS.ServerName, Host: r.Host, Method: r.Method, Target: r.RequestURI, BodyLen: len(body),
			XFF: r.Header.Get("X-Forwarded-For"), ProxyAu: r.Header.Get("Proxy-Authorization"),
		})
	}))
	if leaf == nil {
		leaf = testCA.Leaf
	}
	u.srv.TLS = &tls.Config{GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
		return leaf(h.ServerName)
	}}
	u.srv.StartTLS()
	t.Cleanup(u.srv.Close)
	return u
}

func (u *upstream) sawHost(h string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	for _, s := range u.seen {
		if s == h {
			return true
		}
	}
	return false
}

type harness struct {
	p       *Proxy
	cfg     *config.Config
	log     *syncBuf
	addr    map[config.Port]string
	caPool  *x509.CertPool
	up      *upstream
	peerBad atomic.Bool
}

type hopts struct {
	logLimit int64
	noRoots  bool
	idle     time.Duration
	// jobCAUpstream: the upstream presents certificates from the proxy's own job CA, and the
	// proxy verifies against the system roots loaded before that CA existed (as serve does).
	jobCAUpstream bool
	// v2 turns the test configuration into a version 2 one before the proxy is built (proxy_v2_test.go).
	v2 func(t *testing.T, cfg *config.Config, upPort int)
	// proxyAuth is Deps.ProxyAuth; upstreamProxyPort the v2 upstream proxy's real port.
	proxyAuth         string
	upstreamProxyPort int
}

func newHarness(t *testing.T, o hopts) *harness {
	t.Helper()
	cfg, err := config.Parse(strings.NewReader(testConfig))
	if err != nil {
		t.Fatal(err)
	}
	var roots *x509.CertPool
	if o.jobCAUpstream {
		if roots, err = x509.SystemCertPool(); err != nil {
			t.Fatal(err)
		}
	}
	c, err := ca.New(cfg.AllHosts(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var leaf func(string) (*tls.Certificate, error)
	if o.jobCAUpstream {
		leaf = c.Leaf
	}
	up := newUpstream(t, leaf)
	switch {
	case o.noRoots:
		roots = x509.NewCertPool()
	case roots == nil:
		roots = up.pool
	}
	if o.v2 != nil {
		o.v2(t, cfg, up.srv.Listener.Addr().(*net.TCPAddr).Port)
	}
	h := &harness{cfg: cfg, log: &syncBuf{}, addr: map[config.Port]string{}, up: up}
	lns := map[config.Port]net.Listener{}
	for _, port := range config.Ports {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		lns[port] = ln
		h.addr[port] = ln.Addr().String()
	}
	limit := o.logLimit
	if limit == 0 {
		limit = config.DefaultLogMaxBytes
	}
	h.caPool = x509.NewCertPool()
	h.caPool.AddCert(c.Cert())
	upPort := up.srv.Listener.Addr().(*net.TCPAddr).Port
	opts := []option{func(p *Proxy) {
		p.peerUID = func(client, listener netip.AddrPort) (uint32, error) {
			if h.peerBad.Load() {
				return 12345, nil
			}
			for port, a := range h.addr {
				if a == listener.String() {
					return cfg.UIDs.ForPort(port), nil
				}
			}
			return 0, errors.New("unknown listener")
		}
		p.resolve = func(_ context.Context, host string) ([]netip.Addr, error) {
			if host == "internal.test" {
				return []netip.Addr{netip.MustParseAddr("10.9.9.9"), netip.MustParseAddr("fdaa::3")}, nil
			}
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		}
		// Loopback stands in for the internet here; every other blocked range stays blocked.
		p.isBlocked = func(a netip.Addr) bool { return !a.IsLoopback() && blocked.Contains(a) }
		p.isForbidden = func(a netip.Addr) bool { return !a.IsLoopback() && blocked.IsForbidden(a) }
		p.upstreamPort = upPort
		p.upstreamProxyPort = o.upstreamProxyPort
		if o.idle > 0 {
			p.streamIdle = o.idle
		}
	}}
	p, err := newProxy(Deps{
		Config:        cfg,
		Listeners:     lns,
		Log:           reqlog.New(h.log, 0, limit, func(err error) { t.Errorf("fatal log error: %v", err) }),
		CA:            c,
		Phase:         phase.NewState(),
		Fatal:         func(err error) { t.Errorf("fatal: %v", err) },
		UpstreamRoots: roots,
		ProxyAuth:     o.proxyAuth,
	}, opts...)
	if err != nil {
		t.Fatal(err)
	}
	p.Serve()
	t.Cleanup(p.Close)
	h.p = p
	return h
}

func (h *harness) phase(t *testing.T, ph phase.Phase) int {
	t.Helper()
	n, err := h.p.SetPhase(ph)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// client is a Go HTTP client using the proxy on port, trusting only the proxy's CA.
func (h *harness) client(port config.Port) *http.Client {
	pu, _ := url.Parse("http://" + h.addr[port])
	return &http.Client{
		Transport: &http.Transport{
			Proxy:           http.ProxyURL(pu),
			TLSClientConfig: &tls.Config{RootCAs: h.caPool},
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       10 * time.Second,
	}
}

// connect sends a raw CONNECT head and returns the conn, a reader and the status.
func (h *harness) connect(t *testing.T, port config.Port, head string) (net.Conn, *bufio.Reader, int) {
	t.Helper()
	c, err := net.Dial("tcp", h.addr[port])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(c, head); err != nil {
		return c, nil, -1
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
	if err != nil {
		return c, br, -1
	}
	return c, br, resp.StatusCode
}

func connectLine(host string) string {
	return "CONNECT " + host + ":443 HTTP/1.1\r\nHost: " + host + ":443\r\n\r\n"
}

// tunnel CONNECTs to host and completes TLS with sni.
func (h *harness) tunnel(t *testing.T, port config.Port, host, sni string) (*tls.Conn, error) {
	t.Helper()
	c, _, st := h.connect(t, port, connectLine(host))
	if st != 200 {
		t.Fatalf("CONNECT %s = %d", host, st)
	}
	tc := tls.Client(c, &tls.Config{ServerName: sni, RootCAs: h.caPool, InsecureSkipVerify: sni == "", NextProtos: []string{"http/1.1"}})
	return tc, tc.Handshake()
}

func rawRequest(t *testing.T, c io.ReadWriter, br *bufio.Reader, req string) (*http.Response, error) {
	t.Helper()
	if _, err := io.WriteString(c, req); err != nil {
		return nil, err
	}
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		return nil, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp, nil
}

func (h *harness) logLines(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, ln := range strings.Split(strings.TrimSpace(h.log.String()), "\n") {
		if ln == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(ln), &m); err != nil {
			t.Fatalf("bad log line %q", ln)
		}
		out = append(out, m)
	}
	return out
}

// waitLine polls the log for a line matching f: a request's line is written after its response
// has been sent, so a client can see the response before the line exists.
func (h *harness) waitLine(t *testing.T, f func(map[string]any) bool) map[string]any {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		for _, m := range h.logLines(t) {
			if f(m) {
				return m
			}
		}
		if time.Now().After(deadline) {
			return nil
		}
	}
}

func (h *harness) hasReason(t *testing.T, reason string) bool {
	t.Helper()
	return h.waitLine(t, func(m map[string]any) bool { return m["reason"] == reason }) != nil
}

func TestAllowedRequestForwardedToConnectHost(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	req, _ := http.NewRequest("POST", "https://gateway.test/v1/messages?beta=1", strings.NewReader("hello"))
	req.Header.Set("Proxy-Authorization", "Basic c2VjcmV0")
	resp, err := h.client(config.PortKete).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var e echo
	if err := json.NewDecoder(resp.Body).Decode(&e); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || e.SNI != "gateway.test" || e.Host != "gateway.test" || e.Method != "POST" || e.Target != "/v1/messages?beta=1" || e.BodyLen != 5 {
		t.Errorf("status %d echo %+v", resp.StatusCode, e)
	}
	if e.XFF != "" || e.ProxyAu != "" {
		t.Errorf("forwarded X-Forwarded-For=%q Proxy-Authorization=%q", e.XFF, e.ProxyAu)
	}
	if resp.TLS == nil || resp.TLS.PeerCertificates[0].Issuer.CommonName != "Kete job egress CA" {
		t.Error("the client's TLS wasn't terminated by the proxy CA")
	}
	last := h.waitLine(t, func(m map[string]any) bool { return m["path"] == "/v1/messages" })
	if last == nil || last["status"] != 200.0 || last["req_bytes"] != 5.0 || last["user"] != "kete" || last["port"] != 81.0 {
		t.Errorf("log line = %v", last)
	}
	if strings.Contains(h.log.String(), "beta=1") || strings.Contains(h.log.String(), "c2VjcmV0") {
		t.Error("query or header value logged")
	}
}

func TestTransportIgnoresEnvProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	h := newHarness(t, hopts{})
	for port, tr := range h.p.transports {
		if tr.Proxy != nil {
			t.Errorf("port %s transport has a Proxy func", port)
		}
	}
	h.phase(t, phase.Agent)
	resp, err := h.client(config.PortKete).Get("https://gateway.test/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status %d with HTTPS_PROXY set", resp.StatusCode)
	}
}

func TestConnectRefusals(t *testing.T) {
	h := newHarness(t, hopts{})
	// Phase none: nothing allowed.
	if _, _, st := h.connect(t, config.PortKete, connectLine("gateway.test")); st != 403 {
		t.Errorf("phase none: %d", st)
	}
	h.phase(t, phase.Agent)
	cases := []struct {
		name string
		port config.Port
		head string
		want int
	}{
		{"not allowed for port", config.PortKete, connectLine("github.test"), 403},
		{"tool to gateway", config.PortTool, connectLine("gateway.test"), 403},
		{"root to gateway", config.PortRoot, connectLine("gateway.test"), 403},
		{"port 80", config.PortKete, "CONNECT gateway.test:80 HTTP/1.1\r\n\r\n", 403},
		{"IP literal", config.PortKete, "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n", 403},
		{"IPv6 literal", config.PortKete, "CONNECT [::1]:443 HTTP/1.1\r\n\r\n", 403},
		{"trailing dot", config.PortKete, "CONNECT gateway.test.:443 HTTP/1.1\r\n\r\n", 403},
		{"suffix", config.PortKete, connectLine("x.gateway.test"), 403},
		{"Host header differs", config.PortKete, "CONNECT gateway.test:443 HTTP/1.1\r\nHost: platform.test:443\r\n\r\n", 400},
		{"two Host headers", config.PortKete, "CONNECT gateway.test:443 HTTP/1.1\r\nHost: gateway.test\r\nHost: gateway.test\r\n\r\n", 400},
		{"HTTP/1.0", config.PortKete, "CONNECT gateway.test:443 HTTP/1.0\r\n\r\n", 400},
		{"plain HTTP proxying", config.PortKete, "GET http://gateway.test/ HTTP/1.1\r\nHost: gateway.test\r\n\r\n", 405},
		{"CONNECT with a body", config.PortKete, "CONNECT gateway.test:443 HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc", 400},
		{"huge head", config.PortKete, "CONNECT gateway.test:443 HTTP/1.1\r\nX: " + strings.Repeat("a", 9000) + "\r\n\r\n", 431},
		{"garbage", config.PortKete, "\x16\x03\x01\x02\x00\x01\x00\x01\xfc\r\n\r\n", 400},
	}
	for _, c := range cases {
		if _, _, st := h.connect(t, c.port, c.head); st != c.want {
			t.Errorf("%s: %d, want %d", c.name, st, c.want)
		}
	}
	if !h.hasReason(t, "host_not_allowed") || !h.hasReason(t, "port") || !h.hasReason(t, "bad_host") {
		t.Error("refusal reasons missing from the log")
	}
	// Counted just after the status is written: poll.
	deadline := time.Now().Add(3 * time.Second)
	for h.p.Stats().Refused < int64(len(cases)) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if h.p.Stats().Refused < int64(len(cases)) {
		t.Errorf("refused = %d", h.p.Stats().Refused)
	}
}

func TestSNIMustEqualConnectHost(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	if _, err := h.tunnel(t, config.PortKete, "gateway.test", "platform.test"); err == nil {
		t.Error("SNI platform.test accepted on a gateway.test tunnel")
	}
	if _, err := h.tunnel(t, config.PortKete, "gateway.test", ""); err == nil {
		t.Error("no SNI accepted")
	}
	if !h.hasReason(t, "sni_mismatch") {
		t.Error("sni_mismatch not logged")
	}
	// ALPN h2 only: no common protocol.
	c, _, st := h.connect(t, config.PortKete, connectLine("gateway.test"))
	if st != 200 {
		t.Fatal(st)
	}
	tc := tls.Client(c, &tls.Config{ServerName: "gateway.test", RootCAs: h.caPool, NextProtos: []string{"h2"}})
	if err := tc.Handshake(); err == nil {
		t.Errorf("h2-only ALPN accepted (negotiated %q)", tc.ConnectionState().NegotiatedProtocol)
	}
}

func TestDomainFrontingAndKeepAliveHost(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	// CONNECT front.test, SNI front.test, Host evil.test (both allowed): 421, evil.test never
	// reaches the upstream.
	tc, err := h.tunnel(t, config.PortKete, "front.test", "front.test")
	if err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(tc)
	resp, err := rawRequest(t, tc, br, "GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n")
	if err != nil || resp.StatusCode != 421 {
		t.Fatalf("fronting: %v %v", resp, err)
	}
	if h.up.sawHost("evil.test") {
		t.Error("upstream saw evil.test")
	}
	// Second request on a keep-alive connection with a different Host.
	tc, err = h.tunnel(t, config.PortKete, "gateway.test", "gateway.test")
	if err != nil {
		t.Fatal(err)
	}
	br = bufio.NewReader(tc)
	if resp, err := rawRequest(t, tc, br, "GET /one HTTP/1.1\r\nHost: gateway.test\r\n\r\n"); err != nil || resp.StatusCode != 200 {
		t.Fatalf("first request: %v %v", resp, err)
	}
	if resp, err := rawRequest(t, tc, br, "GET /two HTTP/1.1\r\nHost: platform.test\r\n\r\n"); err != nil || resp.StatusCode != 421 {
		t.Fatalf("second request: %v %v", resp, err)
	}
	if h.up.sawHost("platform.test") {
		t.Error("upstream saw platform.test")
	}
	if !h.hasReason(t, "host_mismatch") {
		t.Error("host_mismatch not logged")
	}
	// Host with :443 is the same host.
	tc, _ = h.tunnel(t, config.PortKete, "gateway.test", "gateway.test")
	br = bufio.NewReader(tc)
	if resp, err := rawRequest(t, tc, br, "GET / HTTP/1.1\r\nHost: gateway.test:443\r\n\r\n"); err != nil || resp.StatusCode != 200 {
		t.Errorf("Host with :443: %v %v", resp, err)
	}
}

func TestInnerProtocolRefusals(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	cases := []struct {
		name string
		req  string
		want int
	}{
		{"absolute-form", "GET https://gateway.test/ HTTP/1.1\r\nHost: gateway.test\r\n\r\n", 400},
		{"asterisk-form", "OPTIONS * HTTP/1.1\r\nHost: gateway.test\r\n\r\n", 400},
		{"HTTP/1.0", "GET / HTTP/1.0\r\nHost: gateway.test\r\n\r\n", 505},
		{"h2 preface", "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", 505},
		{"websocket", "GET / HTTP/1.1\r\nHost: gateway.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", 403},
		{"h2c", "GET / HTTP/1.1\r\nHost: gateway.test\r\nConnection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAAQCAAAAAAIAAAAA\r\n\r\n", 403},
		{"connection upgrade only", "GET / HTTP/1.1\r\nHost: gateway.test\r\nConnection: upgrade\r\n\r\n", 403},
		{"body too large", "POST / HTTP/1.1\r\nHost: gateway.test\r\nContent-Length: 67108865\r\n\r\n", 413},
	}
	for _, c := range cases {
		tc, err := h.tunnel(t, config.PortKete, "gateway.test", "gateway.test")
		if err != nil {
			t.Fatal(err)
		}
		resp, err := rawRequest(t, tc, bufio.NewReader(tc), c.req)
		if err != nil {
			// Go's server may answer some malformed requests itself and close; that's a refusal too.
			t.Logf("%s: %v", c.name, err)
			continue
		}
		if resp.StatusCode != c.want {
			t.Errorf("%s: %d, want %d", c.name, resp.StatusCode, c.want)
		}
	}
}

func TestPhaseChangeClosesConnections(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	tc, err := h.tunnel(t, config.PortKete, "gateway.test", "gateway.test")
	if err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(tc)
	if resp, err := rawRequest(t, tc, br, "GET / HTTP/1.1\r\nHost: gateway.test\r\n\r\n"); err != nil || resp.StatusCode != 200 {
		t.Fatalf("before: %v %v", resp, err)
	}
	// A root connection to platform.test stays allowed in report.
	rootTC, err := h.tunnel(t, config.PortRoot, "platform.test", "platform.test")
	if err != nil {
		t.Fatal(err)
	}
	if n := h.phase(t, phase.Report); n != 1 {
		t.Errorf("closed %d connections, want 1", n)
	}
	if _, err := rawRequest(t, tc, br, "GET / HTTP/1.1\r\nHost: gateway.test\r\n\r\n"); err == nil {
		t.Error("request on a closed connection succeeded")
	}
	rbr := bufio.NewReader(rootTC)
	if resp, err := rawRequest(t, rootTC, rbr, "GET / HTTP/1.1\r\nHost: platform.test\r\n\r\n"); err != nil || resp.StatusCode != 200 {
		t.Errorf("still-allowed connection: %v %v", resp, err)
	}
	if _, _, st := h.connect(t, config.PortKete, connectLine("gateway.test")); st != 403 {
		t.Errorf("new CONNECT after the phase change: %d", st)
	}
	if _, err := h.p.SetPhase(phase.Agent); err == nil {
		t.Error("going back to agent accepted")
	}
	if n := h.phase(t, phase.Closed); n != 1 {
		t.Errorf("closed phase closed %d, want 1", n)
	}
}

func TestRegistryThroughProxy(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	cl := h.client(config.PortTool)
	for _, p := range []string{"/left-pad", "/left-pad/-/left-pad-1.3.0.tgz"} {
		resp, err := cl.Get("https://registry.npm.test" + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Errorf("GET %s: %d", p, resp.StatusCode)
		}
	}
	resp, err := cl.Post("https://registry.npm.test/-/npm/v1/security/audits/quick", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 405 {
		t.Errorf("POST: %d", resp.StatusCode)
	}
	if got := h.p.Stats().RegistryRequests; got != 2 {
		t.Errorf("registry_requests = %d", got)
	}
}

func TestResolvedBlocked(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	resp, err := h.client(config.PortKete).Get("https://internal.test/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 502 || !h.hasReason(t, "resolved_blocked") {
		t.Errorf("status %d, log %s", resp.StatusCode, h.log.String())
	}
}

func TestRealDialerRefusesBlockedAddresses(t *testing.T) {
	h := newHarness(t, hopts{})
	h.p.isBlocked = blocked.Contains // production check: loopback is blocked too
	_, err := h.p.dialUpstream(context.Background(), "tcp", "gateway.test:443")
	var de *dialError
	if !errors.As(err, &de) || de.reason != "resolved_blocked" {
		t.Errorf("dial to a loopback-resolving host: %v", err)
	}
}

func TestUpstreamVerifiedAgainstRoots(t *testing.T) {
	h := newHarness(t, hopts{noRoots: true})
	h.phase(t, phase.Agent)
	resp, err := h.client(config.PortKete).Get("https://gateway.test/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 502 || !h.hasReason(t, "upstream_error") {
		t.Errorf("unverifiable upstream: status %d", resp.StatusCode)
	}
}

func TestRedirectNotFollowedAndStreaming(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	cl := h.client(config.PortKete)
	resp, err := cl.Get("https://gateway.test/redirect")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 302 || h.up.sawHost("evil.test") {
		t.Errorf("redirect: %d", resp.StatusCode)
	}
	resp, err = cl.Get("https://gateway.test/stream")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if strings.Count(string(body), "data:") != 3 {
		t.Errorf("stream body %q", body)
	}
}

func TestPeerUIDRefused(t *testing.T) {
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	h.peerBad.Store(true)
	if _, _, st := h.connect(t, config.PortKete, connectLine("gateway.test")); st != -1 {
		t.Errorf("wrong peer uid got a response: %d", st)
	}
	if !h.hasReason(t, "peer_uid") {
		t.Error("peer_uid not logged")
	}
}

func TestConnLimit(t *testing.T) {
	old := MaxConnsPerPort[config.PortRoot]
	MaxConnsPerPort[config.PortRoot] = 2
	defer func() { MaxConnsPerPort[config.PortRoot] = old }()
	h := newHarness(t, hopts{})
	h.phase(t, phase.Agent)
	for i := 0; i < 2; i++ {
		c, err := net.Dial("tcp", h.addr[config.PortRoot])
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
	}
	time.Sleep(100 * time.Millisecond)
	if _, _, st := h.connect(t, config.PortRoot, connectLine("platform.test")); st != -1 {
		t.Errorf("third connection got %d", st)
	}
	if !h.hasReason(t, "conn_limit") {
		t.Error("conn_limit not logged")
	}
}

// getUntil503 GETs url through the proxy on port until it's refused with 503 (the response or the
// CONNECT) and returns how many requests succeeded first.
func (h *harness) getUntil503(t *testing.T, port config.Port, url string) int {
	t.Helper()
	cl := h.client(port)
	for i := 0; i < 100; i++ {
		resp, err := cl.Get(url)
		if err != nil {
			if strings.Contains(err.Error(), "Service Unavailable") {
				return i
			}
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == 503 {
			return i
		}
		if resp.StatusCode != 200 {
			t.Fatalf("status %d", resp.StatusCode)
		}
	}
	t.Fatal("never refused")
	return 0
}

func TestLogFullRefusesEverything(t *testing.T) {
	const limit = 8192
	h := newHarness(t, hopts{logLimit: limit})
	h.phase(t, phase.Agent)
	if n := h.getUntil503(t, config.PortKete, "https://gateway.test/x"); n == 0 {
		t.Fatal("kete refused at once")
	}
	if _, _, st := h.connect(t, config.PortKete, connectLine("gateway.test")); st != 503 {
		t.Errorf("kete CONNECT after the job share is full: %d", st)
	}
	if h.p.Stats().LogFull {
		t.Fatal("whole log full before root used its share")
	}
	// Root still works in its reserved share, until the whole log is full.
	if n := h.getUntil503(t, config.PortRoot, "https://platform.test/report"); n == 0 {
		t.Error("root got no request through after the job users filled their share")
	}
	if _, _, st := h.connect(t, config.PortRoot, connectLine("platform.test")); st != 503 {
		t.Errorf("root CONNECT after full: %d", st)
	}
	h.p.Close() // waits for in-flight lines and the marker
	out := h.log.String()
	if len(out) > limit || !strings.HasSuffix(strings.TrimSpace(out), `"log_full":true}`) {
		t.Errorf("log %d bytes, ends %q", len(out), out[max(0, len(out)-60):])
	}
	if !h.p.Stats().LogFull {
		t.Error("stats.log_full false")
	}
}

// A tool-port flood (refusals, then legitimate registry traffic) can neither fill the log with
// refusal lines nor stop root's requests.
func TestToolFloodCannotStopRoot(t *testing.T) {
	h := newHarness(t, hopts{logLimit: 20_000})
	h.phase(t, phase.Agent)
	for i := 0; i < 300; i++ {
		c, err := net.Dial("tcp", h.addr[config.PortTool])
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(c, connectLine("gateway.test"))
		_, _ = io.Copy(io.Discard, c)
		c.Close()
	}
	// Each refusal line is written before the proxy closes that connection, so it's all there.
	n := 0
	for _, m := range h.logLines(t) {
		if m["reason"] == "host_not_allowed" {
			n++
		}
	}
	if n == 0 || n > int(reqlog.RefusalBurst)+5 {
		t.Errorf("%d refusal lines from a 300-refusal flood", n)
	}
	if got := h.p.Stats().Refused; got != 300 {
		t.Errorf("refused = %d (every refusal is still counted)", got)
	}
	h.getUntil503(t, config.PortTool, "https://registry.npm.test/left-pad")
	resp, err := h.client(config.PortRoot).Get("https://platform.test/report")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("root after the tool flood: %d", resp.StatusCode)
	}
	if st := h.p.Stats(); !st.JobLogFull || st.LogFull {
		t.Errorf("stats job_log_full=%v log_full=%v", st.JobLogFull, st.LogFull)
	}
	if strings.Count(h.log.String(), `"job_log_full":true`) != 1 {
		t.Error("no single job_log_full marker")
	}
	// At shutdown the tool port's rate-limited refusals are reported in a summary line.
	h.p.Close()
	sum := h.waitLine(t, func(m map[string]any) bool { return m["reason"] == "suppressed_summary" })
	if sum == nil || sum["user"] != "tool" || sum["suppressed"].(float64) <= 0 {
		t.Errorf("summary line %v", sum)
	}
}

// The upstream trust is the system roots loaded before the job CA existed: an upstream presenting
// a certificate from the job CA itself is refused.
func TestUpstreamSignedByJobCARefused(t *testing.T) {
	h := newHarness(t, hopts{jobCAUpstream: true})
	h.phase(t, phase.Agent)
	if h.p.upstreamRoots.Equal(h.caPool) {
		t.Fatal("upstream roots are the job CA")
	}
	resp, err := h.client(config.PortKete).Get("https://gateway.test/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 502 || !h.hasReason(t, "upstream_error") {
		t.Errorf("job-CA-signed upstream: status %d", resp.StatusCode)
	}
	if h.up.sawHost("gateway.test") {
		t.Error("a request reached the job-CA-signed upstream")
	}
}

func TestNewRequiresUpstreamRoots(t *testing.T) {
	h := newHarness(t, hopts{})
	_, err := New(Deps{Config: h.cfg, Listeners: h.p.listeners, Log: h.p.log, CA: h.p.ca, Phase: phase.NewState()})
	if err == nil {
		t.Error("New without UpstreamRoots succeeded")
	}
}

func TestStreamIdleClosesConnection(t *testing.T) {
	h := newHarness(t, hopts{idle: 200 * time.Millisecond})
	h.phase(t, phase.Agent)
	tc, err := h.tunnel(t, config.PortKete, "gateway.test", "gateway.test")
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(600 * time.Millisecond)
	_ = tc.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := tc.Read(make([]byte, 1)); err == nil || errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("idle connection still open: %v", err)
	}
	var ne net.Error
	if err := func() error { _, err := tc.Read(make([]byte, 1)); return err }(); errors.As(err, &ne) && ne.Timeout() {
		t.Error("read timed out instead of seeing the close")
	}
}

func TestCAPEMIsCertificate(t *testing.T) {
	h := newHarness(t, hopts{})
	block, _ := pem.Decode(h.p.ca.CertPEM())
	if block == nil {
		t.Fatal("no PEM")
	}
}
