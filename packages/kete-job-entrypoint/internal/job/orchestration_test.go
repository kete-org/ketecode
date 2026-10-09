package job

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/orchestration"
)

// orchestratedEnv is newEnv with one of jobs-v1/orchestration.json's claim responses: its spec,
// fetches and clone ref and base (the rest stays this test's machine).
func orchestratedEnv(t *testing.T, response string) *env {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "fakeplatform", "testdata", "jobs-v1", "orchestration.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Responses map[string]struct {
			Spec  json.RawMessage `json:"spec"`
			Fetch json.RawMessage `json:"fetch"`
			Clone struct {
				Ref     string `json:"ref"`
				BaseSHA string `json:"base_sha"`
			} `json:"clone"`
		} `json:"responses"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	r, ok := v.Responses[response]
	if !ok {
		t.Fatalf("no response %q", response)
	}
	e := newEnv(time.Hour)
	e.pf.claim.Spec, e.pf.claim.Fetch = r.Spec, r.Fetch
	e.pf.claim.Clone.Ref, e.pf.claim.Clone.BaseSHA = r.Clone.Ref, r.Clone.BaseSHA
	e.git.refs = map[string]string{"refs/heads/" + r.Clone.Ref: r.Clone.BaseSHA}
	var fetch []struct{ Branch, SHA string }
	_ = json.Unmarshal(r.Fetch, &fetch)
	e.git.fetchAt = map[string]string{}
	for _, f := range fetch {
		e.git.fetchAt[f.Branch] = f.SHA
	}
	return e
}

// workedExamplePlan is the plan-files vector's worked example (revision 1 of orchestration
// ab12cd34-…), the plan the workers of jobs-v1/orchestration.json read their prompts from.
func workedExamplePlan(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "platform", "test-vectors", "orchestrations-v1", "plan-files.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Files []struct {
			Name string `json:"name"`
			Text string `json:"text"`
		} `json:"files"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	for _, f := range v.Files {
		if f.Name == "the worked example, revision 1" {
			return []byte(f.Text)
		}
	}
	t.Fatal("no worked example")
	return nil
}

const planSHA = "1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e"

func specOf(t *testing.T, e *env) map[string]any {
	t.Helper()
	var spec map[string]any
	if err := json.Unmarshal(e.m.spec, &spec); err != nil {
		t.Fatalf("spec %q: %v", e.m.spec, err)
	}
	return spec
}

func TestCoordinatorTurnOne(t *testing.T) {
	e := orchestratedEnv(t, "coordinator_turn_1")
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d; log %s", code, e.out)
	}
	spec := specOf(t, e)
	o, _ := spec["orchestration"].(map[string]any)
	if o["role"] != "coordinator" || spec["prompt"] == nil {
		t.Errorf("spec = %s", e.m.spec)
	}
	if e.git.pinned != "" || e.git.fetched != nil || e.git.keteRefs {
		t.Error("turn 1 pinned or fetched something")
	}
	if e.m.bundleKind != bundle.KindCoordinator || e.m.keteEnv.JobID != e.d.Boot.JobID {
		t.Errorf("bundle kind %v, job id %q", e.m.bundleKind, e.m.keteEnv.JobID)
	}
	if got := resultOf(t, e.pf)["outcome"]; got != "completed" {
		t.Errorf("outcome %v", got)
	}
}

func TestCoordinatorBaseMovedIsPinned(t *testing.T) {
	e := orchestratedEnv(t, "coordinator_turn_1")
	base := e.pf.claim.Clone.BaseSHA
	e.git.refs["refs/heads/"+e.pf.claim.Clone.Ref] = strings.Repeat("f", 40) // main moved on
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d; log %s", code, e.out)
	}
	if e.git.pinned != base {
		t.Errorf("pinned %q, want the claim's base", e.git.pinned)
	}
	if !strings.Contains(e.out.String(), `"step":"clone","event":"note","code":"ref_mismatch"`) {
		t.Errorf("no note: %s", e.out)
	}
}

func TestCoordinatorPinFails(t *testing.T) {
	e := orchestratedEnv(t, "coordinator_turn_1")
	e.git.refs["refs/heads/"+e.pf.claim.Clone.Ref] = strings.Repeat("f", 40)
	e.git.pinErr = errors.New("not our ref")
	e.run(t)
	r := resultOf(t, e.pf)
	if r["outcome"] != "refused" || !strings.Contains(r["message"].(string), "ref_mismatch") || e.m.keteStarted {
		t.Errorf("result %v, kete started %v", r, e.m.keteStarted)
	}
}

func TestIntegrationTurnFetches(t *testing.T) {
	e := orchestratedEnv(t, "coordinator_integration_turn")
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d; log %s", code, e.out)
	}
	if len(e.git.fetched) == 0 || e.git.depth1 || !e.git.keteRefs {
		t.Errorf("fetched %v depth1 %v kete refs %v", e.git.fetched, e.git.depth1, e.git.keteRefs)
	}
	for _, f := range e.git.fetched {
		if f.Name != "plan" && !strings.HasPrefix(f.Name, "nodes/") || !strings.HasPrefix(f.Branch, "kete/job/ab12cd34-") {
			t.Errorf("fetch %+v", f)
		}
	}
	if e.git.fetchUser != "x-access-token" {
		t.Error("fetch without the clone credential")
	}
	ops := strings.Join(e.pf.ops(), ",")
	if !strings.HasPrefix(ops, "claim,events,revoke,clone-done,") {
		t.Errorf("fetch after the token was revoked? ops %s", ops)
	}
	if !strings.Contains(e.out.String(), `"step":"fetch","event":"ok"`) {
		t.Errorf("phase log: %s", e.out)
	}
}

func TestFetchedRefMismatchRefused(t *testing.T) {
	e := orchestratedEnv(t, "coordinator_integration_turn")
	for b := range e.git.fetchAt {
		e.git.fetchAt[b] = strings.Repeat("e", 40) // a node branch someone moved
		break
	}
	e.run(t)
	r := resultOf(t, e.pf)
	if r["outcome"] != "refused" || r["message"] != RefMismatch || e.m.keteStarted {
		t.Errorf("result %v", r)
	}
	if !strings.Contains(e.out.String(), `"step":"fetch","event":"failed","code":"ref_mismatch"`) {
		t.Errorf("phase log: %s", e.out)
	}
}

func TestFetchFailsIsAnError(t *testing.T) {
	e := orchestratedEnv(t, "coordinator_integration_turn")
	e.git.fetchErr = errors.New("network")
	e.run(t)
	if r := resultOf(t, e.pf); r["outcome"] != "error" || e.m.keteStarted {
		t.Errorf("result %v", r)
	}
}

func TestWorkerReadsItsPrompt(t *testing.T) {
	e := orchestratedEnv(t, "worker_on_node")
	e.git.blobs = map[string][]byte{planSHA + ":" + orchestration.PlanPath: workedExamplePlan(t)}
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d; log %s", code, e.out)
	}
	spec := specOf(t, e)
	if p, _ := spec["prompt"].(string); !strings.HasPrefix(p, "Update the web client to SDK v3.") {
		t.Errorf("prompt %q", p)
	}
	if !e.git.depth1 || e.m.bundleKind != bundle.KindOther {
		t.Errorf("depth1 %v, bundle kind %v", e.git.depth1, e.m.bundleKind)
	}
	if spec["orchestration"] == nil {
		t.Error("the spec lost its orchestration section")
	}
}

func TestWorkerPromptRefusals(t *testing.T) {
	plan := workedExamplePlan(t)
	cases := map[string]struct {
		blob   []byte
		reason string
	}{
		"another prompt":   {[]byte(strings.Replace(string(plan), "Run the web tests.", "Skip the web tests.", 1)), "prompt_mismatch"},
		"not a plan":       {[]byte("{}"), "invalid"},
		"too large":        {make([]byte, orchestration.PlanFileMaxBytes+1), "too_large"},
		"another revision": {[]byte(strings.Replace(string(plan), `"rev": 1`, `"rev": 2`, 1)), "plan_mismatch"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			e := orchestratedEnv(t, "worker_on_node")
			e.git.blobs = map[string][]byte{planSHA + ":" + orchestration.PlanPath: c.blob}
			e.run(t)
			r := resultOf(t, e.pf)
			if r["outcome"] != "refused" || !strings.Contains(r["message"].(string), "("+c.reason+")") || e.m.keteStarted {
				t.Errorf("result %v", r)
			}
		})
	}
}

func TestWorkerNodeBaseMovedRefused(t *testing.T) {
	e := orchestratedEnv(t, "worker_on_node")
	e.git.refs["refs/heads/"+e.pf.claim.Clone.Ref] = strings.Repeat("f", 40)
	e.run(t)
	r := resultOf(t, e.pf)
	if r["outcome"] != "refused" || r["message"] != RefMismatch || e.git.pinned != "" {
		t.Errorf("result %v, pinned %q", r, e.git.pinned)
	}
}

func TestInvalidOrchestratedClaim(t *testing.T) {
	e := orchestratedEnv(t, "worker_on_node")
	var spec map[string]any
	_ = json.Unmarshal(e.pf.claim.Spec, &spec)
	spec["prompt"] = "a worker's prompt is never on the platform"
	e.pf.claim.Spec, _ = json.Marshal(spec)
	e.run(t)
	r := resultOf(t, e.pf)
	if r["outcome"] != "error" || r["message"] != "invalid claim response: orchestration" || e.git.username != "" {
		t.Errorf("result %v; cloned with %q", r, e.git.username)
	}
}

// TestPlainJobUnchanged: a job without spec.orchestration does none of it.
func TestPlainJobUnchanged(t *testing.T) {
	e := newEnv(time.Hour)
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if e.git.fetched != nil || e.git.keteRefs || e.git.pinned != "" || e.m.bundleKind != bundle.KindOther {
		t.Error("a plain job did orchestration work")
	}
}
