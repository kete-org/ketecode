// Package fakeplatform is a minimal in-process stand-in for kete-code-platform, GitHub and Harness
// Code, for the entrypoint's integration suite (and the image's end-to-end test): the container
// callbacks with jobs.md §2's exact shapes and state rules (clone-done included), a git
// smart-HTTP server (git http-backend) behind a clone-token check on a GHES-style host (with the
// token revoke) and on a Harness-style host (basic auth with the claim's username, no API),
// single-use signed uploads, its own test CA and a DNS server for `*.kete.test`. For the image's end-to-end test
// with the real `kete` (cmd/kete-job-fake-platform) it also serves the platform's sync, skill-file,
// models and `me` routes and a scripted fake gateway (sync.go, gateway.go), forwards DNS outside
// `*.kete.test` to a real resolver (dns.go) and writes its records to a state directory
// (state.go). It never imports
// internal/platform: its request structs are its own, decoded strictly, so the client and the fake
// can't drift together (contracts.md §6d).
//
// It is test support, not a _test file, so the image's e2e `main` can reuse it.
package fakeplatform

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/cgi"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Names served (all resolve to Config.Addr).
const (
	PlatformHost = "platform.kete.test"
	GatewayHost  = "gateway.kete.test"
	StorageHost  = "storage.kete.test"
	GitHost      = "github.kete.test"

	// HarnessGitHost is the Harness Code git host of a harness_code job (Knobs.Provider): basic
	// auth with the claim's username, no /api/v3, the repository at HarnessRepoPath.
	HarnessGitHost = "git.harness.kete.test"
)

// The Harness Code job's clone (the shared test vector's shape:
// testdata/jobs-v1/claim-harness-code.json).
const (
	ProviderHarnessCode = "harness_code"
	HarnessRepoPath     = "/acct_Example1/default/shop/web.git"
	HarnessUsername     = "kete_code_clone"

	// FeatureCloneRevokeCallback is the claim feature a Harness Code claim requires.
	FeatureCloneRevokeCallback = "clone_revoke_callback"
	FeatureOrchestration       = "orchestration_v1"
)

// Config says where the fake listens.
type Config struct {
	Addr           string // IPv4 for HTTPS on :443 and the DNS answers
	DNSAddr        string // ip:port for DNS (UDP and TCP)
	StateDir       string
	GitHTTPBackend string // e.g. /usr/lib/git-core/git-http-backend
	// Forward is a resolver (ip:port) for names outside *.kete.test; empty answers them NXDOMAIN.
	Forward string
	// ListenAddr is where HTTPS listens (ip, port 443); empty: Addr. The Kubernetes runner's kind
	// e2e answers DNS with a Service's address and listens on the pod's own.
	ListenAddr string
	// CADir, when set, keeps the fake's CA there across restarts (LoadOrCreateCA).
	CADir string
	// JobHosts, when set, receives every request to PlatformHost under /api/v1/job-hosts/ (the
	// job-host fake, kete-job-host's internal/fakeplatform): one platform origin serves both the
	// runner's job-host-v2 routes and the job's callbacks, as the real platform does.
	JobHosts http.Handler
}

// Knobs vary one job's behaviour.
type Knobs struct {
	Prompt          string        // the spec's prompt: the fake kete's scenario
	PolicyTimeout   int           // default 30
	Deadline        time.Duration // from NewJob; default 1h
	BaseSHAOverride string        // claim reports this base_sha (a wrong commit)
	HangResult      bool
	HangUploads     bool
	EventsGoneAfter int // after this many accepted events, every events call answers 404
	OmitBranch      bool

	// The real kete (the image's e2e): the gateway's script and the sync knobs.
	Scenario     string // the scripted model: ScenarioLifecycle (default) or ScenarioAC5
	OmitAgent    bool   // the spec names no agent
	UnknownAgent bool   // the spec names an agent the sync doesn't list
	SyncStatus   int    // non-zero: GET /api/v1/sync answers this status with an error body

	// Harness Code (jobs-v1 additive, 2026-10-05).
	Provider          string // "" (GitHub: the claim names no provider) or ProviderHarnessCode
	CloneDoneFailures int    // the first n clone-done calls answer 500

	// Runtime repositories (jobs-v1 additive, 2026-10-07; the kubevm profile): RuntimeRepo is the
	// repository's runtime name. The claim must announce runtime_repo and runtime_publish and gets
	// no clone; uploads are a contract error; finish must be {"outbox":true}. ClaimRepo, when set,
	// is the name the claim answers instead (a compromised platform naming another repository).
	RuntimeRepo string
	ClaimRepo   string

	// Orchestrated jobs (orchestration.go): Orchestration is the job's role (Orchestration*);
	// OrchestrationBaseMoved clones MovedRef with the base pinned behind it (a coordinator's base
	// branch moved on); OrchestrationBadDigest gives a worker a prompt_digest the plan doesn't
	// match; OrchestrationMovedFetch pins the node fetch at a commit its branch isn't at.
	Orchestration           string
	OrchestrationBaseMoved  bool
	OrchestrationBadDigest  bool
	OrchestrationMovedFetch bool
	// OrchestrationProposalText, when set, is a plan file whose proposal the coordinator turn is
	// taken to have made (the integration suite's fake kete can't call the routes): its digest is
	// what finish checks the plan bundle against.
	OrchestrationProposalText string

	// Review makes a pull request review job (review.go): spec.review, the clone pinned at the pull
	// request's head, served only to a claim announcing review_v1.
	Review bool
}

// Call is one recorded request.
type Call struct {
	Time   time.Time
	Kind   string // claim, events, result, uploads, finish, clone-done, revoke, git, harness-api, put:<kind>; sync, skill_files, models, me, gateway:models, messages
	Body   []byte
	Status int
}

// Job is the one job the fake serves.
type Job struct {
	ID, ClaimToken, CallbackToken, CloneToken, GatewayKey string
	Branch                                                string
	BaseSHA                                               string
	Deadline                                              time.Time
	Knobs                                                 Knobs
	OrgID, AgentID, SkillID                               string // the synced organization, agent and skill
	CloneUsername                                         string // the claim's clone.username (Harness Code)
	Features                                              []string
	CloneDeleted                                          bool // clone-done deleted a Harness Code token

	done chan struct{} // closed by the accepted finish

	state      string // provisioning, running, finalizing, done
	claims     int
	events     int
	cloneDones int
	agentSeen  bool
	uploadsSet bool
	finished   bool
	uploads    map[string]*upload // by id
	uploaded   map[string][]byte  // by kind
	spec       map[string]any

	// Orchestrated jobs: the claim's clone ref and fetch, the coordinator's proposal and decision,
	// and the plan file its bundle published.
	cloneRef     string
	fetch        []any
	orchProposal map[string]any
	orchDecision string
	PlanBundle   []byte

	// Review is a review job's result's review, once it passed the platform's check.
	Review json.RawMessage
}

type upload struct {
	kind, token string
	max         int64
	used        bool
}

// Server is the fake.
type Server struct {
	cfg     Config
	CA      *CA
	CAPEM   []byte
	BaseSHA string // the repository's real main
	repoDir string
	orch    orchestrationRepo // the orchestration branches (orchestration.go)
	// reviewHead is the pull request's head commit (review.go).
	reviewHead string

	mu        sync.Mutex
	job       *Job
	calls     []Call
	contract  []string
	leaks     []string
	dnsSeen   []string
	checks    map[string]bool // scripted-model checks (tool user, AC5 markers)
	closers   []io.Closer
	gitServer http.Handler
}

func random(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// uuid is a random version 4 UUID.
func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// Start starts DNS and HTTPS and creates the repository.
func Start(cfg Config) (*Server, error) {
	s := &Server{cfg: cfg}
	ca, err := NewCA("Kete e2e test CA")
	if cfg.CADir != "" {
		ca, err = LoadOrCreateCA(cfg.CADir, "Kete e2e test CA")
	}
	if err != nil {
		return nil, err
	}
	s.CA, s.CAPEM = ca, ca.CertPEM()
	if err := s.makeRepo(); err != nil {
		return nil, err
	}
	s.gitServer = &cgi.Handler{
		Path: cfg.GitHTTPBackend,
		Env:  []string{"GIT_PROJECT_ROOT=" + s.repoDir, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "HOME=" + cfg.StateDir},
	}
	listen := cfg.ListenAddr
	if listen == "" {
		listen = cfg.Addr
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(listen, "443"))
	if err != nil {
		return nil, err
	}
	srv := &http.Server{
		Handler:   http.HandlerFunc(s.serve),
		TLSConfig: &tls.Config{GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) { return ca.Leaf(h.ServerName) }},
		ErrorLog:  log.New(io.Discard, "", 0),
	}
	go func() { _ = srv.ServeTLS(ln, "", "") }()
	s.closers = append(s.closers, srv)
	if err := s.startDNS(); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}

// Close stops everything.
func (s *Server) Close() {
	for _, c := range s.closers {
		_ = c.Close()
	}
}

// gitOut runs git in dir (gitCmd's environment) and returns its trimmed stdout.
func gitOut(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + dir, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out)), nil
}

func gitCmd(dir string, env []string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append([]string{"PATH=/usr/bin:/bin", "HOME=" + dir, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=fake", "GIT_AUTHOR_EMAIL=fake@kete.test", "GIT_COMMITTER_NAME=fake", "GIT_COMMITTER_EMAIL=fake@kete.test"}, env...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("git %v: %v: %s", args, err, out)
	}
	return nil
}

// RepoFiles are the base commit's files (path → content, mode); `link` is a symlink to README.md.
var RepoFiles = map[string]struct {
	Content string
	Mode    os.FileMode
}{
	"README.md":   {"# fake repository\n", 0o644},
	"src/app.txt": {"app\n", 0o644},
	"run.sh":      {"#!/bin/sh\necho run\n", 0o755},
	".gitignore":  {"*.log\n", 0o644},
}

func (s *Server) makeRepo() error {
	work := filepath.Join(s.cfg.StateDir, "src")
	s.repoDir = filepath.Join(s.cfg.StateDir, "git")
	_ = os.RemoveAll(work)
	_ = os.RemoveAll(s.repoDir)
	if err := os.MkdirAll(work, 0o755); err != nil {
		return err
	}
	if err := gitCmd(work, nil, "init", "-q", "-b", "main"); err != nil {
		return err
	}
	for p, f := range RepoFiles {
		full := filepath.Join(work, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(full, []byte(f.Content), f.Mode); err != nil {
			return err
		}
		if err := os.Chmod(full, f.Mode); err != nil {
			return err
		}
	}
	if err := os.Symlink("README.md", filepath.Join(work, "link")); err != nil {
		return err
	}
	if err := gitCmd(work, nil, "add", "-A"); err != nil {
		return err
	}
	if err := gitCmd(work, nil, "commit", "-q", "-m", "base"); err != nil {
		return err
	}
	orch, err := makeOrchestrationBranches(work)
	if err != nil {
		return err
	}
	s.orch = orch
	if s.reviewHead, err = makeReviewRef(work); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(s.repoDir, "org"), 0o755); err != nil {
		return err
	}
	if err := gitCmd(s.cfg.StateDir, nil, "clone", "-q", "--bare", work, filepath.Join(s.repoDir, "org", "repo.git")); err != nil {
		return err
	}
	// The pull request's head ref, as GitHub serves refs/pull/<n>/head (a bare clone copies branches only).
	if err := gitCmd(s.cfg.StateDir, nil, "--git-dir="+filepath.Join(s.repoDir, "org", "repo.git"), "fetch", "-q", work, "+"+ReviewHeadRef+":"+ReviewHeadRef); err != nil {
		return err
	}
	// As GitHub: a reachable commit may be fetched by its id (a pinned base the branch moved past).
	if err := gitCmd(s.cfg.StateDir, nil, "--git-dir="+filepath.Join(s.repoDir, "org", "repo.git"), "config", "uploadpack.allowReachableSHA1InWant", "true"); err != nil {
		return err
	}
	head, err := os.ReadFile(filepath.Join(s.repoDir, "org", "repo.git", "refs", "heads", "main"))
	if err != nil {
		// packed refs
		cmd := exec.Command("git", "--git-dir="+filepath.Join(s.repoDir, "org", "repo.git"), "rev-parse", "main")
		cmd.Env = []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "HOME=" + s.cfg.StateDir}
		out, err := cmd.Output()
		if err != nil {
			return err
		}
		head = out
	}
	s.BaseSHA = strings.TrimSpace(string(head))
	return nil
}

// NewJob replaces the current job with a fresh one.
func (s *Server) NewJob(k Knobs) *Job {
	if k.PolicyTimeout == 0 {
		k.PolicyTimeout = 30
	}
	if k.Deadline == 0 {
		k.Deadline = time.Hour
	}
	id := uuid()
	j := &Job{
		OrgID: uuid(), AgentID: uuid(), SkillID: uuid(), done: make(chan struct{}),
		// The claim token has the platform's shape (64 hex; job-host-v1 JobMachineConfig checks it).
		ID: id, ClaimToken: random(32), CallbackToken: "callback-" + random(20),
		CloneToken: "ghs_" + random(18), GatewayKey: "kete_job_" + random(20),
		Branch: "kete/job/" + id[:8], BaseSHA: s.BaseSHA, Deadline: time.Now().Add(k.Deadline), Knobs: k,
		state: "provisioning", uploads: map[string]*upload{}, uploaded: map[string][]byte{},
	}
	if k.BaseSHAOverride != "" {
		j.BaseSHA = k.BaseSHAOverride
	}
	if k.Provider == ProviderHarnessCode {
		j.CloneToken = "sat.acct_Example1.kete_job_" + random(6) + "." + random(16)
		j.CloneUsername = HarnessUsername
	}
	j.spec = map[string]any{"version": 1, "prompt": k.Prompt, "policy": map[string]any{"version": 1, "budget": 5, "timeout": k.PolicyTimeout}}
	if !k.OmitBranch {
		j.spec["branch"] = j.Branch
	}
	j.spec["model"] = "kete/" + Model
	if k.RuntimeRepo != "" {
		// JobRuntimeClaimResponse: the strict JobSpec (allow present) and a 64-hex callback token.
		j.spec["policy"].(map[string]any)["allow"] = []any{}
		j.CallbackToken = random(32)
	}
	switch {
	case k.UnknownAgent:
		j.spec["agent"] = "e2e-unknown"
	case !k.OmitAgent:
		j.spec["agent"] = AgentSlug
	}
	j.cloneRef = "main"
	if k.Orchestration != "" {
		s.orchestrationSpec(j)
	}
	if k.Review {
		s.reviewSpec(j)
	}
	s.mu.Lock()
	s.job, s.calls, s.contract, s.leaks, s.checks = j, nil, nil, nil, map[string]bool{}
	s.mu.Unlock()
	return j
}

// Calls returns the recorded requests.
func (s *Server) Calls() []Call {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Call(nil), s.calls...)
}

// Kinds is the call kinds in order.
func (s *Server) Kinds() []string {
	var out []string
	for _, c := range s.Calls() {
		out = append(out, c.Kind)
	}
	return out
}

// Uploaded returns an upload's bytes by kind (audit, proxy_log, bundle).
func (s *Server) Uploaded(kind string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.job.uploaded[kind]
	return b, ok
}

// ContractErrors lists every request that broke the documented contract.
func (s *Server) ContractErrors() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.contract...)
}

// Leaks lists every request whose URL carried a token.
func (s *Server) Leaks() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.leaks...)
}

func (s *Server) record(kind string, body []byte, status int) {
	s.calls = append(s.calls, Call{Time: time.Now(), Kind: kind, Body: append([]byte(nil), body...), Status: status})
}

func (s *Server) violation(format string, args ...any) {
	s.contract = append(s.contract, fmt.Sprintf(format, args...))
}

func host(r *http.Request) string {
	h := r.Host
	if i := strings.LastIndexByte(h, ':'); i >= 0 && !strings.Contains(h[i:], "]") {
		h = h[:i]
	}
	return h
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	if j != nil {
		for _, tok := range []string{j.ClaimToken, j.CallbackToken, j.CloneToken, j.GatewayKey} {
			if strings.Contains(r.URL.String(), tok) {
				s.leaks = append(s.leaks, r.Method+" "+host(r)+" (a token in the URL)")
			}
		}
		s.headerLeaks(j, r)
	}
	s.mu.Unlock()
	if r.TLS == nil || r.TLS.ServerName != host(r) {
		http.Error(w, "sni", http.StatusMisdirectedRequest)
		return
	}
	switch host(r) {
	case PlatformHost:
		if s.cfg.JobHosts != nil && strings.HasPrefix(r.URL.Path, "/api/v1/job-hosts/") {
			s.cfg.JobHosts.ServeHTTP(w, r)
			return
		}
		s.platform(w, r)
	case GitHost:
		s.git(w, r)
	case HarnessGitHost:
		s.harnessGit(w, r)
	case StorageHost:
		s.storage(w, r)
	case GatewayHost:
		s.gateway(w, r)
	default:
		http.NotFound(w, r)
	}
}

func strict(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

func (s *Server) platform(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && !strings.HasPrefix(r.URL.Path, "/api/v1/jobs/") {
		s.platformGet(w, r)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	s.mu.Lock()
	j := s.job
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/jobs/"), "/")
	if j != nil && (len(parts) == 2 || len(parts) == 3) && parts[0] == j.ID && parts[1] == "orchestration" {
		op, sub := "orchestration", ""
		if len(parts) == 3 {
			sub = parts[2]
			op += ":" + sub
		}
		s.orchestrationRoute(r, j, sub, body, func(status int, v any) {
			s.record(op, body, status)
			s.mu.Unlock()
			if v != nil {
				writeJSON(w, status, v)
				return
			}
			w.WriteHeader(status)
		})
		return
	}
	if j == nil || len(parts) != 2 || parts[0] != j.ID || r.Method != http.MethodPost {
		s.record("unknown", nil, 404)
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	op := parts[1]
	reply := func(status int, v any) {
		s.record(op, body, status)
		s.mu.Unlock()
		if v != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(v)
			return
		}
		w.WriteHeader(status)
	}
	if time.Now().After(j.Deadline) {
		reply(404, nil)
		return
	}
	if op == "claim" {
		var req struct {
			ClaimToken string   `json:"claim_token"`
			Features   []string `json:"features"`
		}
		if err := strict(body, &req); err != nil {
			s.violation("claim: %v", err)
			reply(400, nil)
			return
		}
		if !validFeatures(req.Features) {
			s.violation("claim: features")
			reply(400, nil)
			return
		}
		if req.ClaimToken != j.ClaimToken {
			reply(404, nil)
			return
		}
		j.Features = req.Features
		if j.Knobs.RuntimeRepo != "" {
			s.runtimeClaim(j, req.Features, reply)
			return
		}
		hasRevoke, hasOrchestration, hasReview := false, false, false
		for _, f := range req.Features {
			hasRevoke = hasRevoke || f == FeatureCloneRevokeCallback
			hasOrchestration = hasOrchestration || f == FeatureOrchestration
			hasReview = hasReview || f == FeatureReview
		}
		if j.Knobs.Review && !hasReview {
			// A review job's claim without the feature: refused before anything is minted.
			reply(404, nil)
			return
		}
		if j.Knobs.Orchestration != "" && !hasOrchestration {
			// An orchestrated job's claim without the feature: refused before anything is minted.
			reply(404, nil)
			return
		}
		if !hasRevoke {
			// This entrypoint always announces it; the platform refuses a Harness Code claim
			// without it (entrypoint_outdated), before any credential is minted.
			s.violation("claim: no %s feature", FeatureCloneRevokeCallback)
			if j.Knobs.Provider == ProviderHarnessCode {
				reply(404, nil)
				return
			}
		}
		j.claims++
		if j.claims > 1 {
			s.violation("claim replayed")
			reply(409, nil)
			return
		}
		j.state = "running"
		clone := map[string]string{"url": "https://" + GitHost + "/org/repo.git", "token": j.CloneToken, "ref": j.cloneRef, "base_sha": j.BaseSHA}
		if j.Knobs.Provider == ProviderHarnessCode {
			clone["url"] = "https://" + HarnessGitHost + HarnessRepoPath
			clone["provider"] = ProviderHarnessCode
			clone["username"] = j.CloneUsername
		}
		resp := map[string]any{
			"spec": j.spec, "gateway_key": j.GatewayKey, "callback_token": j.CallbackToken,
			"clone":       clone,
			"gateway_url": "https://" + GatewayHost, "platform_url": "https://" + PlatformHost,
			"deadline": j.Deadline.UTC().Format(time.RFC3339Nano),
		}
		if j.Knobs.Orchestration != "" {
			resp["fetch"] = j.fetch
		}
		reply(200, resp)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+j.CallbackToken {
		reply(404, nil)
		return
	}
	switch op {
	case "clone-done":
		// jobs-v1 additive: `running`; `{}` or an empty body; 204 (later calls are no-ops; a
		// GitHub job's is one too).
		if j.state != "running" {
			s.violation("clone-done: state %s", j.state)
			reply(404, nil)
			return
		}
		if len(body) > 0 {
			if err := strict(body, &struct{}{}); err != nil {
				s.violation("clone-done: %v", err)
				reply(400, nil)
				return
			}
		}
		j.cloneDones++
		if j.cloneDones <= j.Knobs.CloneDoneFailures {
			reply(500, nil)
			return
		}
		if j.Knobs.Provider == ProviderHarnessCode {
			j.CloneDeleted = true
		}
		reply(204, nil)
	case "events":
		if j.state != "running" && j.state != "finalizing" {
			reply(404, nil)
			return
		}
		var ev struct {
			Phase           string  `json:"phase"`
			Message         *string `json:"message"`
			EffectiveTimout *int    `json:"effective_timeout_minutes"`
			KeteCgroupExtra *int    `json:"kete_cgroup_extra"`
		}
		if err := strict(body, &ev); err != nil {
			s.violation("events: %v", err)
			reply(400, nil)
			return
		}
		switch ev.Phase {
		case "clone", "agent", "report", "done":
		default:
			s.violation("events: phase %q", ev.Phase)
			reply(400, nil)
			return
		}
		if ev.Message != nil && len(*ev.Message) > 500 {
			s.violation("events: message longer than 500")
			reply(400, nil)
			return
		}
		if ev.EffectiveTimout != nil {
			if ev.Phase != "agent" || j.agentSeen || *ev.EffectiveTimout < 1 || *ev.EffectiveTimout > j.Knobs.PolicyTimeout {
				s.violation("events: effective_timeout_minutes not on the first agent event or out of range")
				reply(400, nil)
				return
			}
		}
		if ev.Phase == "agent" {
			if !j.agentSeen && ev.EffectiveTimout == nil {
				s.violation("events: first agent event without effective_timeout_minutes")
			}
			j.agentSeen = true
		}
		if j.Knobs.EventsGoneAfter > 0 && j.events >= j.Knobs.EventsGoneAfter {
			reply(404, nil)
			return
		}
		j.events++
		reply(204, nil)
	case "result":
		if j.state != "running" {
			s.violation("result: state %s", j.state)
			reply(404, nil)
			return
		}
		var res struct {
			Version  *int     `json:"version"`
			Outcome  *string  `json:"outcome"`
			ExitCode *float64 `json:"exit_code"`
		}
		if err := json.Unmarshal(body, &res); err != nil || res.Version == nil || *res.Version != 1 || res.Outcome == nil || res.ExitCode == nil {
			s.violation("result: not a v1 result")
			reply(400, nil)
			return
		}
		if j.Knobs.HangResult {
			s.record("result-hang", body, 0)
			s.mu.Unlock()
			<-r.Context().Done()
			return
		}
		if j.Knobs.Review {
			s.checkReviewResult(j, body)
		}
		j.state = "finalizing"
		reply(204, nil)
	case "uploads":
		if j.Knobs.RuntimeRepo != "" {
			s.violation("uploads: a runtime repository's job never uploads")
			reply(404, nil)
			return
		}
		if j.state != "finalizing" || j.uploadsSet {
			s.violation("uploads: state %s or repeated", j.state)
			reply(404, nil)
			return
		}
		var req struct {
			Bundle *bool `json:"bundle"`
		}
		if err := strict(body, &req); err != nil || req.Bundle == nil {
			s.violation("uploads: bad body")
			reply(400, nil)
			return
		}
		if j.Knobs.Review && *req.Bundle {
			s.violation("uploads: a review job publishes no bundle")
		}
		if j.Knobs.HangUploads {
			s.record("uploads-hang", body, 0)
			s.mu.Unlock()
			<-r.Context().Done()
			return
		}
		j.uploadsSet = true
		exp := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
		mk := func(kind string, max int64) map[string]string {
			id, tok := random(8), random(16)
			j.uploads[id] = &upload{kind: kind, token: tok, max: max}
			return map[string]string{"url": "https://" + StorageHost + "/upload/" + id + "?token=" + tok, "expires_at": exp}
		}
		out := map[string]any{"audit": mk("audit", 20_000_000), "proxy_log": mk("proxy_log", 10_000_000)}
		if *req.Bundle {
			out["bundle"] = mk("bundle", 10_000_000)
		}
		reply(200, out)
	case "finish":
		if j.state != "finalizing" || j.finished {
			s.violation("finish: state %s or repeated", j.state)
			reply(404, nil)
			return
		}
		if j.Knobs.RuntimeRepo != "" {
			if string(body) != `{"outbox":true}` {
				s.violation("finish: a runtime finish is exactly {\"outbox\":true}")
				reply(400, nil)
				return
			}
			j.finished = true
			j.state = "done"
			close(j.done)
			reply(202, nil)
			return
		}
		var req struct {
			PushError *string `json:"push_error"`
		}
		if err := strict(body, &req); err != nil {
			s.violation("finish: %v", err)
			reply(400, nil)
			return
		}
		if j.Knobs.Review && req.PushError != nil {
			s.violation("finish: a review job pushes nothing (push_error %q)", *req.PushError)
		}
		if req.PushError != nil {
			switch *req.PushError {
			case "processes_alive", "symlink", "unreadable", "proxy_failed":
			default:
				s.violation("finish: push_error %q", *req.PushError)
				reply(400, nil)
				return
			}
		}
		s.checkOrchestrationBundle(j)
		j.finished = true
		j.state = "done"
		close(j.done)
		reply(202, nil)
	default:
		reply(404, nil)
	}
}

// runtimeClaim answers a runtime repository's claim (s.mu held, released by reply): both runtime
// features required (else 404, as the platform refuses an outdated entrypoint), no clone, the
// repository's runtime name (or Knobs.ClaimRepo).
func (s *Server) runtimeClaim(j *Job, features []string, reply func(int, any)) {
	has := map[string]bool{}
	for _, f := range features {
		has[f] = true
	}
	if !has["runtime_repo"] || !has["runtime_publish"] {
		s.violation("claim: a runtime repository's claim without runtime_repo and runtime_publish")
		reply(404, nil)
		return
	}
	j.claims++
	if j.claims > 1 {
		s.violation("claim replayed")
		reply(409, nil)
		return
	}
	j.state = "running"
	name := j.Knobs.RuntimeRepo
	if j.Knobs.ClaimRepo != "" {
		name = j.Knobs.ClaimRepo
	}
	reply(200, map[string]any{
		"spec": j.spec, "gateway_key": j.GatewayKey, "callback_token": j.CallbackToken,
		"repository":  map[string]string{"provider": "runtime", "name": name},
		"gateway_url": "https://" + GatewayHost, "platform_url": "https://" + PlatformHost,
		"deadline": j.Deadline.UTC().Format(time.RFC3339Nano),
	})
}

func (s *Server) git(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	s.mu.Unlock()
	if j == nil {
		http.NotFound(w, r)
		return
	}
	if j.Knobs.Provider == ProviderHarnessCode {
		s.mu.Lock()
		s.violation("the GitHub host was contacted for a harness_code job")
		s.record("git", nil, 404)
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodDelete && r.URL.Path == "/api/v3/installation/token" {
		s.mu.Lock()
		if r.Header.Get("Authorization") != "token "+j.CloneToken {
			s.record("revoke", nil, 401)
			s.mu.Unlock()
			w.WriteHeader(401)
			return
		}
		s.record("revoke", nil, 204)
		s.mu.Unlock()
		w.WriteHeader(204)
		return
	}
	want := "Basic " + basic("x-access-token", j.CloneToken)
	if r.Header.Get("Authorization") != want || !strings.HasPrefix(r.URL.Path, "/org/repo.git/") {
		s.mu.Lock()
		s.record("git", nil, 401)
		s.mu.Unlock()
		w.Header().Set("WWW-Authenticate", `Basic realm="fake"`)
		w.WriteHeader(401)
		return
	}
	s.mu.Lock()
	s.record("git", []byte(r.Method+" "+r.URL.Path), 200)
	s.mu.Unlock()
	r.Header.Del("Authorization")
	s.gitServer.ServeHTTP(w, r)
}

// harnessGit is the Harness Code git host: git smart HTTP at HarnessRepoPath behind basic auth
// with the claim's username and token (refused once clone-done deleted the token). It has no
// API: any /api/ request is a contract error (the entrypoint must never call the git host's API
// for a harness_code job).
func (s *Server) harnessGit(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	if j == nil || j.Knobs.Provider != ProviderHarnessCode {
		s.record("git", nil, 404)
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.violation("harness_code: the git host's API was called (%s %s)", r.Method, r.URL.Path)
		s.record("harness-api", nil, 404)
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	want := "Basic " + basic(j.CloneUsername, j.CloneToken)
	rest, ok := strings.CutPrefix(r.URL.Path, HarnessRepoPath+"/")
	if j.CloneDeleted || r.Header.Get("Authorization") != want || !ok {
		s.record("git", nil, 401)
		s.mu.Unlock()
		w.Header().Set("WWW-Authenticate", `Basic realm="Harness"`)
		w.WriteHeader(401)
		return
	}
	s.record("git", []byte(r.Method+" "+r.URL.Path), 200)
	s.mu.Unlock()
	r.Header.Del("Authorization")
	r.URL.Path = "/org/repo.git/" + rest
	r.URL.RawPath = ""
	s.gitServer.ServeHTTP(w, r)
}

// validFeatures is the contract's `features`: ≤ 16 names, each `^[a-z0-9_]{1,40}$` (absent is
// valid).
func validFeatures(fs []string) bool {
	if len(fs) > 16 {
		return false
	}
	for _, f := range fs {
		if f == "" || len(f) > 40 {
			return false
		}
		for _, c := range f {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
				return false
			}
		}
	}
	return true
}

func (s *Server) storage(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	id := strings.TrimPrefix(r.URL.Path, "/upload/")
	u := j.uploads[id]
	if r.Method != http.MethodPut || u == nil || u.used || r.URL.Query().Get("token") != u.token {
		s.record("put:?", nil, 403)
		s.mu.Unlock()
		w.WriteHeader(403)
		return
	}
	u.used = true
	s.mu.Unlock()
	data, err := io.ReadAll(io.LimitReader(r.Body, u.max+1))
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil || int64(len(data)) > u.max || r.ContentLength != int64(len(data)) {
		s.record("put:"+u.kind, nil, 413)
		w.WriteHeader(413)
		return
	}
	j.uploaded[u.kind] = data
	s.record("put:"+u.kind, nil, 200)
	w.WriteHeader(200)
}
