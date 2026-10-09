package fakeplatform

// Orchestrated jobs in the fake (jobs-v1 "Orchestrated jobs", orchestrations-v1): the repository gets
// one orchestration's plan branch (revision 1, the plan file only) and one node branch, both on the
// base; a job made with Knobs.Orchestration is a coordinator turn or a node's attempt whose claim
// carries spec.orchestration and fetch (only for a claim announcing orchestration_v1, else 404 as
// the platform answers); the coordinator routes (GET/PUT/POST /api/v1/jobs/{id}/orchestration…)
// answer the turn's job key; and finish checks the coordinator's bundle against the plan rule the
// platform applies (O5): exactly the plan file whose SHA-256 is the proposal's plan_digest.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/orchestration"
)

// The fake's orchestration.
const (
	OrchestrationID = "ab12cd34-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
	// NodeKey is the node whose branch exists (succeeded); WorkerKey the node a worker job runs,
	// based on NodeKey.
	NodeKey   = "sdk-core"
	WorkerKey = "client-web"
	// WorkerPrompt is WorkerKey's prompt in the plan file: a worker's spec gets it from there.
	WorkerPrompt = "orchestration-worker: update the web client on top of sdk-core and run its tests."
	// NodeFile is the file NodeKey's commit adds.
	NodeFile = "sdk-core.txt"
	// MovedRef is a branch one commit past the base: an orchestration whose base branch has moved
	// on since it was pinned (Knobs.OrchestrationBaseMoved).
	MovedRef = "moved"
)

// Orchestration roles of a fake job (Knobs.Orchestration).
const (
	OrchestrationCoordinator = "coordinator" // turn 1: no plan yet, nothing fetched
	OrchestrationIntegration = "integration" // turn 2: the plan and the node fetched
	OrchestrationWorker      = "worker"      // WorkerKey's attempt, based on NodeKey
)

// orchestrationRepo is what makeOrchestrationBranches made.
type orchestrationRepo struct {
	PlanFile []byte
	PlanSHA  string
	NodeSHA  string
	MovedSHA string
}

// planFile is the fake's plan, revision 1: NodeKey, then WorkerKey based on it.
func planFile() []byte {
	type node struct {
		Key            string   `json:"key"`
		Prompt         string   `json:"prompt"`
		DependsOn      []string `json:"depends_on"`
		BaseFrom       *string  `json:"base_from"`
		Agent          string   `json:"agent"`
		BudgetMicros   int      `json:"budget_micros"`
		TimeoutMinutes int      `json:"timeout_minutes"`
		MaxAttempts    int      `json:"max_attempts"`
	}
	base := NodeKey
	plan := struct {
		Version         int    `json:"version"`
		OrchestrationID string `json:"orchestration_id"`
		Rev             int    `json:"rev"`
		Notes           string `json:"notes"`
		Nodes           []node `json:"nodes"`
	}{1, OrchestrationID, 1, "sdk-core first, then the web client on top of it", []node{
		{NodeKey, "orchestration-node: port the core client.", []string{}, nil, AgentSlug, 1_000_000, 30, 3},
		{WorkerKey, WorkerPrompt, []string{NodeKey}, &base, AgentSlug, 1_000_000, 30, 3},
	}}
	b, _ := json.MarshalIndent(plan, "", "  ")
	return append(b, '\n')
}

// makeOrchestrationBranches adds, in the work tree after the base commit, the plan branch
// (base + the plan file), the node branch (base + NodeFile) and MovedRef (base + one commit), and
// returns to main. The bare clone carries them all.
func makeOrchestrationBranches(work string) (orchestrationRepo, error) {
	var out orchestrationRepo
	commit := func(branch, file string, content []byte, msg string) (string, error) {
		if err := gitCmd(work, nil, "checkout", "-q", "-b", branch, "main"); err != nil {
			return "", err
		}
		full := filepath.Join(work, file)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(full, content, 0o644); err != nil {
			return "", err
		}
		if err := gitCmd(work, nil, "add", "--", file); err != nil {
			return "", err
		}
		if err := gitCmd(work, nil, "commit", "-q", "-m", msg); err != nil {
			return "", err
		}
		sha, err := gitOut(work, "rev-parse", "HEAD")
		if err != nil {
			return "", err
		}
		return sha, gitCmd(work, nil, "checkout", "-q", "main")
	}
	out.PlanFile = planFile()
	var err error
	if out.PlanSHA, err = commit(orchestration.PlanBranch(OrchestrationID, 1), orchestration.PlanPath, out.PlanFile, "plan 1"); err != nil {
		return out, err
	}
	note := "Kete job e1a4c7d2 [skip ci]\n\nPorted the core client.\n\nNode: " + NodeKey
	if out.NodeSHA, err = commit(orchestration.NodeBranch(OrchestrationID, NodeKey), NodeFile, []byte("core\n"), note); err != nil {
		return out, err
	}
	if out.MovedSHA, err = commit(MovedRef, "moved.txt", []byte("moved\n"), "main moved on"); err != nil {
		return out, err
	}
	return out, nil
}

// orchestrationSpec fills a job's spec, clone and fetch for its role (s.mu held by NewJob's caller
// or not yet shared).
func (s *Server) orchestrationSpec(j *Job) {
	o := s.orch
	planRef := map[string]any{"rev": 1, "branch": orchestration.PlanBranch(OrchestrationID, 1), "sha": o.PlanSHA}
	planFetch := map[string]any{"name": "plan", "branch": orchestration.PlanBranch(OrchestrationID, 1), "sha": o.PlanSHA}
	nodeFetch := map[string]any{"name": "nodes/" + NodeKey, "branch": orchestration.NodeBranch(OrchestrationID, NodeKey), "sha": o.NodeSHA}
	j.cloneRef, j.fetch = "main", []any{}
	// The strict orchestrated spec (JobSpec's shape): the compiled policy always lists `allow`.
	j.spec["policy"].(map[string]any)["allow"] = []any{}
	switch j.Knobs.Orchestration {
	case OrchestrationCoordinator:
		j.spec["orchestration"] = map[string]any{"version": 1, "id": OrchestrationID, "role": "coordinator", "turn": 1, "final": false, "plan": nil, "titles": "send"}
		if j.Knobs.OrchestrationBaseMoved {
			j.cloneRef = MovedRef
		}
	case OrchestrationIntegration:
		j.spec["orchestration"] = map[string]any{"version": 1, "id": OrchestrationID, "role": "coordinator", "turn": 2, "final": false, "plan": planRef, "titles": "send"}
		j.fetch = []any{planFetch, nodeFetch}
	case OrchestrationWorker:
		delete(j.spec, "prompt")
		j.Branch = orchestration.NodeBranch(OrchestrationID, WorkerKey)
		j.spec["branch"] = j.Branch
		j.spec["orchestration"] = map[string]any{
			"version": 1, "id": OrchestrationID, "role": "worker", "node": WorkerKey, "attempt": 1, "plan": planRef,
			"prompt_digest": orchestration.SHA256Hex([]byte(WorkerPrompt)), "base_from": NodeKey,
		}
		j.cloneRef, j.BaseSHA = orchestration.NodeBranch(OrchestrationID, NodeKey), o.NodeSHA
		j.fetch = []any{planFetch, nodeFetch}
		if j.Knobs.OrchestrationBadDigest {
			j.spec["orchestration"].(map[string]any)["prompt_digest"] = strings.Repeat("a", 64)
		}
	}
	if t := j.Knobs.OrchestrationProposalText; t != "" {
		j.orchProposal = map[string]any{"version": float64(1), "rev": float64(1), "plan_digest": orchestration.SHA256Hex([]byte(t))}
	}
	if j.Knobs.OrchestrationMovedFetch {
		nodeFetch["sha"] = s.BaseSHA // a node branch someone moved since it was recorded
	}
}

// orchestrationView is GET …/orchestration's body for the job's coordinator turn.
func (s *Server) orchestrationView(j *Job) map[string]any {
	turn, plan := 1, any(nil)
	if j.Knobs.Orchestration == OrchestrationIntegration {
		turn = 2
		plan = map[string]any{"rev": 1, "branch": orchestration.PlanBranch(OrchestrationID, 1), "sha": s.orch.PlanSHA}
	}
	nodes := []any{}
	if turn == 2 {
		nodes = append(nodes, map[string]any{
			"key": NodeKey, "title": nil, "state": "succeeded", "plan_rev": 1, "depends_on": []string{}, "base_from": nil,
			"agent": AgentSlug, "prompt_digest": strings.Repeat("b", 64), "budget_micros": 1_000_000, "spent_micros": 400_000,
			"timeout_minutes": 30, "attempts": 1, "max_attempts": 3, "branch": orchestration.NodeBranch(OrchestrationID, NodeKey),
			"commit_sha": s.orch.NodeSHA, "outcome": "completed", "summary": nil,
		})
	}
	var proposal, decision any
	if j.orchProposal != nil {
		proposal = map[string]any{"rev": j.orchProposal["rev"], "plan_digest": j.orchProposal["plan_digest"]}
	}
	if j.orchDecision != "" {
		decision = j.orchDecision
	}
	return map[string]any{"orchestration": map[string]any{
		"id": OrchestrationID, "status": "coordinating", "turn": turn, "final": false, "plan": plan, "proposal": proposal, "decision": decision,
		"budget_micros": 20_000_000, "reserve_micros": 3_000_000, "allocated_micros": 6_000_000, "spent_micros": 400_000,
		"deadline": j.Deadline.UTC().Format(time.RFC3339), "max_parallel": 4, "worker_agents": []string{AgentSlug},
		"limits": map[string]any{"nodes_per_plan": 8, "nodes_total": 16, "turns": 6, "attempts_per_node": 3, "jobs_total": 32, "max_parallel": 4},
		"titles": "send", "nodes": nodes,
	}}
}

// orchestrationRoute serves the coordinator routes (s.mu held; reply releases it).
func (s *Server) orchestrationRoute(r *http.Request, j *Job, sub string, body []byte, reply func(int, any)) {
	if r.Header.Get("Authorization") != "Bearer "+j.GatewayKey {
		reply(404, nil)
		return
	}
	role := j.Knobs.Orchestration
	if role != OrchestrationCoordinator && role != OrchestrationIntegration {
		reply(403, map[string]any{"error": map[string]any{"code": "forbidden", "message": "not a coordinator turn", "request_id": "fake", "reason": "not_coordinator"}})
		return
	}
	if j.state != "running" {
		reply(409, map[string]any{"error": map[string]any{"code": "conflict", "message": "the job is not running", "request_id": "fake", "reason": "job_not_running"}})
		return
	}
	switch {
	case sub == "" && r.Method == http.MethodGet:
	case sub == "plan" && r.Method == http.MethodPut:
		var p map[string]any
		if err := json.Unmarshal(body, &p); err != nil || p["version"] != float64(1) {
			s.violation("orchestration plan: not a proposal")
			reply(400, nil)
			return
		}
		committed := 0.0
		if role == OrchestrationIntegration {
			committed = 1
		}
		if p["rev"] != committed+1 {
			reply(409, map[string]any{"error": map[string]any{"code": "conflict", "message": "rev", "request_id": "fake", "reason": "rev_mismatch"}})
			return
		}
		if d, _ := p["plan_digest"].(string); !orchestration.ValidDigest(d) {
			s.violation("orchestration plan: plan_digest")
			reply(400, nil)
			return
		}
		if strings.Contains(string(body), `"prompt"`) || strings.Contains(string(body), `"notes"`) {
			s.violation("orchestration plan: a prompt or the notes left the zone")
		}
		if j.orchDecision != "" {
			reply(409, map[string]any{"error": map[string]any{"code": "conflict", "message": "decided", "request_id": "fake", "reason": "decision_recorded"}})
			return
		}
		j.orchProposal = p
	case sub == "decision" && r.Method == http.MethodPost:
		var d struct {
			Decision string  `json:"decision"`
			Summary  *string `json:"summary"`
		}
		if err := strict(body, &d); err != nil || d.Decision != "integrated" && d.Decision != "abandon" {
			s.violation("orchestration decision: bad body")
			reply(400, nil)
			return
		}
		if j.orchDecision != "" {
			reply(409, map[string]any{"error": map[string]any{"code": "conflict", "message": "decided", "request_id": "fake", "reason": "decision_recorded"}})
			return
		}
		j.orchDecision, j.orchProposal = d.Decision, nil
	default:
		reply(404, nil)
		return
	}
	reply(200, s.orchestrationView(j))
}

// checkOrchestrationBundle applies the platform's plan rule to a finished orchestrated job's bundle
// (s.mu held): a coordinator turn that proposed a plan publishes exactly the plan file, whose
// SHA-256 is the proposal's plan_digest; every other bundle has no .kete-orchestration path.
func (s *Server) checkOrchestrationBundle(j *Job) {
	if j.Knobs.Orchestration == "" {
		return
	}
	gz, ok := j.uploaded["bundle"]
	if !ok {
		return
	}
	manifest, files, err := readBundle(gz)
	if err != nil {
		s.violation("orchestration bundle: %v", err)
		return
	}
	var entries []orchestration.BundleEntry
	for _, m := range manifest {
		entries = append(entries, orchestration.BundleEntry{Path: m.Path, Deleted: m.Deleted, Mode: m.Mode, Size: int64(len(files[m.Path]))})
	}
	if j.orchProposal != nil {
		if r := orchestration.CheckBundle(entries, orchestration.BundlePlan); r != "" {
			s.violation("orchestration bundle: %s", r)
			return
		}
		if orchestration.SHA256Hex(files[orchestration.PlanPath]) != j.orchProposal["plan_digest"] {
			s.violation("orchestration bundle: the plan file is not the proposal's")
		}
		j.PlanBundle = files[orchestration.PlanPath]
		return
	}
	if r := orchestration.CheckBundle(entries, orchestration.BundleOther); r != "" {
		s.violation("orchestration bundle: %s", r)
	}
}

type bundleEntry struct {
	Path    string `json:"path"`
	Mode    string `json:"mode"`
	Deleted bool   `json:"deleted"`
}

func readBundle(gz []byte) ([]bundleEntry, map[string][]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil, nil, err
	}
	tr := tar.NewReader(zr)
	files := map[string][]byte{}
	var manifest []bundleEntry
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}
		b, err := io.ReadAll(io.LimitReader(tr, 20<<20))
		if err != nil {
			return nil, nil, err
		}
		if h.Name == "manifest.json" {
			if err := json.Unmarshal(b, &manifest); err != nil {
				return nil, nil, err
			}
			continue
		}
		files[strings.TrimPrefix(h.Name, "files/")] = b
	}
	return manifest, files, nil
}
