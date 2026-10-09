package job

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/egress"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/gitops"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
)

const sha = "0123456789abcdef0123456789abcdef01234567"

// --- fakes ---

type fakeProxy struct {
	mu      sync.Mutex
	phases  []string
	exited  chan struct{}
	planned bool
	inst    egress.Instance
	failOn  string
}

func newProxy(inst egress.Instance) *fakeProxy {
	return &fakeProxy{exited: make(chan struct{}), inst: inst}
}

func (p *fakeProxy) Phase(ph string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failOn == ph {
		return errors.New("refused")
	}
	select {
	case <-p.exited:
		return errors.New("dead")
	default:
	}
	p.phases = append(p.phases, ph)
	return nil
}
func (p *fakeProxy) Stats() (egress.Stats, error) { return egress.Stats{}, nil }
func (p *fakeProxy) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.planned = true
	select {
	case <-p.exited:
	default:
		close(p.exited)
	}
}
func (p *fakeProxy) die() {
	p.mu.Lock()
	defer p.mu.Unlock()
	close(p.exited)
}
func (p *fakeProxy) Exited() <-chan struct{} { return p.exited }
func (p *fakeProxy) Planned() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.planned
}
func (p *fakeProxy) CAPEM() []byte { return []byte("ca") }

type fakeEgress struct {
	mu          sync.Mutex
	firewallErr error
	startErr    func(n int) error
	instances   []*fakeProxy
}

func (e *fakeEgress) Firewall(context.Context, egress.Instance) error { return e.firewallErr }
func (e *fakeEgress) Start(_ context.Context, inst egress.Instance) (Proxy, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.startErr != nil {
		if err := e.startErr(len(e.instances)); err != nil {
			return nil, err
		}
	}
	p := newProxy(inst)
	e.instances = append(e.instances, p)
	return p, nil
}
func (e *fakeEgress) current() *fakeProxy {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.instances[len(e.instances)-1]
}

type call struct {
	op   string
	body string
}

type fakePlatform struct {
	mu         sync.Mutex
	calls      []call
	claim      *platform.ClaimResponse
	claimErr   error
	eventsGone func(n int) bool
	resultErr  error
	uploads    func(ctx context.Context) error
	putErr     error
	callback   string
	events     int
	// cloneDoneErr is what CloneDone returns (nil when unset).
	cloneDoneErr error
}

func (p *fakePlatform) rec(op, body string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, call{op, body})
}
func (p *fakePlatform) ops() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []string
	for _, c := range p.calls {
		out = append(out, c.op)
	}
	return out
}
func (p *fakePlatform) find(op string) []call {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []call
	for _, c := range p.calls {
		if c.op == op {
			out = append(out, c)
		}
	}
	return out
}
func (p *fakePlatform) SetCA([]byte) error { return nil }
func (p *fakePlatform) SetCallbackToken(t string) {
	p.mu.Lock()
	p.callback = t
	p.mu.Unlock()
}
func (p *fakePlatform) Claim(_ context.Context, token string) (*platform.ClaimResponse, error) {
	p.rec("claim", token)
	if p.claimErr != nil {
		return nil, p.claimErr
	}
	c := *p.claim
	return &c, nil
}
func (p *fakePlatform) Events(_ context.Context, e platform.Event) error {
	b, _ := json.Marshal(e)
	p.mu.Lock()
	p.events++
	n := p.events
	p.mu.Unlock()
	if p.eventsGone != nil && p.eventsGone(n) {
		p.rec("events-404", string(b))
		return platform.ErrGone
	}
	p.rec("events", string(b))
	return nil
}
func (p *fakePlatform) Result(_ context.Context, raw []byte) error {
	p.rec("result", string(raw))
	return p.resultErr
}
func (p *fakePlatform) Uploads(ctx context.Context, b bool) (*platform.UploadURLs, error) {
	p.rec("uploads", map[bool]string{true: "bundle", false: "nobundle"}[b])
	if p.uploads != nil {
		if err := p.uploads(ctx); err != nil {
			return nil, err
		}
	}
	u := &platform.UploadURLs{Audit: platform.Upload{URL: "https://storage.test/a"}, ProxyLog: platform.Upload{URL: "https://storage.test/p"}, Host: "storage.test"}
	if b {
		u.Bundle = &platform.Upload{URL: "https://storage.test/b"}
	}
	return u, nil
}
func (p *fakePlatform) Put(_ context.Context, url, _ string, r io.Reader, _ int64) error {
	b, _ := io.ReadAll(r)
	p.rec("put", url+" "+string(b))
	return p.putErr
}
func (p *fakePlatform) Finish(_ context.Context, pushError string) error {
	p.rec("finish", pushError)
	return nil
}
func (p *fakePlatform) Revoke(context.Context, string, string) error {
	p.rec("revoke", "")
	return nil
}
func (p *fakePlatform) CloneDone(context.Context) error {
	p.rec("clone-done", "")
	return p.cloneDoneErr
}

type fakeGit struct {
	cloneErr, verifyErr, copyErr error
	username, token              string // the clone's credentials

	// Orchestrated jobs: refs maps a full ref to its commit (ResolveCommit); FetchRefs adds
	// fetched (refs/kete/<name> → the commit fetchAt names for the branch, else nothing); blobs
	// maps "<commit>:<path>" to its bytes.
	refs      map[string]string
	fetchAt   map[string]string
	blobs     map[string][]byte
	pinErr    error
	fetchErr  error
	pinned    string
	fetched   []gitops.RefSpec
	depth1    bool
	keteRefs  bool
	fetchUser string

	review reviewGit
}

func (g *fakeGit) CheckBranch(context.Context, string) bool { return true }
func (g *fakeGit) Clone(_ context.Context, _, _, username, token, _ string) error {
	g.username, g.token = username, token
	return g.cloneErr
}
func (g *fakeGit) Verify(context.Context, string, string, string) error { return g.verifyErr }
func (g *fakeGit) AgentCopy(context.Context, string, string, string, string) error {
	return g.copyErr
}
func (g *fakeGit) ResolveCommit(_ context.Context, _, ref string) (string, error) {
	if sha, ok := g.refs[ref]; ok {
		return sha, nil
	}
	return "", errors.New("no such ref")
}
func (g *fakeGit) PinBase(_ context.Context, _, ref, _, _, baseSHA, _ string) error {
	if g.pinErr != nil {
		return g.pinErr
	}
	g.pinned = baseSHA
	if g.refs == nil {
		g.refs = map[string]string{}
	}
	g.refs["refs/heads/"+ref] = baseSHA
	return nil
}
func (g *fakeGit) FetchRefs(_ context.Context, _, _, username, _ string, refs []gitops.RefSpec, depth1 bool) error {
	g.fetched, g.depth1, g.fetchUser = refs, depth1, username
	if g.fetchErr != nil {
		return g.fetchErr
	}
	if g.refs == nil {
		g.refs = map[string]string{}
	}
	for _, s := range refs {
		if sha, ok := g.fetchAt[s.Branch]; ok {
			g.refs["refs/kete/"+s.Name] = sha
		}
	}
	return nil
}
func (g *fakeGit) CatBlob(_ context.Context, _, object string, max int64) ([]byte, error) {
	b, ok := g.blobs[object]
	if !ok {
		return nil, errors.New("no such object")
	}
	if int64(len(b)) > max {
		return nil, gitops.ErrOutputTooLarge
	}
	return b, nil
}
func (g *fakeGit) CopyKeteRefs(context.Context, string, string) error {
	g.keteRefs = true
	return nil
}

// Review jobs: ReviewClone records its arguments and sets refs/heads/<branch> to reviewHead (the
// claim's base_sha when empty); ReviewDeepen moves it to deepenHead when set; MergeBase answers
// mergeBases in turn (gitops.ErrNoMergeBase for ""); Diff answers diff.
type reviewGit struct {
	cloneArgs  []string
	cloneErr   error
	head       string
	deepened   int
	deepenHead string
	mergeBases []string
	mbCalls    int
	diff       gitops.ReviewDiff
	storageErr error
	diffErr    error
}

func (g *fakeGit) ReviewClone(_ context.Context, url, username, token, headRef, branch, baseBranch string, depth int, dest string) error {
	g.review.cloneArgs = []string{url, username, headRef, branch, baseBranch, strconv.Itoa(depth), dest}
	g.username, g.token = username, token
	if g.review.cloneErr != nil {
		return g.review.cloneErr
	}
	if g.refs == nil {
		g.refs = map[string]string{}
	}
	if g.review.head != "" {
		g.refs["refs/heads/"+branch] = g.review.head
	} else {
		g.refs["refs/heads/"+branch] = sha
	}
	return nil
}
func (g *fakeGit) ReviewDeepen(_ context.Context, _, _, _, _, _, branch, _ string, deepen int) error {
	g.review.deepened = deepen
	if g.review.deepenHead != "" {
		g.refs["refs/heads/"+branch] = g.review.deepenHead
	}
	return nil
}
func (g *fakeGit) MergeBase(context.Context, string, string, string) (string, error) {
	i := g.review.mbCalls
	g.review.mbCalls++
	if len(g.review.mergeBases) == 0 {
		return "1111111111111111111111111111111111111111", nil
	}
	if i >= len(g.review.mergeBases) {
		i = len(g.review.mergeBases) - 1
	}
	if g.review.mergeBases[i] == "" {
		return "", gitops.ErrNoMergeBase
	}
	return g.review.mergeBases[i], nil
}
func (g *fakeGit) VerifyStorage(context.Context, string) error { return g.review.storageErr }
func (g *fakeGit) Diff(context.Context, string, string, string, int64, int64) (gitops.ReviewDiff, error) {
	return g.review.diff, g.review.diffErr
}

type fakeHelper struct {
	exited chan struct{}
	once   sync.Once
	m      *fakeMachine
}

func (h *fakeHelper) Exited() <-chan struct{} { return h.exited }
func (h *fakeHelper) Stop()                   { h.once.Do(func() { close(h.exited) }) }
func (h *fakeHelper) Kill() {
	h.m.record("helper-kill")
	h.Stop()
}

type fakeKete struct {
	done chan struct{}
	code int
	once sync.Once
	// ignoreTerm: SIGTERM does nothing (a hung kete)
	ignoreTerm bool
}

func (k *fakeKete) Done() <-chan struct{} { return k.done }
func (k *fakeKete) ExitCode() int         { return k.code }
func (k *fakeKete) Signal(syscall.Signal) {
	if !k.ignoreTerm {
		k.exit(143)
	}
}
func (k *fakeKete) exit(code int) { k.once.Do(func() { k.code = code; close(k.done) }) }

type fakeMachine struct {
	mu          sync.Mutex
	helperErr   error
	isoErr      error
	isoChecked  bool
	kete        *fakeKete
	keteErr     error
	keteStdout  string
	reapErr     error
	bundleErr   error
	spec        []byte
	keteStarted bool
	killedNow   bool
	onStartKete func(k *fakeKete)
	// extra is what KeteExtra returns ((0, nil) when nil).
	extra func() (int, error)
	order []string
	// audit is what OpenAudit returns ("audit" when nil); auditErr its error.
	audit    *string
	auditErr error
	// bundleKind is the rule the last BuildBundle was asked for; keteEnv StartKete's environment.
	bundleRule bundle.Rule
	keteEnv    KeteEnv
	// turn is what ReadOrchestrationTurn returns (os.ErrNotExist when nil).
	turn []byte
}

func (m *fakeMachine) record(s string) {
	m.mu.Lock()
	m.order = append(m.order, s)
	m.mu.Unlock()
}

func (m *fakeMachine) StartHelper(context.Context) (Helper, error) {
	if m.helperErr != nil {
		return nil, m.helperErr
	}
	return &fakeHelper{exited: make(chan struct{}), m: m}, nil
}
func (m *fakeMachine) CheckIsolation(context.Context) error {
	m.isoChecked = true
	return m.isoErr
}
func (m *fakeMachine) PrepareWorktree() error { return nil }
func (m *fakeMachine) WriteSpec(s []byte) error {
	m.spec = s
	return nil
}
func (m *fakeMachine) StartKete(_ context.Context, env KeteEnv) (Kete, error) {
	m.keteEnv = env
	if m.keteErr != nil {
		return nil, m.keteErr
	}
	m.mu.Lock()
	m.keteStarted = true
	m.mu.Unlock()
	if m.kete == nil {
		m.kete = &fakeKete{done: make(chan struct{})}
		m.kete.exit(0)
	}
	if m.onStartKete != nil {
		go m.onStartKete(m.kete)
	}
	return m.kete, nil
}
func (m *fakeMachine) KeteExtra() (int, error) {
	if m.extra != nil {
		return m.extra()
	}
	return 0, nil
}
func (m *fakeMachine) Reap(context.Context) error { return m.reapErr }
func (m *fakeMachine) KillNow() {
	m.record("cgroup-kill")
	m.mu.Lock()
	m.killedNow = true
	m.mu.Unlock()
	if m.kete != nil {
		m.kete.exit(137)
	}
}
func (m *fakeMachine) KillKete() {
	if m.kete != nil {
		m.kete.exit(137)
	}
}
func (m *fakeMachine) ReadKeteStdout() ([]byte, error) { return []byte(m.keteStdout), nil }
func (m *fakeMachine) OpenAudit() (io.ReadCloser, int64, error) {
	if m.auditErr != nil {
		return nil, 0, m.auditErr
	}
	text := "audit"
	if m.audit != nil {
		text = *m.audit
	}
	return io.NopCloser(strings.NewReader(text)), int64(len(text)), nil
}
func (m *fakeMachine) OpenProxyLog() (io.ReadCloser, int64, error) {
	return io.NopCloser(strings.NewReader("proxylog")), 8, nil
}
func (m *fakeMachine) ReadOrchestrationTurn() ([]byte, error) {
	if m.turn == nil {
		return nil, os.ErrNotExist
	}
	return m.turn, nil
}
func (m *fakeMachine) BuildBundle(_ context.Context, _ string, rule bundle.Rule) (*bundle.Result, error) {
	m.bundleRule = rule
	if m.bundleErr != nil {
		return nil, m.bundleErr
	}
	return &bundle.Result{Path: "/dev/null", Size: 0}, nil
}

type env struct {
	eg  *fakeEgress
	pf  *fakePlatform
	git *fakeGit
	m   *fakeMachine
	out *bytes.Buffer
	d   Deps
}

const keteResult = `{"version":1,"outcome":"completed","exit_code":0,"session_id":"ses_abc","denied":[]}`

func newEnv(deadline time.Duration) *env {
	e := &env{eg: &fakeEgress{}, git: &fakeGit{}, m: &fakeMachine{keteStdout: "noise\n" + keteResult + "\n"}, out: &bytes.Buffer{}}
	cr := &platform.ClaimResponse{
		Spec:          json.RawMessage(`{"version":1,"prompt":"p","policy":{"version":1,"budget":5,"timeout":30},"branch":"kete/job/x"}`),
		GatewayKey:    "gwkey-0123456789",
		CallbackToken: "callback-0123456789",
		GatewayURL:    "https://gateway.kete.test",
		PlatformURL:   "https://platform.kete.test",
		Deadline:      time.Now().Add(deadline).UTC().Format(time.RFC3339Nano),
	}
	cr.Clone.URL = "https://github.kete.test/org/repo.git"
	cr.Clone.Token = "clone-0123456789"
	cr.Clone.Ref = "main"
	cr.Clone.BaseSHA = sha
	e.pf = &fakePlatform{claim: cr}
	cfg := layout.Default()
	cfg.Minute = 100 * time.Millisecond
	cfg.FinalizeReserve = 200 * time.Millisecond
	cfg.BackstopExtra = 100 * time.Millisecond
	cfg.KillWait = 50 * time.Millisecond
	cfg.Heartbeat = time.Hour
	cfg.ReapTimeout = 100 * time.Millisecond
	e.d = Deps{
		Cfg: cfg, Log: phaselog.New(e.out),
		Boot:   bootenv.Values{JobID: "0b9a3c1e-2f4d-4e6a-8b7c-1d2e3f4a5b6c", PlatformURL: "https://platform.kete.test", ClaimToken: strings.Repeat("c", 40), StorageHost: "storage.test"},
		Egress: e.eg, Platform: e.pf, Git: e.git, Machine: e.m,
	}
	return e
}

func (e *env) run(t *testing.T) int {
	t.Helper()
	done := make(chan int, 1)
	go func() { done <- Run(context.Background(), e.d) }()
	select {
	case code := <-done:
		return code
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return")
		return -1
	}
}

func lastFinish(t *testing.T, pf *fakePlatform) string {
	t.Helper()
	f := pf.find("finish")
	if len(f) != 1 {
		t.Fatalf("finish calls = %d (ops %v)", len(f), pf.ops())
	}
	return f[0].body
}

func resultOf(t *testing.T, pf *fakePlatform) map[string]any {
	t.Helper()
	r := pf.find("result")
	if len(r) != 1 {
		t.Fatalf("result calls = %d (ops %v)", len(r), pf.ops())
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(r[0].body), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// --- tests ---

func TestEffectiveTimeout(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		policy int
		left   time.Duration
		want   int
	}{
		{30, 60 * time.Minute, 30},
		{30, 20 * time.Minute, 15},
		{30, 6*time.Minute + 59*time.Second, 1},
		{30, 5*time.Minute + 59*time.Second, 0},
		{30, time.Minute, 0},
		{30, -time.Minute, 0},
	}
	for _, c := range cases {
		if got := EffectiveTimeout(c.policy, now.Add(c.left), now, 5*time.Minute, time.Minute); got != c.want {
			t.Errorf("policy %d left %v: got %d, want %d", c.policy, c.left, got, c.want)
		}
	}
}

func TestParseKeteResult(t *testing.T) {
	if b, ok := ParseKeteResult([]byte(keteResult)); !ok || string(b) != keteResult {
		t.Errorf("whole: %s %v", b, ok)
	}
	if b, ok := ParseKeteResult([]byte("log line\n" + keteResult + "\n\n")); !ok || string(b) != keteResult {
		t.Errorf("last line: %s %v", b, ok)
	}
	for _, bad := range []string{"", "x", `{"version":2,"outcome":"completed","exit_code":0}`, `{"version":1,"exit_code":0}`, `{"version":1,"outcome":"x","exit_code":1.5}`, keteResult + "\ntrailing"} {
		if _, ok := ParseKeteResult([]byte(bad)); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

// N5: the audit read from kete's pipe is uploaded as is; an empty pipe, an over-limit one or a
// stuck reader uploads nothing and sends a fixed note.
func TestAuditUpload(t *testing.T) {
	empty := ""
	cases := []struct {
		name  string
		audit *string
		err   error
		put   bool
		note  string
	}{
		{name: "ok", put: true},
		{name: "empty", audit: &empty, note: "audit log not uploaded: empty"},
		{name: "too large", err: ErrAuditTooLarge, note: "audit log not uploaded: too large"},
		{name: "stuck", err: ErrAuditReaderStuck, note: "audit log not uploaded: reader stuck"},
		{name: "missing", err: errors.New("no such file"), note: "audit log not uploaded: missing or refused"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(time.Hour)
			e.m.audit, e.m.auditErr = c.audit, c.err
			if code := e.run(t); code != 0 {
				t.Fatalf("exit %d; log %s", code, e.out)
			}
			put := false
			for _, op := range e.pf.find("put") {
				if strings.HasPrefix(op.body, "https://storage.test/a ") {
					put = true
					if op.body != "https://storage.test/a audit" {
						t.Errorf("audit put = %q", op.body)
					}
				}
			}
			if put != c.put {
				t.Errorf("audit put = %v, want %v", put, c.put)
			}
			if c.note != "" {
				found := false
				for _, ev := range e.pf.find("events") {
					if strings.Contains(ev.body, c.note) {
						found = true
					}
				}
				if !found {
					t.Errorf("no %q note", c.note)
				}
			}
		})
	}
}

func TestLifecycle(t *testing.T) {
	e := newEnv(time.Hour)
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d; log %s", code, e.out)
	}
	ops := strings.Join(e.pf.ops(), ",")
	if !strings.HasPrefix(ops, "claim,events,revoke,clone-done,events,") {
		t.Errorf("ops = %s", ops)
	}
	if !strings.HasSuffix(ops, "result,events,uploads,put,put,put,events,finish") {
		t.Errorf("ops = %s", ops)
	}
	if r := e.pf.find("result")[0].body; r != keteResult {
		t.Errorf("result not verbatim: %s", r)
	}
	if lastFinish(t, e.pf) != "" {
		t.Error("push_error on a clean run")
	}
	if e.pf.find("claim")[0].body != strings.Repeat("c", 40) || e.pf.callback != "callback-0123456789" {
		t.Error("claim token or callback token")
	}
	var first map[string]any
	for _, ev := range e.pf.find("events") {
		_ = json.Unmarshal([]byte(ev.body), &first)
		if first["phase"] == "agent" {
			break
		}
	}
	if first["effective_timeout_minutes"] == nil {
		t.Errorf("first agent event has no effective_timeout_minutes: %v", first)
	}
	var spec map[string]any
	_ = json.Unmarshal(e.m.spec, &spec)
	if spec["policy"].(map[string]any)["timeout"].(float64) != 30 || spec["branch"] != "kete/job/x" {
		t.Errorf("spec = %s", e.m.spec)
	}
	// Instances: 1 (claim), 2 (agent), 3 (report + storage).
	if n := len(e.eg.instances); n != 3 {
		t.Errorf("proxy instances = %d", n)
	}
	// GHES: the clone phase reaches the platform, the clone host and its revoke API host (the same
	// host here); no later phase reaches the git host.
	if got := strings.Join(e.eg.instances[1].inst.Clone.Root, ","); got != "platform.kete.test,github.kete.test" {
		t.Errorf("clone allowlist = %s", got)
	}
	if e.git.username != "x-access-token" || e.git.token != "clone-0123456789" {
		t.Errorf("clone credentials %q", e.git.username)
	}
	if !contains(e.eg.instances[2].inst.Report.Root, "storage.test") || !contains(e.eg.instances[1].inst.Agent.Kete, "gateway.kete.test") {
		t.Error("instance allowlists")
	}
	if !strings.Contains(e.out.String(), `"step":"job","event":"exit","exit_code":0`) {
		t.Errorf("phase log: %s", e.out)
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func TestRefuseClaimWithoutGuard(t *testing.T) {
	for name, mod := range map[string]func(*env){
		"firewall": func(e *env) { e.eg.firewallErr = errors.New("nft") },
		"proxy":    func(e *env) { e.eg.startErr = func(int) error { return errors.New("proxy") } },
		"helper":   func(e *env) { e.m.helperErr = errors.New("helper") },
	} {
		e := newEnv(time.Hour)
		mod(e)
		if code := e.run(t); code != 1 {
			t.Errorf("%s: exit %d", name, code)
		}
		if len(e.pf.calls) != 0 {
			t.Errorf("%s: callbacks %v", name, e.pf.ops())
		}
	}
}

// The isolation check runs after the helper and before claim; any failure exits 1 with no
// callback, and the phase line carries the fixed reason (and a probe error's class, never text).
func TestRefuseClaimWithoutIsolation(t *testing.T) {
	cases := map[string]struct {
		err  error
		want string
	}{
		"reachable": {&isolation.Failure{Reason: phaselog.CodeFlyAPI}, `"step":"isolation","event":"failed","code":"fly_api"}`},
		"probe":     {&isolation.Failure{Reason: phaselog.CodeProbe, Err: syscall.EACCES}, `"step":"isolation","event":"failed","code":"probe","class":"errno","errno":13}`},
		"other":     {errors.New("secret-text"), `"step":"isolation","event":"failed","code":"probe","class":"other"}`},
	}
	for name, c := range cases {
		e := newEnv(time.Hour)
		e.m.isoErr = c.err
		if code := e.run(t); code != 1 {
			t.Errorf("%s: exit %d", name, code)
		}
		if len(e.pf.calls) != 0 {
			t.Errorf("%s: callbacks %v", name, e.pf.ops())
		}
		out := e.out.String()
		if !strings.Contains(out, c.want) {
			t.Errorf("%s: phase lines lack %s:\n%s", name, c.want, out)
		}
		if strings.Contains(out, "secret-text") {
			t.Errorf("%s: error text on stdout", name)
		}
	}
	e := newEnv(time.Hour)
	if code := e.run(t); code != 0 || !e.m.isoChecked {
		t.Errorf("passing check: exit %d checked %v", code, e.m.isoChecked)
	}
	e = newEnv(time.Hour)
	e.m.helperErr = errors.New("helper")
	if e.run(t); e.m.isoChecked {
		t.Error("the check ran without the helper")
	}
}

func TestClaimFailures(t *testing.T) {
	e := newEnv(time.Hour)
	e.pf.claimErr = platform.ErrReplayed
	if code := e.run(t); code != 1 || len(e.pf.calls) != 1 {
		t.Errorf("replayed: exit %d ops %v", code, e.pf.ops())
	}
	e = newEnv(time.Hour)
	e.pf.claim.CallbackToken = ""
	if code := e.run(t); code != 1 || len(e.pf.calls) != 1 {
		t.Errorf("no callback token: exit %d ops %v", code, e.pf.ops())
	}
}

func TestInvalidClaimReportsError(t *testing.T) {
	e := newEnv(time.Hour)
	e.pf.claim.Spec = json.RawMessage(`{"version":1,"prompt":"p","policy":{"version":1,"budget":5,"timeout":30}}`)
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	r := resultOf(t, e.pf)
	if r["outcome"] != "error" || r["message"] != "invalid claim response: spec.branch" {
		t.Errorf("result = %v", r)
	}
	if e.m.keteStarted {
		t.Error("kete started")
	}
	if e.pf.find("uploads")[0].body != "nobundle" {
		t.Error("bundle requested")
	}
}

func TestCloneWrongCommit(t *testing.T) {
	e := newEnv(time.Hour)
	e.git.verifyErr = gitops.ErrMismatch
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	r := resultOf(t, e.pf)
	if r["outcome"] != "refused" || r["exit_code"].(float64) != 2 {
		t.Errorf("result = %v", r)
	}
	// Every clone-phase failure releases the clone token (here GitHub's revoke), before the result.
	if e.m.keteStarted || len(e.pf.find("revoke")) != 1 || !strings.HasPrefix(strings.Join(e.pf.ops(), ","), "claim,events,revoke,") {
		t.Errorf("kete started, or the token wasn't revoked once before the result: %v", e.pf.ops())
	}
}

func TestCloneFailedScrubsToken(t *testing.T) {
	e := newEnv(time.Hour)
	e.git.cloneErr = &gitops.Error{ExitCode: 128, Stderr: []byte("fatal: auth clone-0123456789 failed\nAuthorization: Basic xyz\n")}
	e.run(t)
	r := resultOf(t, e.pf)
	msg := r["message"].(string)
	if !strings.HasPrefix(msg, "clone failed") || strings.Contains(msg, "clone-0123456789") || strings.Contains(msg, "Basic") {
		t.Errorf("message = %q", msg)
	}
}

func TestDeadlineTooShort(t *testing.T) {
	e := newEnv(250 * time.Millisecond) // reserve 200ms, unit 100ms: eff 0
	e.run(t)
	r := resultOf(t, e.pf)
	if r["outcome"] != "deadline" || r["exit_code"].(float64) != 1 {
		t.Errorf("result = %v", r)
	}
	if e.m.keteStarted {
		t.Error("kete started")
	}
}

func TestKeteWithoutResult(t *testing.T) {
	e := newEnv(time.Hour)
	e.m.keteStdout = "garbage"
	e.m.kete = &fakeKete{done: make(chan struct{})}
	e.m.kete.exit(7)
	e.run(t)
	r := resultOf(t, e.pf)
	if r["outcome"] != "error" || r["exit_code"].(float64) != 7 {
		t.Errorf("result = %v", r)
	}
}

func TestProxyFailed(t *testing.T) {
	e := newEnv(time.Hour)
	e.m.kete = &fakeKete{done: make(chan struct{})}
	e.m.onStartKete = func(*fakeKete) {
		time.Sleep(50 * time.Millisecond)
		e.eg.current().die()
	}
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	r := resultOf(t, e.pf)
	if r["outcome"] != "proxy_failed" {
		t.Errorf("result = %v", r)
	}
	if lastFinish(t, e.pf) != PushProxyFailed || e.pf.find("uploads")[0].body != "nobundle" {
		t.Errorf("finish/uploads: %v", e.pf.ops())
	}
}

// With a job process alive the proxy is never restarted (D2): result and finish go through the
// instance already in the report phase, and nothing is uploaded.
func TestProcessesAlive(t *testing.T) {
	e := newEnv(time.Hour)
	e.m.reapErr = errors.New("alive")
	e.run(t)
	if lastFinish(t, e.pf) != PushProcessesAlive || len(e.pf.find("uploads")) != 0 || len(e.pf.find("put")) != 0 {
		t.Errorf("ops %v", e.pf.ops())
	}
	if resultOf(t, e.pf)["outcome"] != "completed" {
		t.Error("kete's result not sent")
	}
	if n := len(e.eg.instances); n != 2 {
		t.Errorf("proxy instances = %d, want 2 (no restart while processes are alive)", n)
	}
}

// Processes alive and the proxy dead: no restart, so nothing can be reported; exit 1.
func TestProcessesAliveProxyDead(t *testing.T) {
	e := newEnv(time.Hour)
	e.m.reapErr = errors.New("alive")
	e.m.kete = &fakeKete{done: make(chan struct{})}
	e.m.onStartKete = func(*fakeKete) {
		time.Sleep(50 * time.Millisecond)
		e.eg.current().die()
	}
	if code := e.run(t); code != 1 {
		t.Errorf("exit %d", code)
	}
	if len(e.pf.find("result")) != 0 || len(e.pf.find("finish")) != 0 || len(e.eg.instances) != 2 {
		t.Errorf("ops %v, instances %d", e.pf.ops(), len(e.eg.instances))
	}
}

func TestStorageHostClashRefused(t *testing.T) {
	e := newEnv(time.Hour)
	e.d.Boot.StorageHost = "gateway.kete.test"
	e.run(t)
	if r := resultOf(t, e.pf); r["message"] != "invalid claim response: storage_host" {
		t.Errorf("result = %v", r)
	}
	if e.m.keteStarted {
		t.Error("kete started")
	}
}

func TestSignalAbort(t *testing.T) {
	e := newEnv(time.Hour)
	e.m.kete = &fakeKete{done: make(chan struct{}), ignoreTerm: true}
	ctx, cancel := context.WithCancel(context.Background())
	e.m.onStartKete = func(*fakeKete) {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}
	if code := Run(ctx, e.d); code != 1 {
		t.Errorf("exit %d", code)
	}
	if !strings.Contains(e.out.String(), `"step":"abort","event":"failed","code":"signal"`) || len(e.pf.find("result")) != 0 {
		t.Errorf("log %s ops %v", e.out, e.pf.ops())
	}
	if strings.Join(e.m.order, ",") != "helper-kill,cgroup-kill" {
		t.Errorf("kill order = %v", e.m.order)
	}
}

func TestBundleRefused(t *testing.T) {
	e := newEnv(time.Hour)
	e.m.bundleErr = bundle.Refuse(bundle.RefuseSymlink, "a symlink in the worktree")
	e.run(t)
	if lastFinish(t, e.pf) != "symlink" || e.pf.find("uploads")[0].body != "nobundle" {
		t.Errorf("ops %v", e.pf.ops())
	}
}

func TestBackstopTimeLimit(t *testing.T) {
	e := newEnv(time.Hour)
	e.d.Platform.(*fakePlatform).claim.Spec = json.RawMessage(`{"version":1,"prompt":"p","policy":{"version":1,"budget":5,"timeout":1},"branch":"kete/job/x"}`)
	e.m.keteStdout = ""
	e.m.kete = &fakeKete{done: make(chan struct{}), ignoreTerm: true}
	e.run(t)
	r := resultOf(t, e.pf)
	if r["outcome"] != "time_limit" || r["exit_code"].(float64) != 3 {
		t.Errorf("result = %v", r)
	}
}

func TestCancelled(t *testing.T) {
	e := newEnv(time.Hour)
	e.m.kete = &fakeKete{done: make(chan struct{})}
	e.d.Cfg.Heartbeat = 20 * time.Millisecond
	e.pf.eventsGone = func(n int) bool { return n >= 3 }
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	ops := e.pf.ops()
	if ops[len(ops)-1] != "events-404" {
		t.Errorf("callbacks after the 404: %v", ops)
	}
	if len(e.pf.find("result")) != 0 || len(e.pf.find("finish")) != 0 {
		t.Errorf("ops %v", ops)
	}
}

func TestHardDeadline(t *testing.T) {
	e := newEnv(1500 * time.Millisecond)
	e.m.kete = &fakeKete{done: make(chan struct{}), ignoreTerm: true}
	e.pf.uploads = func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }
	start := time.Now()
	code := e.run(t)
	if code != 1 {
		t.Errorf("exit %d", code)
	}
	if time.Since(start) > 3500*time.Millisecond {
		t.Errorf("took %v", time.Since(start))
	}
	if !e.m.killedNow || len(e.pf.find("finish")) != 0 {
		t.Errorf("killed=%v ops %v", e.m.killedNow, e.pf.ops())
	}
}

// ADR 0019 rule 5: an agent-phase heartbeat carries the kete cgroup's extra-process count, and a
// check that fails says so in the event's message instead of leaving the count out silently.
func TestHeartbeatKeteCgroupCheck(t *testing.T) {
	cases := []struct {
		name  string
		extra func() (int, error)
		want  string
	}{
		{"stray process", func() (int, error) { return 2, nil }, `"kete_cgroup_extra":2`},
		{"check failed", func() (int, error) { return 0, errors.New("cgroup.procs: permission denied") }, KeteCheckFailed},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(time.Hour)
			e.d.Cfg.Heartbeat = 10 * time.Millisecond
			e.m.extra = c.extra
			e.m.kete = &fakeKete{done: make(chan struct{})}
			e.m.onStartKete = func(k *fakeKete) {
				time.Sleep(150 * time.Millisecond)
				k.exit(0)
			}
			if code := e.run(t); code != 0 {
				t.Fatalf("exit %d; log %s", code, e.out)
			}
			found := false
			for _, ev := range e.pf.find("events") {
				if strings.Contains(ev.body, `"phase":"agent"`) && strings.Contains(ev.body, c.want) {
					found = true
				}
			}
			if !found {
				t.Errorf("no agent heartbeat with %q in %v", c.want, e.pf.find("events"))
			}
		})
	}
}

// harnessEnv is a Harness Code claim (jobs-v1 additive, 2026-10-05).
func harnessEnv() *env {
	e := newEnv(time.Hour)
	e.pf.claim.Clone.URL = "https://git.harness.kete.test/acct/default/shop/web.git"
	e.pf.claim.Clone.Provider = json.RawMessage(`"harness_code"`)
	e.pf.claim.Clone.Username = json.RawMessage(`"kete_code_clone"`)
	return e
}

func noLaterGitHost(t *testing.T, e *env, gitHost string) {
	t.Helper()
	for i, p := range e.eg.instances {
		for _, list := range [][]string{p.inst.Agent.Kete, p.inst.Agent.Tool, p.inst.Agent.Root, p.inst.Report.Root} {
			if contains(list, gitHost) {
				t.Errorf("instance %d reaches the git host after the clone", i+1)
			}
		}
	}
}

func TestHarnessLifecycle(t *testing.T) {
	e := harnessEnv()
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d; log %s", code, e.out)
	}
	ops := strings.Join(e.pf.ops(), ",")
	if !strings.HasPrefix(ops, "claim,events,clone-done,events,") || strings.Contains(ops, "revoke") {
		t.Errorf("ops = %s", ops)
	}
	if !strings.HasSuffix(ops, "result,events,uploads,put,put,put,events,finish") {
		t.Errorf("ops = %s", ops)
	}
	// The clone phase reaches exactly the platform and the clone host (no API host).
	if got := strings.Join(e.eg.instances[1].inst.Clone.Root, ","); got != "platform.kete.test,git.harness.kete.test" {
		t.Errorf("clone allowlist = %s", got)
	}
	noLaterGitHost(t, e, "git.harness.kete.test")
	if e.git.username != "kete_code_clone" || e.git.token != "clone-0123456789" {
		t.Errorf("clone credentials %q", e.git.username)
	}
	if !strings.Contains(e.out.String(), `"step":"clone_done","event":"ok"`) || strings.Contains(e.out.String(), `"step":"revoke"`) {
		t.Errorf("phase log: %s", e.out)
	}
	if lastFinish(t, e.pf) != "" {
		t.Error("push_error on a clean run")
	}
}

// A clone failure calls clone-done before the result, and the message carries neither the token
// nor its basic-auth value.
func TestHarnessCloneFailed(t *testing.T) {
	e := harnessEnv()
	b64 := base64.StdEncoding.EncodeToString([]byte("kete_code_clone:clone-0123456789"))
	e.git.cloneErr = &gitops.Error{ExitCode: 128, Stderr: []byte("fatal: auth clone-0123456789 failed\nsent " + b64 + "\nAuthorization: Basic " + b64 + "\n")}
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	ops := strings.Join(e.pf.ops(), ",")
	if !strings.HasPrefix(ops, "claim,events,clone-done,result,") || strings.Contains(ops, "revoke") {
		t.Errorf("ops = %s", ops)
	}
	msg := resultOf(t, e.pf)["message"].(string)
	if !strings.HasPrefix(msg, "clone failed") || strings.Contains(msg, "clone-0123456789") || strings.Contains(msg, b64) || strings.Contains(msg, "Basic") {
		t.Errorf("message = %q", msg)
	}
}

// HEAD ≠ base_sha: clone-done, then the refused result; kete never starts.
func TestHarnessWrongCommit(t *testing.T) {
	e := harnessEnv()
	e.git.verifyErr = gitops.ErrMismatch
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	ops := strings.Join(e.pf.ops(), ",")
	if !strings.HasPrefix(ops, "claim,events,clone-done,result,") || strings.Contains(ops, "revoke") {
		t.Errorf("ops = %s", ops)
	}
	if r := resultOf(t, e.pf); r["outcome"] != "refused" || r["exit_code"].(float64) != 2 {
		t.Errorf("result = %v", r)
	}
	if e.m.keteStarted {
		t.Error("kete started after a wrong commit")
	}
}

// A clone-done that keeps failing is said on the job; the job goes on (the platform's backstops
// delete the token).
func TestHarnessCloneDoneFails(t *testing.T) {
	e := harnessEnv()
	e.pf.cloneDoneErr = errors.New("platform: clone-done: unexpected status 500")
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d; log %s", code, e.out)
	}
	found := false
	for _, ev := range e.pf.find("events") {
		if strings.Contains(ev.body, "clone token revoke failed") {
			found = true
		}
	}
	if !found || !e.m.keteStarted {
		t.Errorf("revoke failure not reported or job stopped: %v", e.pf.ops())
	}
	if !strings.Contains(e.out.String(), `"step":"clone_done","event":"failed","code":"failed"`) {
		t.Errorf("phase log: %s", e.out)
	}
}

// A 404 from clone-done is a gone job: kill everything, no more callbacks, exit 0.
func TestHarnessCloneDoneGone(t *testing.T) {
	e := harnessEnv()
	e.pf.cloneDoneErr = platform.ErrGone
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if ops := strings.Join(e.pf.ops(), ","); ops != "claim,events,clone-done" {
		t.Errorf("ops = %s", ops)
	}
	if e.m.keteStarted {
		t.Error("kete started")
	}
}

// GitHub: a failing clone-done is best effort (no events note); the revoke stays as it was.
func TestGitHubCloneDoneBestEffort(t *testing.T) {
	e := newEnv(time.Hour)
	e.pf.cloneDoneErr = errors.New("platform: clone-done: unexpected status 500")
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	for _, ev := range e.pf.find("events") {
		if strings.Contains(ev.body, "revoke failed") {
			t.Errorf("events note for a GitHub clone-done: %s", ev.body)
		}
	}
	if len(e.pf.find("revoke")) != 1 || !e.m.keteStarted {
		t.Errorf("ops = %v", e.pf.ops())
	}
}
