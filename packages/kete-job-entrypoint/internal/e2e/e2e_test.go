//go:build e2e

// Package e2e asserts one run of the job image against the containerised fake platform
// (packages/kete-job-image/scripts/e2e.sh). It never starts anything: it reads the state directory
// the fake (cmd/kete-job-fake-platform, internal/fakeplatform WriteState) and e2e.sh wrote —
// job.json, calls.json, contract.json, leaks.json, checks.json, uploads/, tokens.json, plus
// job.stdout and job.exit (the job container's stdout and exit code) — and, for TestExportScan,
// the job container's `docker export` stream on stdin.
//
// One test per scenario: TestLifecycle, TestAC5, TestNoAgent; e2e.sh runs the one that matches.
package e2e

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"flag"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/fakeplatform"
)

var (
	stateDir = flag.String("state", "/state", "the e2e state directory")
	export   = flag.String("export", "", "TestExportScan: the job container's `docker export` tar (- for stdin)")
)

type state struct {
	dir      string
	job      fakeplatform.StateJob
	calls    []fakeplatform.StateCall
	contract []string
	leaks    []string
	checks   map[string]bool
	tokens   fakeplatform.StateTokens
	stdout   string
	exit     int
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

func load(t *testing.T, scenario string) *state {
	t.Helper()
	s := &state{dir: *stateDir}
	readJSON(t, filepath.Join(s.dir, "job.json"), &s.job)
	readJSON(t, filepath.Join(s.dir, "calls.json"), &s.calls)
	readJSON(t, filepath.Join(s.dir, "contract.json"), &s.contract)
	readJSON(t, filepath.Join(s.dir, "leaks.json"), &s.leaks)
	readJSON(t, filepath.Join(s.dir, "checks.json"), &s.checks)
	readJSON(t, filepath.Join(s.dir, "tokens.json"), &s.tokens)
	out, err := os.ReadFile(filepath.Join(s.dir, "job.stdout"))
	if err != nil {
		t.Fatal(err)
	}
	s.stdout = string(out)
	code, err := os.ReadFile(filepath.Join(s.dir, "job.exit"))
	if err != nil {
		t.Fatal(err)
	}
	if s.exit, err = strconv.Atoi(strings.TrimSpace(string(code))); err != nil {
		t.Fatalf("job.exit: %v", err)
	}
	wantScenario := scenario
	if scenario == "no-agent" {
		wantScenario = fakeplatform.ScenarioLifecycle
	}
	if s.job.Scenario != wantScenario || s.job.OmitAgent != (scenario == "no-agent") {
		t.Fatalf("the state is for scenario %q (omit agent %v), not %q", s.job.Scenario, s.job.OmitAgent, scenario)
	}
	t.Logf("calls: %v", s.kinds())
	return s
}

func (s *state) kinds() []string {
	var out []string
	for _, c := range s.calls {
		k := c.Kind
		if k == "events" {
			var e struct{ Phase string }
			_ = json.Unmarshal([]byte(c.Body), &e)
			k += "(" + e.Phase + ")"
		}
		out = append(out, k)
	}
	return out
}

func (s *state) first(kind string) (int, *fakeplatform.StateCall) {
	for i := range s.calls {
		if s.calls[i].Kind == kind {
			return i, &s.calls[i]
		}
	}
	return -1, nil
}

func (s *state) count(kind string) int {
	n := 0
	for _, c := range s.calls {
		if c.Kind == kind {
			n++
		}
	}
	return n
}

func (s *state) upload(t *testing.T, kind string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(s.dir, "uploads", kind))
	if err != nil {
		t.Fatalf("upload %s: %v", kind, err)
	}
	return b
}

type event struct {
	Phase   string  `json:"phase"`
	Message *string `json:"message"`
	Eff     *int    `json:"effective_timeout_minutes"`
	Extra   *int    `json:"kete_cgroup_extra"`
}

// common: the container exited 0 after a finish without push_error; the fake saw no contract
// error and no credential where it must not be; stdout holds phase lines only; every heartbeat gap
// is at most 60 s; claim → events(clone) → revoke → … → result → events(report) → uploads → the
// PUTs → events(done) → finish.
func common(t *testing.T, s *state, puts ...string) {
	t.Helper()
	if s.exit != 0 {
		t.Errorf("the job container exited %d", s.exit)
	}
	if !s.job.Finished {
		t.Fatalf("no finish was accepted; calls %v", s.kinds())
	}
	if len(s.contract) > 0 {
		t.Errorf("contract errors: %v", s.contract)
	}
	if len(s.leaks) > 0 {
		t.Errorf("credential leaks: %v", s.leaks)
	}
	// Phase lines only, and no credential on stdout.
	for _, line := range strings.Split(strings.TrimSpace(s.stdout), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Errorf("stdout line is not a phase line: %q", line)
			continue
		}
		for k := range m {
			switch k {
			case "ts", "step", "event", "code", "class", "errno", "exit_code":
			default:
				t.Errorf("phase line field %q: %q", k, line)
			}
		}
	}
	for name, tok := range s.tokenMap() {
		if strings.Contains(s.stdout, tok) {
			t.Errorf("the %s is on the container's stdout", name)
		}
	}
	// Order.
	want := append(append([]string{"claim", "events(clone)", "revoke", "result", "events(report)", "uploads"}, puts...), "events(done)", "finish")
	interesting := append([]string{"put:audit", "put:bundle", "put:proxy_log"}, want...)
	var seq []string
	for _, k := range s.kinds() {
		for _, w := range interesting {
			if k == w {
				seq = append(seq, k)
				break
			}
		}
	}
	// events(clone)/events(report) may repeat as heartbeats; keep each phase's first.
	seq = dedupe(seq)
	if strings.Join(seq, ",") != strings.Join(want, ",") {
		t.Errorf("call order\n got %v\nwant %v", seq, want)
	}
	if _, fin := s.first("finish"); fin != nil && fin.Body != "{}" && strings.Contains(fin.Body, "push_error") {
		t.Errorf("finish with a push_error: %s", fin.Body)
	}
	// Heartbeats: every gap between events while the job runs is at most 60 s; kete_cgroup_extra is 0.
	var last time.Time
	agentEff := 0
	for _, c := range s.calls {
		if c.Kind != "events" {
			continue
		}
		if !last.IsZero() && c.Time.Sub(last) > 60*time.Second {
			t.Errorf("a %v gap between events before %s", c.Time.Sub(last), c.Body)
		}
		last = c.Time
		var e event
		_ = json.Unmarshal([]byte(c.Body), &e)
		if e.Eff != nil {
			agentEff++
		}
		if e.Extra != nil && *e.Extra != 0 {
			t.Errorf("kete_cgroup_extra %d", *e.Extra)
		}
	}
	if agentEff != 1 {
		t.Errorf("%d events with effective_timeout_minutes, want 1", agentEff)
	}
}

func dedupe(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, k := range in {
		if !seen[k] {
			out = append(out, k)
		}
		seen[k] = true
	}
	return out
}

func (s *state) tokenMap() map[string]string {
	return map[string]string{"claim token": s.tokens.Claim, "callback token": s.tokens.Callback, "clone token": s.tokens.Clone, "gateway key": s.tokens.GatewayKey}
}

type result struct {
	Version   int    `json:"version"`
	Outcome   string `json:"outcome"`
	ExitCode  int    `json:"exit_code"`
	Isolated  bool   `json:"isolated"`
	Branch    string `json:"branch"`
	SessionID string `json:"session_id"`
	Message   string `json:"message"`
}

func (s *state) result(t *testing.T) result {
	t.Helper()
	_, c := s.first("result")
	if c == nil {
		t.Fatalf("no result; calls %v", s.kinds())
	}
	var r result
	if err := json.Unmarshal([]byte(c.Body), &r); err != nil {
		t.Fatalf("result: %v: %s", err, c.Body)
	}
	return r
}

// agentPhase: kete synced with the gateway key after the clone token was revoked and before its
// first model request; every model request passed the gateway's key and agent-header checks.
func agentPhase(t *testing.T, s *state) {
	t.Helper()
	revoke, _ := s.first("revoke")
	syncAt, _ := s.first("sync")
	files, _ := s.first("skill_files")
	msg, _ := s.first("messages")
	if syncAt < 0 || files < 0 || msg < 0 {
		t.Fatalf("missing sync/skill_files/messages; calls %v", s.kinds())
	}
	if !(revoke < syncAt && syncAt < files && files < msg) {
		t.Errorf("want revoke < sync < skill_files < messages: %d %d %d %d", revoke, syncAt, files, msg)
	}
	for _, c := range s.calls {
		if (c.Kind == "sync" || c.Kind == "skill_files") && c.Status != 200 && c.Status != 304 {
			t.Errorf("%s answered %d", c.Kind, c.Status)
		}
		if c.Kind == "messages" {
			if c.Status != 200 || !strings.Contains(c.Body, `"agent_headers":true`) {
				t.Errorf("a model request failed the gateway's checks: %d %s", c.Status, c.Body)
			}
		}
	}
}

type proxyLine struct {
	V      int    `json:"v"`
	Phase  string `json:"phase"`
	User   string `json:"user"`
	Host   string `json:"host"`
	Method string `json:"method"`
	Status int    `json:"status"`
	Reason string `json:"reason"`
}

func proxyLog(t *testing.T, s *state) []proxyLine {
	t.Helper()
	var out []proxyLine
	sc := bufio.NewScanner(bytes.NewReader(s.upload(t, "proxy_log")))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var l proxyLine
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil || l.V != 1 {
			t.Errorf("proxy log line is not v1: %q", sc.Text())
			continue
		}
		out = append(out, l)
	}
	return out
}

// checkProxyLog: kete reached the platform (sync) and the gateway through port A, kete has no
// refused request (models.dev is off, KETE_DISABLE_MODELS_FETCH), and no registry rule refused.
func checkProxyLog(t *testing.T, s *state, wantGateway bool) []proxyLine {
	t.Helper()
	lines := proxyLog(t, s)
	seen := map[string]bool{}
	for _, l := range lines {
		if l.Reason == "" && l.Status >= 200 && l.Status < 400 {
			seen[l.Phase+"/"+l.User+"/"+l.Host] = true
		}
		if l.User == "kete" && (l.Reason != "" || l.Status >= 400) {
			t.Errorf("a refused or failed kete request: %+v", l)
		}
		if l.Reason == "path_shape" || l.Reason == "registry_cap" {
			t.Errorf("a registry refusal: %+v", l)
		}
	}
	if !seen["agent/kete/"+fakeplatform.PlatformHost] {
		t.Errorf("no agent-phase kete request to %s in the proxy log", fakeplatform.PlatformHost)
	}
	if wantGateway && !seen["agent/kete/"+fakeplatform.GatewayHost] {
		t.Errorf("no agent-phase kete request to %s in the proxy log", fakeplatform.GatewayHost)
	}
	return lines
}

// checkAudit: the audit upload is JSONL ending the run with reason, and holds no credential.
func checkAudit(t *testing.T, s *state, reason string) {
	t.Helper()
	data := s.upload(t, "audit")
	for name, tok := range s.tokenMap() {
		if bytes.Contains(data, []byte(tok)) {
			t.Errorf("the %s is in the audit log", name)
		}
	}
	ended := false
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		var l struct{ Type, Event, Reason string }
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			t.Errorf("audit line is not JSON: %.200q", sc.Text())
			continue
		}
		if l.Type == "run" && l.Event == "ended" {
			ended = true
			if l.Reason != reason {
				t.Errorf("run ended %q, want %q", l.Reason, reason)
			}
		}
	}
	if !ended {
		t.Errorf("no `run ended` line in the audit log")
	}
}

type manifestEntry struct {
	Path    string `json:"path"`
	Mode    string `json:"mode,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
}

// readBundle parses the bundle with the format's header rules (module README "Bundle") and returns
// the manifest and the files.
func readBundle(t *testing.T, data []byte) ([]manifestEntry, map[string][]byte) {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("bundle: %v", err)
	}
	tr := tar.NewReader(zr)
	var manifest []manifestEntry
	files := map[string][]byte{}
	for i := 0; ; i++ {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("bundle: %v", err)
		}
		if h.Typeflag != tar.TypeReg || h.Mode != 0o644 || h.Uid != 0 || h.Gid != 0 || h.Uname != "" || h.Gname != "" || !h.ModTime.Equal(time.Unix(0, 0)) {
			t.Errorf("bundle header %q breaks the rules: %+v", h.Name, h)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			if h.Name != "manifest.json" {
				t.Fatalf("first entry %q", h.Name)
			}
			if err := json.Unmarshal(b, &manifest); err != nil {
				t.Fatalf("manifest: %v", err)
			}
			continue
		}
		name, ok := strings.CutPrefix(h.Name, "files/")
		if !ok {
			t.Errorf("bundle entry %q", h.Name)
		}
		files[name] = b
	}
	return manifest, files
}

func TestLifecycle(t *testing.T) {
	s := load(t, fakeplatform.ScenarioLifecycle)
	common(t, s, "put:audit", "put:bundle", "put:proxy_log")
	agentPhase(t, s)
	r := s.result(t)
	if r.Version != 1 || r.Outcome != "completed" || r.ExitCode != 0 || !r.Isolated || r.Branch != s.job.Branch {
		t.Errorf("result %+v (branch want %s)", r, s.job.Branch)
	}
	if !s.checks["tool_user"] {
		t.Errorf("the shell tool did not run as %s: checks %v", s.job.ToolUser, s.checks)
	}
	if s.count("messages") < 7 {
		t.Errorf("%d model requests, want at least 7", s.count("messages"))
	}
	// Piece A3: kete's read and write tools refused the planted symlinks.
	for _, check := range []string{"edit_ok", "symlink_read_refused", "symlink_write_refused"} {
		if !s.checks[check] {
			t.Errorf("check %s failed: checks %v", check, s.checks)
		}
	}
	manifest, files := readBundle(t, s.upload(t, "bundle"))
	want := []manifestEntry{{Path: "README.md", Mode: "100644"}}
	if got, _ := json.Marshal(manifest); string(got) != mustJSON(want) {
		t.Errorf("manifest %s, want %s", got, mustJSON(want))
	}
	if string(files["README.md"]) != s.job.EditedReadme {
		t.Errorf("files/README.md = %q, want %q", files["README.md"], s.job.EditedReadme)
	}
	checkProxyLog(t, s, true)
	checkAudit(t, s, "completed")
	checkAuditToolError(t, s, "read")
}

// checkAuditToolError: the audit (read from kete's pipe) records the refused call as a `tool` line
// with status "error".
func checkAuditToolError(t *testing.T, s *state, tool string) {
	t.Helper()
	sc := bufio.NewScanner(bytes.NewReader(s.upload(t, "audit")))
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		var l struct{ Type, Tool, Status string }
		if json.Unmarshal(sc.Bytes(), &l) == nil && l.Type == "tool" && l.Tool == tool && l.Status == "error" {
			return
		}
	}
	t.Errorf("no `tool` line for %s with status error in the audit log", tool)
}

func TestAC5(t *testing.T) {
	s := load(t, fakeplatform.ScenarioAC5)
	common(t, s, "put:audit", "put:bundle", "put:proxy_log")
	agentPhase(t, s)
	r := s.result(t)
	if r.Outcome != "completed" || r.ExitCode != 0 {
		t.Errorf("result %+v", r)
	}
	var missing []string
	for _, st := range fakeplatform.AC5Steps {
		if !s.checks[st.Marker] {
			missing = append(missing, st.Marker)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("AC5 markers not seen: %v (checks %v)", missing, s.checks)
	}
	// git: root's clone through port R with the proxy's CA (every run); Bun: kete's own TLS through
	// port A (sync and the gateway).
	lines := checkProxyLog(t, s, true)
	clone := false
	tool := map[string]bool{}
	for _, l := range lines {
		if l.Phase == "clone" && l.User == "root" && l.Host == fakeplatform.GitHost && l.Reason == "" {
			clone = true
		}
		if l.User == "tool" && l.Reason == "" && l.Status == 200 {
			tool[l.Host] = true
		}
	}
	if !clone {
		t.Errorf("no clone-phase root request to %s", fakeplatform.GitHost)
	}
	for _, h := range []string{"registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "index.crates.io", "static.crates.io"} {
		if !tool[h] {
			t.Errorf("no successful tool request to %s", h)
		}
	}
	manifest, _ := readBundle(t, s.upload(t, "bundle"))
	if len(manifest) != 0 {
		t.Errorf("manifest %v, want [] (D12)", manifest)
	}
	checkAudit(t, s, "completed")
}

func TestNoAgent(t *testing.T) {
	s := load(t, "no-agent")
	// kete refuses before any session, so there is no audit log to upload.
	common(t, s, "put:bundle", "put:proxy_log")
	r := s.result(t)
	if r.Outcome != "refused" || r.ExitCode != 2 {
		t.Errorf("result %+v, want refused / 2", r)
	}
	if n := s.count("messages"); n != 0 {
		t.Errorf("%d model requests, want none", n)
	}
	manifest, _ := readBundle(t, s.upload(t, "bundle"))
	if len(manifest) != 0 {
		t.Errorf("manifest %v, want []", manifest)
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
