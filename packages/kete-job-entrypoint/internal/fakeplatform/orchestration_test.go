package fakeplatform

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/orchestration"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
)

// orchestrationServer is a fake with its repository (real git) and a running orchestrated job.
func orchestrationServer(t *testing.T, k Knobs) (*Server, *Job) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	s := &Server{cfg: Config{StateDir: t.TempDir()}}
	if err := s.makeRepo(); err != nil {
		t.Fatal(err)
	}
	k.Prompt = "coordinate"
	j := s.NewJob(k)
	return s, j
}

func claimOf(t *testing.T, s *Server, j *Job, features string) (int, []byte) {
	t.Helper()
	rec := do(s, "POST", "https://"+PlatformHost+"/api/v1/jobs/"+j.ID+"/claim", []byte(`{"claim_token":"`+j.ClaimToken+`","features":[`+features+`]}`), nil)
	return rec.Code, rec.Body.Bytes()
}

func TestOrchestratedClaims(t *testing.T) {
	for _, role := range []string{OrchestrationCoordinator, OrchestrationIntegration, OrchestrationWorker} {
		t.Run(role, func(t *testing.T) {
			s, j := orchestrationServer(t, Knobs{Orchestration: role})
			if st, _ := claimOf(t, s, j, `"clone_revoke_callback"`); st != 404 {
				t.Fatalf("a claim without orchestration_v1 = %d", st)
			}
			st, body := claimOf(t, s, j, `"clone_revoke_callback","orchestration_v1"`)
			if st != 200 {
				t.Fatalf("claim %d", st)
			}
			resp, err := platform.ParseClaim(body)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := platform.ParseOrchestrated(resp.Spec, resp.Fetch, &platform.CloneRef{Ref: resp.Clone.Ref, BaseSHA: resp.Clone.BaseSHA}); err != nil {
				t.Fatalf("the fake's claim fails the contract: %v", err)
			}
			if len(s.ContractErrors()) != 0 {
				t.Errorf("contract errors %v", s.ContractErrors())
			}
		})
	}
}

func TestOrchestrationRepository(t *testing.T) {
	s, _ := orchestrationServer(t, Knobs{})
	prompt, reason := orchestration.ReadNodePrompt(s.orch.PlanFile, orchestration.PromptExpectation{
		OrchestrationID: OrchestrationID, Rev: 1, Key: WorkerKey, PromptDigest: orchestration.SHA256Hex([]byte(WorkerPrompt)),
	})
	if reason != "" || prompt != WorkerPrompt {
		t.Fatalf("the fake's plan file: %q %s", prompt, reason)
	}
	for _, sha := range []string{s.orch.PlanSHA, s.orch.NodeSHA, s.orch.MovedSHA} {
		if len(sha) != 40 || sha == s.BaseSHA {
			t.Errorf("branch commit %q", sha)
		}
	}
}

func TestCoordinatorRoutes(t *testing.T) {
	s, j := orchestrationServer(t, Knobs{Orchestration: OrchestrationCoordinator})
	claimOf(t, s, j, `"clone_revoke_callback","orchestration_v1"`)
	url := "https://" + PlatformHost + "/api/v1/jobs/" + j.ID + "/orchestration"
	key := map[string]string{"Authorization": "Bearer " + j.GatewayKey}
	if rec := do(s, "GET", url, nil, map[string]string{"Authorization": "Bearer " + j.CallbackToken}); rec.Code != 404 {
		t.Fatalf("callback token: %d", rec.Code)
	}
	rec := do(s, "GET", url, nil, key)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"turn":1`) {
		t.Fatalf("view %d %s", rec.Code, rec.Body)
	}
	proposal, _ := orchestration.PlanProposal(s.orch.PlanFile, orchestration.TitlesSend)
	body, _ := json.Marshal(proposal)
	if rec := do(s, "PUT", url+"/plan", body, key); rec.Code != 200 || !strings.Contains(rec.Body.String(), proposal.PlanDigest) {
		t.Fatalf("plan %d %s", rec.Code, rec.Body)
	}
	// The coordinator's bundle is then exactly the plan file.
	j.uploaded["bundle"] = bundleOf(t, map[string][]byte{orchestration.PlanPath: s.orch.PlanFile})
	s.checkOrchestrationBundle(j)
	if len(s.ContractErrors()) != 0 || !bytes.Equal(j.PlanBundle, s.orch.PlanFile) {
		t.Fatalf("plan bundle: %v", s.ContractErrors())
	}
	j.uploaded["bundle"] = bundleOf(t, map[string][]byte{orchestration.PlanPath: s.orch.PlanFile, "README.md": []byte("x")})
	s.checkOrchestrationBundle(j)
	if len(s.ContractErrors()) != 1 {
		t.Fatalf("a plan bundle with code: %v", s.ContractErrors())
	}
	if rec := do(s, "POST", url+"/decision", []byte(`{"decision":"integrated","summary":"done"}`), key); rec.Code != 200 {
		t.Fatalf("decision %d", rec.Code)
	}
	if rec := do(s, "PUT", url+"/plan", body, key); rec.Code != 409 {
		t.Fatalf("a plan after the decision: %d", rec.Code)
	}
	// A worker's key can't coordinate.
	s2, w := orchestrationServer(t, Knobs{Orchestration: OrchestrationWorker})
	claimOf(t, s2, w, `"clone_revoke_callback","orchestration_v1"`)
	if rec := do(s2, "GET", "https://"+PlatformHost+"/api/v1/jobs/"+w.ID+"/orchestration", nil, map[string]string{"Authorization": "Bearer " + w.GatewayKey}); rec.Code != 403 {
		t.Fatalf("worker: %d", rec.Code)
	}
}

func bundleOf(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var manifest []map[string]string
	for p := range files {
		manifest = append(manifest, map[string]string{"path": p, "mode": "100644"})
	}
	mj, _ := json.Marshal(manifest)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	add := func(name string, b []byte) {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
		_, _ = tw.Write(b)
	}
	add("manifest.json", mj)
	for p, b := range files {
		add("files/"+p, b)
	}
	_ = tw.Close()
	_ = zw.Close()
	return buf.Bytes()
}
