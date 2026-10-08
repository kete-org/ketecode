//go:build integration && linux

package itest

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/ca"
)

func portOf(u user) int {
	switch u.name {
	case "kete":
		return portA
	case "tool":
		return portB
	}
	return portR
}

// expectAllowed runs the same request through curl (OpenSSL) and Go's client as u, and checks the
// upstream saw exactly the CONNECT host as SNI and Host.
func expectAllowed(t *testing.T, pp *proxyProc, u user, method, host, path, body string) {
	t.Helper()
	for _, kind := range []string{"curl", "http"} {
		res := run(t, u, clientReq{Kind: kind, Port: portOf(u), CA: pp.caPath, Method: method, URL: "https://" + host + path, Body: body})
		if res.Status != 200 {
			t.Errorf("%s %s %s%s via %s: status %d err %q", u.name, method, host, path, kind, res.Status, res.Err)
			continue
		}
		var e echo
		if err := json.Unmarshal([]byte(strings.TrimSpace(res.Body)), &e); err != nil {
			t.Errorf("%s: body %q", kind, res.Body)
			continue
		}
		if e.SNI != host || e.Host != host || e.Method != method || e.Path != path || e.BodyLen != len(body) {
			t.Errorf("%s via %s: upstream saw %+v", host, kind, e)
		}
	}
}

func rawReq(u user, pp *proxyProc, host string, requests ...string) clientReq {
	return clientReq{Kind: "raw", Port: portOf(u), CA: pp.caPath, Authority: host + ":443", ConnectHdr: "Host: " + host + ":443\r\n", SNI: host, Requests: requests}
}

func get(host, path string) string {
	return "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\n\r\n"
}

// AC1: allowed requests for each phase and port reach their upstream over TLS terminated by the
// proxy's CA, with the upstream verified.
func TestAllowed(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	pp.phase(t, "clone")
	expectAllowed(t, pp, root(), "GET", "github.test", "/org/repo.git/info/refs", "")
	pp.phase(t, "agent")
	expectAllowed(t, pp, kete(), "POST", "gateway.test", "/v1/messages", `{"model":"m"}`)
	expectAllowed(t, pp, kete(), "GET", "platform.test", "/api/v1/jobs/1", "")
	expectAllowed(t, pp, kete(), "GET", "v6only.test", "/over-ipv6", "")
	expectAllowed(t, pp, tool(), "GET", "registry.npm.test", "/left-pad", "")
	expectAllowed(t, pp, tool(), "GET", "registry.npm.test", "/left-pad/-/left-pad-1.3.0.tgz", "")
	expectAllowed(t, pp, root(), "GET", "platform.test", "/api/v1/jobs/1/heartbeat", "")
	pp.phase(t, "report")
	expectAllowed(t, pp, root(), "PUT", "storage.test", "/job-audit/org/job.proxy.jsonl", "report-body")
	m := pp.send(t, `{"type":"stats"}`)
	if m["type"] != "stats" || m["requests"].(float64) < 16 || m["registry_requests"].(float64) != 4 || m["log_full"] != false {
		t.Errorf("stats = %v", m)
	}
	pp.stop(t)
}

// AC1 negative control: without the test CA the proxy can't verify the upstream.
func TestAllowedNegativeControlUnverifiedUpstream(t *testing.T) {
	pp := startProxy(t, proxyOpts{noCertFile: true})
	pp.phase(t, "agent")
	res := run(t, kete(), clientReq{Kind: "http", Port: portA, CA: pp.caPath, Method: "GET", URL: "https://gateway.test/"})
	if res.Status != 502 {
		t.Errorf("status %d err %q, want 502", res.Status, res.Err)
	}
	if !pp.hasReason(t, "upstream_error") {
		t.Error("upstream_error not logged")
	}
}

// AC2: hosts not allowed for the phase and port.
func TestRefusedHostNotAllowed(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	check := func(name string, u user, host string) {
		t.Helper()
		res := run(t, u, rawReq(u, pp, host))
		if res.ConnectStatus != 403 {
			t.Errorf("%s: CONNECT %d, want 403", name, res.ConnectStatus)
		}
	}
	check("none phase, kete → gateway", kete(), "gateway.test")
	check("none phase, root → github", root(), "github.test")
	pp.phase(t, "clone")
	check("clone, kete → gateway", kete(), "gateway.test")
	check("clone, kete → github", kete(), "github.test")
	check("clone, tool → registry", tool(), "registry.npm.test")
	pp.phase(t, "agent")
	check("agent, kete → github", kete(), "github.test")
	check("agent, tool → gateway", tool(), "gateway.test")
	check("agent, root → github", root(), "github.test")
	pp.phase(t, "closed")
	check("closed, kete → gateway", kete(), "gateway.test")
	if !pp.hasReason(t, "host_not_allowed") {
		t.Error("host_not_allowed not logged")
	}
}

// AC2: a phase change closes connections the new phase doesn't allow; phases never go back.
func TestPhaseSwitch(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	pp.phase(t, "clone")
	signal, goFile := tempPath(t, "signal-*"), tempPath(t, "go-*")
	req := rawReq(root(), pp, "github.test", get("github.test", "/one"), get("github.test", "/two"))
	req.SignalFile, req.WaitFile = signal, goFile
	wait := start(t, root(), req)
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if _, err := os.Stat(signal); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("client never finished its first request")
		}
	}
	if n := pp.phase(t, "agent"); n < 1 {
		t.Errorf("phase_ok.closed_connections = %d, want ≥ 1", n)
	}
	if err := os.WriteFile(goFile, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	res := wait()
	if len(res.Statuses) != 1 || res.Statuses[0] != 200 || res.Err == "" {
		t.Errorf("keep-alive across the phase change: statuses %v err %q", res.Statuses, res.Err)
	}
	if again := run(t, root(), rawReq(root(), pp, "github.test")); again.ConnectStatus != 403 {
		t.Errorf("new CONNECT after the switch: %d", again.ConnectStatus)
	}
	if m := pp.send(t, `{"type":"phase","phase":"clone"}`); m["type"] != "error" {
		t.Errorf("going back to clone: %v", m)
	}
}

// AC2: the SNI must equal the CONNECT host.
func TestRefusedSNI(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	pp.phase(t, "agent")
	for _, sni := range []string{"platform.test", "-"} {
		req := rawReq(kete(), pp, "gateway.test", get("gateway.test", "/"))
		req.SNI = sni
		res := run(t, kete(), req)
		if res.ConnectStatus != 200 || res.TLSErr == "" || len(res.Statuses) != 0 {
			t.Errorf("SNI %q: connect %d tls %q statuses %v", sni, res.ConnectStatus, res.TLSErr, res.Statuses)
		}
	}
	if !pp.hasReason(t, "sni_mismatch") {
		t.Error("sni_mismatch not logged")
	}
}

// AC2: domain fronting, and a Host change on a keep-alive connection.
func TestRefusedHostMismatch(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	pp.phase(t, "agent")
	res := run(t, kete(), rawReq(kete(), pp, "front.test", get("evil.test", "/")))
	if len(res.Statuses) != 1 || res.Statuses[0] != 421 {
		t.Errorf("fronting: %+v", res)
	}
	if W.sawHost("evil.test") {
		t.Error("the upstream received evil.test")
	}
	res = run(t, kete(), rawReq(kete(), pp, "gateway.test", get("gateway.test", "/one"), get("platform.test", "/two")))
	if len(res.Statuses) != 2 || res.Statuses[0] != 200 || res.Statuses[1] != 421 {
		t.Errorf("keep-alive Host change: %+v", res)
	}
	if !pp.hasReason(t, "host_mismatch") {
		t.Error("host_mismatch not logged")
	}
}

// AC2: registry rules.
func TestRegistry(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	pp.phase(t, "agent")
	h := "registry.npm.test"
	long := func(n int) string { return "/" + strings.Repeat("a", n-1) }
	cases := []struct {
		name string
		req  string
		want int
	}{
		{"GET metadata", get(h, "/left-pad"), 200},
		{"POST", "POST /-/npm/v1/security/audits/quick HTTP/1.1\r\nHost: " + h + "\r\nContent-Length: 2\r\n\r\n{}", 405},
		{"query", get(h, "/left-pad?x=1"), 403},
		{"bare ?", get(h, "/left-pad?"), 403},
		{"GET with a body", "GET /left-pad HTTP/1.1\r\nHost: " + h + "\r\nContent-Length: 5\r\n\r\nhello", 403},
		{"path 1025 B", get(h, long(1025)), 414},
		{"path 1024 B (length ok, shape refused)", get(h, long(1024)), 403},
		{"unknown shape", get(h, "/-/whoami"), 403},
		{"dotdot", get(h, "/left-pad/../x"), 403},
	}
	for _, c := range cases {
		res := run(t, tool(), rawReq(tool(), pp, h, c.req))
		if len(res.Statuses) != 1 || res.Statuses[0] != c.want {
			t.Errorf("%s: %+v, want %d", c.name, res, c.want)
		}
	}
	lines := pp.logLines(t)
	var got414 bool
	for _, l := range lines {
		if l["status"] == 414.0 && l["reason"] == "path_length" {
			got414 = true
		}
	}
	if !got414 {
		t.Error("414 path_length not logged")
	}
}

// AC2: the per-job registry request cap.
func TestRegistryCap(t *testing.T) {
	pp := startProxy(t, proxyOpts{limits: map[string]any{"registry_requests": 5}})
	pp.phase(t, "agent")
	var reqs []string
	for i := 0; i < 6; i++ {
		reqs = append(reqs, get("registry.npm.test", "/left-pad"))
	}
	res := run(t, tool(), rawReq(tool(), pp, "registry.npm.test", reqs...))
	want := []int{200, 200, 200, 200, 200, 429}
	if fmt.Sprint(res.Statuses) != fmt.Sprint(want) {
		t.Errorf("statuses %v, want %v (err %q)", res.Statuses, want, res.Err)
	}
}

// AC2/AC4: once the log is full every request is refused and the file stays under the cap. The
// job users' part fills first; root's reserved share (the last tenth) still serves root.
func TestLogFull(t *testing.T) {
	const limit = 8192
	pp := startProxy(t, proxyOpts{limits: map[string]any{"log_max_bytes": limit}})
	pp.phase(t, "agent")
	fill := func(u user, host string) []int {
		var reqs []string
		for i := 0; i < 40; i++ {
			reqs = append(reqs, get(host, fmt.Sprintf("/r%d", i)))
		}
		return run(t, u, rawReq(u, pp, host, reqs...)).Statuses
	}
	st := fill(kete(), "gateway.test")
	n := len(st)
	if n < 2 || st[0] != 200 || st[n-1] != 503 {
		t.Fatalf("kete statuses %v", st)
	}
	if again := run(t, kete(), rawReq(kete(), pp, "gateway.test")); again.ConnectStatus != 503 {
		t.Errorf("kete CONNECT after the job share is full: %d", again.ConnectStatus)
	}
	st = fill(root(), "platform.test")
	n = len(st)
	if n < 2 || st[0] != 200 || st[n-1] != 503 {
		t.Fatalf("root statuses %v (root must still get through its reserved share)", st)
	}
	if again := run(t, root(), rawReq(root(), pp, "platform.test")); again.ConnectStatus != 503 {
		t.Errorf("root CONNECT after full: %d", again.ConnectStatus)
	}
	if m := pp.send(t, `{"type":"stats"}`); m["log_full"] != true {
		t.Errorf("stats %v", m)
	}
	pp.stop(t)
	data, err := os.ReadFile(pp.logPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > limit {
		t.Errorf("log is %d bytes > %d", len(data), limit)
	}
	if !strings.HasSuffix(strings.TrimSpace(string(data)), `"log_full":true}`) {
		t.Errorf("log doesn't end with the marker: %q", data[max(0, len(data)-80):])
	}
}

// AC4: log content, permissions and what it never contains.
func TestLogContent(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	pp.phase(t, "agent")
	res := run(t, kete(), clientReq{Kind: "http", Port: portA, CA: pp.caPath, Method: "POST",
		URL:     "https://platform.test/api/v1/jobs?token=QUERYMARKER",
		Headers: map[string]string{"Authorization": "Bearer HEADERSECRET"},
		Body:    "BODYMARKER"})
	if res.Status != 200 {
		t.Fatalf("status %d %q", res.Status, res.Err)
	}
	longPath := "/" + strings.Repeat("p", 600)
	if res := run(t, kete(), clientReq{Kind: "http", Port: portA, CA: pp.caPath, Method: "GET", URL: "https://platform.test" + longPath}); res.Status != 200 {
		t.Fatalf("long path: %d", res.Status)
	}
	run(t, kete(), rawReq(kete(), pp, "github.test")) // a refusal, logged too
	pp.stop(t)
	data, err := os.ReadFile(pp.logPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"HEADERSECRET", "BODYMARKER", "QUERYMARKER", "Authorization", "token="} {
		if strings.Contains(string(data), secret) {
			t.Errorf("log contains %q", secret)
		}
	}
	lines := pp.logLines(t)
	if len(lines) != 3 {
		t.Errorf("%d lines, want 3: %s", len(lines), data)
	}
	for _, l := range lines {
		if p, _ := l["path"].(string); len(p) > 256 {
			t.Errorf("path of %d bytes logged", len(p))
		}
		for _, k := range []string{"v", "ts", "phase", "user", "port", "method", "host", "path", "status", "req_bytes", "resp_bytes"} {
			if _, ok := l[k]; !ok {
				t.Errorf("line lacks %q: %v", k, l)
			}
		}
	}
	if lines[0]["path"] != "/api/v1/jobs" || lines[0]["req_bytes"] != 10.0 || lines[0]["user"] != "kete" {
		t.Errorf("first line %v", lines[0])
	}
	if lines[2]["reason"] != "host_not_allowed" || lines[2]["method"] != "CONNECT" {
		t.Errorf("refusal line %v", lines[2])
	}
	st, err := os.Stat(pp.logPath)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 || st.Sys().(*syscall.Stat_t).Uid != 0 {
		t.Errorf("log mode %v uid %d", st.Mode(), st.Sys().(*syscall.Stat_t).Uid)
	}
	for _, u := range []user{kete(), tool(), proxy()} {
		if res := run(t, u, clientReq{Kind: "open", Path: pp.logPath}); res.Errno != "EACCES" {
			t.Errorf("%s opening the log: %q %q", u.name, res.Errno, res.Err)
		}
	}
}

// A name resolving only to a blocked address is refused without touching it.
func TestResolvedBlocked(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	pp.phase(t, "agent")
	before := W.baitHits.Load()
	res := run(t, kete(), clientReq{Kind: "http", Port: portA, CA: pp.caPath, Method: "GET", URL: "https://internal.test/"})
	if res.Status != 502 {
		t.Errorf("status %d %q", res.Status, res.Err)
	}
	if !pp.hasReason(t, "resolved_blocked") {
		t.Error("resolved_blocked not logged")
	}
	if W.baitHits.Load() != before {
		t.Error("the bait listener was reached")
	}
}

// AC3: with the rules applied each user reaches only its own proxy port; direct and DNS egress
// fail for everyone but the proxy user; IPv6 is covered. Refusals are fast: the ruleset rejects
// (TCP reset, ICMP port-unreachable) rather than drops, so a blocked TCP connect must fail with
// ECONNREFUSED well inside failFast, never by timing out. Every blocked destination has a live
// listener, so a refusal can only be the firewall.
const failFast = time.Second

func TestFirewall(t *testing.T) {
	startProxy(t, proxyOpts{})
	type probe struct {
		name    string
		u       user
		network string
		addr    string
		ok      bool
		wait    func() clientRes
	}
	var probes []*probe
	add := func(name string, u user, network, addr string, ok bool) {
		probes = append(probes, &probe{name: name, u: u, network: network, addr: addr, ok: ok})
	}
	a, b, r := fmt.Sprintf("127.0.0.1:%d", portA), fmt.Sprintf("127.0.0.1:%d", portB), fmt.Sprintf("127.0.0.1:%d", portR)
	// Own port / wrong ports.
	add("own port", kete(), "tcp", a, true)
	add("wrong port", kete(), "tcp", b, false)
	add("wrong port", kete(), "tcp", r, false)
	add("own port", tool(), "tcp", b, true)
	add("wrong port", tool(), "tcp", a, false)
	add("wrong port", tool(), "tcp", r, false)
	add("own port", root(), "tcp", r, true)
	add("wrong port", root(), "tcp", a, false)
	add("wrong port", root(), "tcp", b, false)
	// The tool user's own loopback listeners (≥ 1024), IPv4 and IPv6; not for kete.
	own4, own6 := fmt.Sprintf("127.0.0.1:%d", ownPort), fmt.Sprintf("[::1]:%d", ownPort)
	add("own listener", tool(), "tcp", own4, true)
	add("own listener v6", tool(), "tcp", own6, true)
	add("tool listener", kete(), "tcp", own4, false)
	add("tool listener v6", kete(), "tcp", own6, false)
	// Direct connections bypassing the proxy.
	for _, u := range []user{kete(), tool(), root()} {
		add("direct v4", u, "tcp", upMain+":443", false)
		add("direct v6", u, "tcp", "["+upV6+"]:443", false)
	}
	// Metadata service and private ranges, even for the proxy user; the internet is fine.
	for _, addr := range []string{"169.254.169.254:443", "10.9.9.9:443", "[fdaa::3]:443"} {
		add("blocked range", proxy(), "tcp", addr, false)
	}
	add("proxy to a non-443 port", proxy(), "tcp", "["+upV6+"]:8443", false)
	// A fourth user the configuration doesn't name gets nothing at all.
	add("unlisted user", other(), "tcp", a, false)
	add("unlisted user", other(), "tcp", b, false)
	add("unlisted user", other(), "tcp", r, false)
	add("unlisted user", other(), "tcp", upMain+":443", false)
	add("unlisted user v6", other(), "tcp", "["+upV6+"]:443", false)
	add("unlisted user", other(), "tcp", own4, false)
	add("control", proxy(), "tcp", upMain+":443", true)
	add("control v6", proxy(), "tcp", "["+upV6+"]:443", true)

	before := W.baitHits.Load()
	for _, p := range probes {
		p.wait = start(t, p.u, clientReq{Kind: "dial", Network: p.network, Addr: p.addr})
	}
	for _, p := range probes {
		res := p.wait()
		switch {
		case p.ok && res.Err != "":
			t.Errorf("%s: %s → %s %s: %q, want connected", p.name, p.u.name, p.network, p.addr, res.Err)
		case !p.ok && res.Err == "":
			t.Errorf("%s: %s → %s %s connected, want blocked", p.name, p.u.name, p.network, p.addr)
		case !p.ok && (res.Errno != "ECONNREFUSED" || res.ElapsedMS >= failFast.Milliseconds()):
			t.Errorf("%s: %s → %s %s: %q (errno %q) after %d ms, want ECONNREFUSED in < %v", p.name, p.u.name, p.network, p.addr, res.Err, res.Errno, res.ElapsedMS, failFast)
		}
	}
	if W.baitHits.Load() != before {
		t.Error("a bait listener was reached")
	}

	// DNS: only the proxy user, over UDP and TCP, to both resolvers (the IPv6 one is Fly's
	// address, inside the blocked fdaa::/16).
	for _, u := range []user{kete(), tool(), root(), other()} {
		for _, q := range [][2]string{{"udp", dnsAddr}, {"tcp", dnsAddr}, {"udp", dnsAddrV6}, {"tcp", dnsAddrV6}} {
			network := q[0]
			res := run(t, u, clientReq{Kind: "dns", Network: network, Addr: q[1]})
			if res.Err == "" {
				t.Errorf("DNS over %s as %s succeeded", network, u.name)
			}
			ok := res.Errno == "ECONNREFUSED" || (network == "udp" && res.Errno == "EPERM")
			if !ok || res.ElapsedMS >= failFast.Milliseconds() {
				t.Errorf("DNS over %s as %s: %q (errno %q) after %d ms, want a fast refusal", network, u.name, res.Err, res.Errno, res.ElapsedMS)
			}
		}
	}
	for _, q := range [][2]string{{"udp", dnsAddr}, {"tcp", dnsAddr}, {"udp", dnsAddrV6}, {"tcp", dnsAddrV6}} {
		if res := run(t, proxy(), clientReq{Kind: "dns", Network: q[0], Addr: q[1]}); res.Err != "" {
			t.Errorf("DNS over %s to %s as proxy: %q", q[0], q[1], res.Err)
		}
	}
}

// D5: with the rules missing, the proxy's own peer-uid check still refuses a user on another
// user's port.
func TestPeerUIDWithoutRules(t *testing.T) {
	removeRules(t)
	pp := startProxy(t, proxyOpts{})
	req := rawReq(kete(), pp, "gateway.test")
	req.Port = portB
	res := run(t, kete(), req)
	if res.ConnectStatus != -1 {
		t.Errorf("kete on port B got CONNECT status %d", res.ConnectStatus)
	}
	if !pp.hasReason(t, "peer_uid") {
		t.Error("peer_uid not logged")
	}
	// Control: kete on its own port gets an answer (403: phase none).
	if res := run(t, kete(), rawReq(kete(), pp, "gateway.test")); res.ConnectStatus != 403 {
		t.Errorf("kete on port A: %d", res.ConnectStatus)
	}
}

// Start-up refusals exit 2 with a one-line reason.
func TestStartupRefusals(t *testing.T) {
	cases := map[string]proxyOpts{
		"run as root":          {asRoot: true},
		"wrong listener port":  {listenPorts: [3]int{84, portB, portR}},
		"udp socket on fd 3":   {fd3UDP: true},
		"log without O_APPEND": {noAppendLog: true},
		"log not root-owned":   {logOwner: E.proxyUID},
		"extra fd 8":           {extraFD: true},
		"no no_new_privs":      {noNNP: true},
		"supplementary group":  {groups: []uint32{E.toolGID}},
		"gid 0":                {gid0: true},
	}
	for name, o := range cases {
		pp := launch(t, o)
		if code := pp.exitCode(t); code != 2 {
			t.Errorf("%s: exit %d, want 2; stderr=%s", name, code, pp.stderr.String())
		}
		t.Logf("%s: %s", name, strings.TrimSpace(pp.stderr.String()))
		if lines := strings.Count(strings.TrimSpace(pp.stderr.String()), "\n"); lines != 0 || pp.stderr.Len() == 0 {
			t.Errorf("%s: stderr %q is not one line", name, pp.stderr.String())
		}
	}
}

// The upstream trust must never include a job CA: SSL_CERT_FILE/SSL_CERT_DIR under
// /run/kete-egress, or roots containing a certificate named like the job CA, refuse start-up.
func TestTrustRefusals(t *testing.T) {
	job, err := ca.New([]string{"gateway.test"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	withJob := writePublic(t, "roots-with-job-ca.pem", append(append([]byte{}, W.caPEM...), job.CertPEM()...))
	cases := map[string]proxyOpts{
		"SSL_CERT_FILE under /run/kete-egress": {certFile: "/run/kete-egress/ca.pem"},
		"SSL_CERT_DIR under /run/kete-egress":  {certDir: "/etc/ssl/certs:/run/kete-egress"},
		"roots contain the job CA's name":      {certFile: withJob},
	}
	for name, o := range cases {
		pp := launch(t, o)
		if code := pp.exitCode(t); code != 2 {
			t.Errorf("%s: exit %d; stderr=%s", name, code, pp.stderr.String())
		}
		t.Logf("%s: %s", name, strings.TrimSpace(pp.stderr.String()))
	}
}

// fd 7 must be held by root: a control socket whose peer is another user is refused.
func TestControlPeerMustBeRoot(t *testing.T) {
	dir, err := os.MkdirTemp(E.work, "ctl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o1777); err != nil { // kete creates its socket here
		t.Fatal(err)
	}
	path := dir + "/ctl.sock"
	wait := start(t, kete(), clientReq{Kind: "unixlisten", Path: path})
	var conn net.Conn
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		c, err := net.Dial("unix", path)
		if err == nil {
			conn = c
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("kete's socket never appeared: %v", err)
		}
	}
	f, err := conn.(*net.UnixConn).File()
	if err != nil {
		t.Fatal(err)
	}
	pp := launch(t, proxyOpts{ctl: f})
	if code := pp.exitCode(t); code != 2 || !strings.Contains(pp.stderr.String(), "must be root") {
		t.Errorf("exit %d, stderr %q", code, pp.stderr.String())
	}
	_ = conn.Close()
	wait()
}

// Control protocol: a malformed line exits 2; EOF exits 0 (every other test's stop).
func TestControlMalformed(t *testing.T) {
	pp := startProxy(t, proxyOpts{})
	if m := pp.send(t, `{"type":"phase","phase":"bogus"}`); m["type"] != "error" {
		t.Errorf("unknown phase: %v", m)
	}
	if _, err := pp.ctl.WriteString("{\"type\":\"reboot\"}\n"); err != nil {
		t.Fatal(err)
	}
	if code := pp.exitCode(t); code != 2 {
		t.Errorf("malformed control line: exit %d", code)
	}
}

// Configuration v2's ruleset (forbidden sets, internal ranges, a literal upstream proxy) is valid
// nftables input: `kete-egress nft` output checked by the real nft (-c: check only, nothing applied).
func TestFirewallV2RulesetIsValid(t *testing.T) {
	c := map[string]any{
		"version":   2,
		"uids":      map[string]any{"proxy": E.proxyUID, "kete": E.keteUID, "tool": E.toolUID},
		"ports":     map[string]any{"kete": portA, "tool": portB, "root": portR},
		"resolvers": []string{"10.96.0.10:53"},
		"phases": map[string]any{
			"clone": map[string]any{"root": []string{"gitlab.corp.example:8443", "portal.kete.example"}},
			"agent": map[string]any{"kete": []string{"portal.kete.example"}},
		},
		"upstream": map[string]any{"proxy": "http://10.20.0.5:3128"},
		"internal": []map[string]any{
			{"cidr": "10.20.0.0/16", "ports": []int{443, 3128, 8443}},
			{"cidr": "fd12:3456:789a::/48", "ports": []int{443}},
		},
	}
	path, err := writeConfig(c)
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("sh", "-c", fmt.Sprintf("%s nft --config %s | nft -c -f -", E.bin, path)).CombinedOutput()
	if err != nil {
		t.Fatalf("nft -c refused the v2 ruleset: %v: %s", err, out)
	}
}
