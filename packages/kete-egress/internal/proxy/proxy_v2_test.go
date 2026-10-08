package proxy

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/policy"
)

// v2Internal makes the test configuration version 2: loopback (the fake internet here) becomes
// an internal range on 443, the upstream's real port and 3128, and "gateway.test:<port>" is allowed
// for kete in the agent phase.
func v2Internal(t *testing.T, cfg *config.Config, upPort int) {
	t.Helper()
	cfg.Version = config.VersionV2
	cfg.Internal = []config.InternalRange{{Prefix: netip.MustParsePrefix("127.0.0.0/8"), Ports: []uint16{443, uint16(upPort), 3128}}}
	cfg.Allow[phase.Agent][config.PortKete]["gateway.test:"+strconv.Itoa(upPort)] = true
}

func v2Get(t *testing.T, h *harness, url string) (int, echo) {
	t.Helper()
	resp, err := h.client(config.PortKete).Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var e echo
	_ = json.NewDecoder(resp.Body).Decode(&e)
	return resp.StatusCode, e
}

func TestV2NonDefaultPortInsideInternalRange(t *testing.T) {
	var upPort int
	h := newHarness(t, hopts{v2: func(t *testing.T, cfg *config.Config, p int) { upPort = p; v2Internal(t, cfg, p) }})
	h.phase(t, phase.Agent)
	target := "gateway.test:" + strconv.Itoa(upPort)
	st, e := v2Get(t, h, "https://"+target+"/x")
	if st != 200 || e.SNI != "gateway.test" || e.Host != target {
		t.Fatalf("status %d echo %+v", st, e)
	}
	// The same host on a port the allowlist doesn't name is refused at CONNECT.
	_, _, code := h.connect(t, config.PortKete, "CONNECT gateway.test:8443 HTTP/1.1\r\n\r\n")
	if code != 403 {
		t.Errorf("CONNECT to an unlisted port = %d, want 403", code)
	}
	// A bare host (443) still works and dials the seam's port.
	if st, _ := v2Get(t, h, "https://gateway.test/"); st != 200 {
		t.Errorf("443 entry status %d", st)
	}
}

func TestV2ForbiddenAndBlockedRules(t *testing.T) {
	h := newHarness(t, hopts{v2: v2Internal})
	cases := []struct {
		a    string
		port uint16
		want bool
	}{
		{"10.9.9.9", 443, false},        // blocked, in no internal range
		{"127.0.0.1", 3128, true},       // internal range, listed port
		{"127.0.0.1", 22, false},        // internal range, other port
		{"127.0.0.1", 443, true},        // internal range, 443 listed
		{"169.254.169.254", 443, false}, // forbidden
		{"203.0.113.7", 443, true},      // not blocked (this test's isBlocked), 443
		{"8.8.8.8", 8443, false},        // public, not 443, in no range
		{"::ffff:169.254.169.254", 443, false},
	}
	h.p.isBlocked = func(a netip.Addr) bool { return !a.IsLoopback() && (a.IsPrivate() || a.IsLinkLocalUnicast()) }
	for _, c := range cases {
		if got := h.p.addrAllowed(netip.MustParseAddr(c.a), c.port); got != c.want {
			t.Errorf("%s:%d allowed = %v, want %v", c.a, c.port, got, c.want)
		}
	}
	// A forbidden range inside an internal one stays forbidden.
	h.p.isForbidden = func(a netip.Addr) bool { return a == netip.MustParseAddr("127.0.0.53") }
	if h.p.addrAllowed(netip.MustParseAddr("127.0.0.53"), 3128) {
		t.Error("a forbidden address inside an internal range was allowed")
	}
}

// connectProxy is a fake enterprise proxy: it records each CONNECT's target and
// Proxy-Authorization and tunnels to dst (or answers status when non-zero).
type connectProxy struct {
	ln net.Listener
	// chunked: answer 200 with "Transfer-Encoding: chunked", as some proxies (and Go's own server,
	// hijacking after WriteHeader) do.
	chunked bool
	mu      sync.Mutex
	seen    []string
	auth    []string
	status  int
}

func newConnectProxy(t *testing.T, dst string, status int) *connectProxy {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cp := &connectProxy{ln: ln, status: status}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				br := bufio.NewReader(c)
				req, err := http.ReadRequest(br)
				if err != nil {
					return
				}
				cp.mu.Lock()
				cp.seen = append(cp.seen, req.Method+" "+req.Host)
				cp.auth = append(cp.auth, req.Header.Get("Proxy-Authorization"))
				cp.mu.Unlock()
				if cp.status != 0 {
					_, _ = io.WriteString(c, "HTTP/1.1 "+strconv.Itoa(cp.status)+" No\r\nContent-Length: 0\r\n\r\n")
					return
				}
				up, err := net.Dial("tcp", dst)
				if err != nil {
					return
				}
				defer up.Close()
				if cp.chunked {
					_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
				} else {
					_, _ = io.WriteString(c, "HTTP/1.1 200 Connection established\r\n\r\n")
				}
				go func() { _, _ = io.Copy(up, br) }()
				_, _ = io.Copy(c, up)
			}()
		}
	}()
	return cp
}

func (cp *connectProxy) port() int { return cp.ln.Addr().(*net.TCPAddr).Port }

func withUpstream(direct ...string) func(t *testing.T, cfg *config.Config, upPort int) {
	return func(t *testing.T, cfg *config.Config, upPort int) {
		v2Internal(t, cfg, upPort)
		cfg.Upstream = &config.Upstream{Scheme: "http", Host: "127.0.0.1", Addr: netip.MustParseAddr("127.0.0.1"), Port: 3128, Direct: map[config.Target]bool{}}
		for _, d := range direct {
			tg, err := config.ParseTarget(d)
			if err != nil {
				t.Fatal(err)
			}
			cfg.Upstream.Direct[tg] = true
		}
	}
}

func TestV2UpstreamProxyCarriesTheConnection(t *testing.T) {
	// The fake proxy tunnels every CONNECT to the fake internet.
	h := newHarness(t, hopts{v2: withUpstream("platform.test"), proxyAuth: "svc:s3cret"})
	cp := newConnectProxy(t, h.up.srv.Listener.Addr().String(), 0)
	h.p.upstreamProxyPort = cp.port()
	h.phase(t, phase.Agent)
	st, e := v2Get(t, h, "https://gateway.test/v1")
	if st != 200 || e.Host != "gateway.test" {
		t.Fatalf("status %d echo %+v", st, e)
	}
	cp.mu.Lock()
	seen, auth := append([]string(nil), cp.seen...), append([]string(nil), cp.auth...)
	cp.mu.Unlock()
	if len(seen) != 1 || seen[0] != "CONNECT gateway.test:443" || auth[0] != "Basic c3ZjOnMzY3JldA==" {
		t.Errorf("proxy saw %v auth %v", seen, auth)
	}
	if e.ProxyAu != "" {
		t.Error("the proxy credentials reached the upstream server")
	}
	// A direct entry skips the proxy.
	if st, _ := v2Get(t, h, "https://platform.test/"); st != 200 {
		t.Errorf("direct entry status %d", st)
	}
	cp.mu.Lock()
	n := len(cp.seen)
	cp.mu.Unlock()
	if n != 1 {
		t.Errorf("a direct entry went through the proxy (%d CONNECTs)", n)
	}
	if strings.Contains(h.log.String(), "s3cret") || strings.Contains(h.log.String(), "c3ZjOnMzY3JldA") {
		t.Error("the proxy credentials were logged")
	}
}

// A proxy that labels its 200 with a body framing still tunnels: the answer's body is never read.
func TestV2UpstreamProxyChunked200(t *testing.T) {
	h := newHarness(t, hopts{v2: withUpstream()})
	cp := newConnectProxy(t, h.up.srv.Listener.Addr().String(), 0)
	cp.chunked = true
	h.p.upstreamProxyPort = cp.port()
	h.phase(t, phase.Agent)
	done := make(chan int, 1)
	go func() { st, _ := v2Get(t, h, "https://gateway.test/"); done <- st }()
	select {
	case st := <-done:
		if st != 200 {
			t.Errorf("status %d", st)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("the request hung on the CONNECT answer")
	}
}

func TestV2UpstreamProxyRefusalIsRefused(t *testing.T) {
	h := newHarness(t, hopts{v2: withUpstream()})
	cp := newConnectProxy(t, "", http.StatusProxyAuthRequired)
	h.p.upstreamProxyPort = cp.port()
	h.phase(t, phase.Agent)
	if st, _ := v2Get(t, h, "https://gateway.test/"); st != http.StatusBadGateway {
		t.Errorf("status %d, want 502", st)
	}
	if !h.hasReason(t, policy.ReasonUpstreamProxy) {
		t.Errorf("no %s log line: %s", policy.ReasonUpstreamProxy, h.log.String())
	}
}
