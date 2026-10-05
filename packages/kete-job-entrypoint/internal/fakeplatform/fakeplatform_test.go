package fakeplatform

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestServer is a fake with a job and no listeners; requests go straight to serve.
func newTestServer(t *testing.T, k Knobs) (*Server, *Job) {
	t.Helper()
	s := &Server{BaseSHA: strings.Repeat("a", 40)}
	j := s.NewJob(k)
	s.mu.Lock()
	j.state = "running"
	s.mu.Unlock()
	return s, j
}

func do(s *Server, method, url string, body []byte, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, url, bytes.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.serve(rec, req)
	return rec
}

func TestSyncAuth(t *testing.T) {
	s, j := newTestServer(t, Knobs{})
	if rec := do(s, "GET", "https://"+PlatformHost+"/api/v1/sync", nil, map[string]string{"Authorization": "Bearer wrong"}); rec.Code != 401 {
		t.Fatalf("wrong key: %d", rec.Code)
	}
	// The callback token is not the sync credential, and presenting it is a leak.
	if rec := do(s, "GET", "https://"+PlatformHost+"/api/v1/sync", nil, map[string]string{"Authorization": "Bearer " + j.CallbackToken}); rec.Code != 401 {
		t.Fatalf("callback token: %d", rec.Code)
	}
	if len(s.Leaks()) != 1 {
		t.Fatalf("leaks %v", s.Leaks())
	}
	rec := do(s, "GET", "https://"+PlatformHost+"/api/v1/sync", nil, map[string]string{"Authorization": "Bearer " + j.GatewayKey})
	if rec.Code != 200 {
		t.Fatalf("sync: %d", rec.Code)
	}
	var body struct {
		Organization struct{ ID, Name string }
		Agents       []struct {
			ID, Slug string
			Version  int
		}
		Skills []struct {
			ID    string
			Files []struct {
				SHA256 string `json:"sha256"`
			}
		}
		Policies []any
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Agents) != 1 || body.Agents[0].ID != j.AgentID || body.Agents[0].Slug != AgentSlug || body.Agents[0].Version != 1 {
		t.Fatalf("agents %+v", body.Agents)
	}
	if body.Policies == nil || len(body.Policies) != 0 {
		t.Fatalf("policies must be a loaded empty list: %v", body.Policies)
	}
	if len(body.Skills) != 1 || body.Skills[0].Files[0].SHA256 != sha256Hex(SkillFileContent) {
		t.Fatalf("skills %+v", body.Skills)
	}
	etag := rec.Header().Get("ETag")
	if rec := do(s, "GET", "https://"+PlatformHost+"/api/v1/sync", nil, map[string]string{"Authorization": "Bearer " + j.GatewayKey, "If-None-Match": etag}); rec.Code != 304 {
		t.Fatalf("etag: %d", rec.Code)
	}
	rec = do(s, "GET", "https://"+PlatformHost+"/api/v1/sync/skills/"+j.SkillID+"/files", nil, map[string]string{"Authorization": "Bearer " + j.GatewayKey})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "e2e notes") {
		t.Fatalf("skill files: %d %s", rec.Code, rec.Body)
	}
	// The gateway key on a job callback is a leak.
	do(s, "POST", "https://"+PlatformHost+"/api/v1/jobs/"+j.ID+"/events", []byte(`{"phase":"agent"}`), map[string]string{"Authorization": "Bearer " + j.GatewayKey})
	if len(s.Leaks()) != 2 {
		t.Fatalf("leaks %v", s.Leaks())
	}
}

func TestSyncStatusKnob(t *testing.T) {
	s, j := newTestServer(t, Knobs{SyncStatus: 503})
	if rec := do(s, "GET", "https://"+PlatformHost+"/api/v1/sync", nil, map[string]string{"Authorization": "Bearer " + j.GatewayKey}); rec.Code != 503 {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestSpecAgent(t *testing.T) {
	for _, tc := range []struct {
		k    Knobs
		want any
	}{{Knobs{}, AgentSlug}, {Knobs{OmitAgent: true}, nil}, {Knobs{UnknownAgent: true}, "e2e-unknown"}} {
		_, j := newTestServer(t, tc.k)
		if got := j.spec["agent"]; got != tc.want {
			t.Errorf("%+v: agent %v", tc.k, got)
		}
		if j.spec["model"] != "kete/"+Model {
			t.Errorf("model %v", j.spec["model"])
		}
	}
}

func message(toolResults ...string) []byte {
	msgs := []any{map[string]any{"role": "user", "content": "go"}}
	for i, r := range toolResults {
		msgs = append(msgs,
			map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "t" + string(rune('0'+i)), "name": "shell", "input": map[string]any{}}}},
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "t" + string(rune('0'+i)), "content": r}}})
	}
	b, _ := json.Marshal(map[string]any{"model": Model, "stream": false, "tools": []any{map[string]string{"name": "shell"}, map[string]string{"name": "edit"}, map[string]string{"name": "read"}, map[string]string{"name": "write"}}, "messages": msgs})
	return b
}

func TestGatewayAuthAndAgentHeaders(t *testing.T) {
	s, j := newTestServer(t, Knobs{})
	url := "https://" + GatewayHost + "/anthropic/v1/messages"
	if rec := do(s, "POST", url, message(), map[string]string{"x-api-key": "wrong", "x-kete-agent-id": j.AgentID, "x-kete-agent-version": "1"}); rec.Code != 401 {
		t.Fatalf("wrong key: %d", rec.Code)
	}
	rec := do(s, "POST", url, message(), map[string]string{"x-api-key": j.GatewayKey})
	if rec.Code != 403 || rec.Header().Get("x-kete-error-code") != "kete_agent_not_found" {
		t.Fatalf("missing agent header: %d %v", rec.Code, rec.Header())
	}
	if len(s.ContractErrors()) != 1 {
		t.Fatalf("contract %v", s.ContractErrors())
	}
	if rec := do(s, "POST", url, message(), map[string]string{"x-api-key": j.GatewayKey, "x-kete-agent-id": j.AgentID, "x-kete-agent-version": "2"}); rec.Code != 403 {
		t.Fatalf("wrong version: %d", rec.Code)
	}
	if rec := do(s, "GET", "https://"+GatewayHost+"/anthropic/v1/models", nil, map[string]string{"x-api-key": j.GatewayKey}); rec.Code != 200 || !strings.Contains(rec.Body.String(), Model) {
		t.Fatalf("models: %d %s", rec.Code, rec.Body)
	}
	if rec := do(s, "GET", "https://"+GatewayHost+"/openai/v1/models", nil, map[string]string{"Authorization": "Bearer " + j.GatewayKey}); rec.Code != 200 {
		t.Fatalf("openai models: %d", rec.Code)
	}
	if rec := do(s, "GET", "https://"+GatewayHost+"/gemini/v1beta/models", nil, map[string]string{"x-goog-api-key": j.GatewayKey}); rec.Code != 200 {
		t.Fatalf("gemini models: %d", rec.Code)
	}
}

func TestLifecycleScript(t *testing.T) {
	s, j := newTestServer(t, Knobs{})
	hdr := map[string]string{"x-api-key": j.GatewayKey, "x-kete-agent-id": j.AgentID, "x-kete-agent-version": "1"}
	url := "https://" + GatewayHost + "/anthropic/v1/messages"
	var out struct {
		Content []struct {
			Type, Name, Text string
			Input            map[string]any
		}
		StopReason string `json:"stop_reason"`
	}
	rec := do(s, "POST", url, message(), hdr)
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Content[0].Name != "shell" || out.Content[0].Input["command"] != "id -un" || out.StopReason != "tool_use" {
		t.Fatalf("turn 1: %s", rec.Body)
	}
	rec = do(s, "POST", url, message(ToolUser+"\n"), hdr)
	out.Content = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Content[0].Name != "edit" || out.Content[0].Input["newString"] != EditNew {
		t.Fatalf("turn 2: %s", rec.Body)
	}
	// Piece A3: plant the symlinks, read and write through them (refused), remove them.
	results := []string{ToolUser + "\n", "Edit applied"}
	turns := []struct{ tool, key, value, result string }{
		{"shell", "command", SymlinkPlant, ""},
		{"read", "path", SymlinkRead, "Unable to read " + SymlinkRead},
		{"write", "path", SymlinkWrite, "Unable to write " + SymlinkWrite},
		{"shell", "command", SymlinkRemove, ""},
	}
	for i, turn := range turns {
		rec = do(s, "POST", url, message(results...), hdr)
		out.Content = nil
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		if out.Content[0].Name != turn.tool || out.Content[0].Input[turn.key] != turn.value {
			t.Fatalf("turn %d: %s", i+3, rec.Body)
		}
		results = append(results, turn.result)
	}
	rec = do(s, "POST", url, message(results...), hdr)
	out.Content = nil
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out.Content[0].Type != "text" || out.StopReason != "end_turn" {
		t.Fatalf("final turn: %s", rec.Body)
	}
	if c := s.Checks(); !c["tool_user"] || !c["edit_ok"] || !c["symlink_read_refused"] || !c["symlink_write_refused"] {
		t.Fatalf("checks %v", c)
	}
	// A read that returned the spec's content is not a refusal.
	s2, j2 := newTestServer(t, Knobs{})
	hdr2 := map[string]string{"x-api-key": j2.GatewayKey, "x-kete-agent-id": j2.AgentID, "x-kete-agent-version": "1"}
	do(s2, "POST", url, message(ToolUser+"\n", "Edit applied", "", `{"branch":"`+j2.Branch+`"}`), hdr2)
	if s2.Checks()["symlink_read_refused"] {
		t.Fatal("a leaked spec counted as refused")
	}
	// Streaming answers are SSE.
	b := bytes.Replace(message(), []byte(`"stream":false`), []byte(`"stream":true`), 1)
	rec = do(s, "POST", url, b, hdr)
	if rec.Header().Get("Content-Type") != "text/event-stream" || !strings.Contains(rec.Body.String(), "input_json_delta") {
		t.Fatalf("stream: %s", rec.Body)
	}
}

func TestAC5Script(t *testing.T) {
	s, j := newTestServer(t, Knobs{Scenario: ScenarioAC5})
	hdr := map[string]string{"x-api-key": j.GatewayKey, "x-kete-agent-id": j.AgentID, "x-kete-agent-version": "1"}
	url := "https://" + GatewayHost + "/anthropic/v1/messages"
	results := []string{}
	for i := 0; i <= len(AC5Steps); i++ {
		rec := do(s, "POST", url, message(results...), hdr)
		if i < len(AC5Steps) {
			if !strings.Contains(rec.Body.String(), AC5Steps[i].Marker) {
				t.Fatalf("step %d: %s", i, rec.Body)
			}
			results = append(results, "ok\n"+AC5Steps[i].Marker+"\n")
		} else if !strings.Contains(rec.Body.String(), `"end_turn"`) {
			t.Fatalf("final: %s", rec.Body)
		}
	}
	c := s.Checks()
	for _, st := range AC5Steps {
		if !c[st.Marker] {
			t.Fatalf("checks %v", c)
		}
	}
}

func TestNotAgentTurnGetsText(t *testing.T) {
	s, j := newTestServer(t, Knobs{})
	hdr := map[string]string{"x-api-key": j.GatewayKey, "x-kete-agent-id": j.AgentID, "x-kete-agent-version": "1"}
	b, _ := json.Marshal(map[string]any{"model": Model, "messages": []any{map[string]any{"role": "user", "content": "title?"}}})
	rec := do(s, "POST", "https://"+GatewayHost+"/anthropic/v1/messages", b, hdr)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"text"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

// harnessVector is the shared test vector (kete-code-platform
// docs/contracts/test-vectors/jobs-v1/claim-harness-code.json, copied byte for byte; SHA256SUMS
// beside it catches drift).
type harnessVector struct {
	Request struct {
		ClaimToken string   `json:"claim_token"`
		Features   []string `json:"features"`
	} `json:"request"`
	Response struct {
		Clone struct {
			URL      string `json:"url"`
			Token    string `json:"token"`
			Provider string `json:"provider"`
			Username string `json:"username"`
		} `json:"clone"`
	} `json:"response"`
	BasicAuthorization string `json:"basic_authorization"`
	CloneDone          struct {
		Method        string         `json:"method"`
		Path          string         `json:"path"`
		Authorization string         `json:"authorization"`
		Body          map[string]any `json:"body"`
		Status        int            `json:"status"`
	} `json:"clone_done"`
}

func readVector(t *testing.T) (harnessVector, []byte) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "jobs-v1", "claim-harness-code.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v harnessVector
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v, data
}

func TestHarnessVectorChecksum(t *testing.T) {
	_, data := readVector(t)
	sums, err := os.ReadFile(filepath.Join("testdata", "jobs-v1", "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if want := hex.EncodeToString(sum[:]) + "  claim-harness-code.json\n"; string(sums) != want {
		t.Errorf("SHA256SUMS = %q, want %q (the vector drifted from the platform's copy)", sums, want)
	}
}

// The fake's Harness Code job has the vector's shape: provider, username, repository path, the
// basic-auth value and the clone-done call.
func TestHarnessVectorShape(t *testing.T) {
	v, _ := readVector(t)
	if v.Response.Clone.Provider != ProviderHarnessCode || v.Response.Clone.Username != HarnessUsername {
		t.Errorf("vector clone %+v", v.Response.Clone)
	}
	if !strings.HasSuffix(v.Response.Clone.URL, HarnessRepoPath) {
		t.Errorf("vector url %s, fake path %s", v.Response.Clone.URL, HarnessRepoPath)
	}
	if "Basic "+basic(v.Response.Clone.Username, v.Response.Clone.Token) != v.BasicAuthorization {
		t.Error("the fake's basic auth differs from the vector's basic_authorization")
	}
	if len(v.Request.Features) != 1 || v.Request.Features[0] != FeatureCloneRevokeCallback || !validFeatures(v.Request.Features) {
		t.Errorf("vector features %v", v.Request.Features)
	}
	cd := v.CloneDone
	if cd.Method != "POST" || cd.Path != "/api/v1/jobs/{id}/clone-done" || cd.Authorization != "Bearer <callback_token>" || len(cd.Body) != 0 || cd.Status != 204 {
		t.Errorf("vector clone_done %+v", cd)
	}
}

func claimBody(token string, features ...string) []byte {
	b, _ := json.Marshal(map[string]any{"claim_token": token, "features": features})
	return b
}

func TestHarnessClaimAndCloneDone(t *testing.T) {
	s := &Server{BaseSHA: strings.Repeat("a", 40)}
	j := s.NewJob(Knobs{Provider: ProviderHarnessCode, CloneDoneFailures: 1})
	base := "https://" + PlatformHost + "/api/v1/jobs/" + j.ID
	// Without clone_revoke_callback: refused before any credential (and a contract error).
	if rec := do(s, "POST", base+"/claim", claimBody(j.ClaimToken), nil); rec.Code != 404 || len(s.ContractErrors()) != 1 {
		t.Fatalf("claim without the feature: %d %v", rec.Code, s.ContractErrors())
	}
	j = s.NewJob(Knobs{Provider: ProviderHarnessCode, CloneDoneFailures: 1})
	base = "https://" + PlatformHost + "/api/v1/jobs/" + j.ID
	if rec := do(s, "POST", base+"/claim", claimBody(j.ClaimToken, "x", "BAD"), nil); rec.Code != 400 {
		t.Fatalf("bad feature name: %d", rec.Code)
	}
	j = s.NewJob(Knobs{Provider: ProviderHarnessCode, CloneDoneFailures: 1})
	base = "https://" + PlatformHost + "/api/v1/jobs/" + j.ID
	rec := do(s, "POST", base+"/claim", claimBody(j.ClaimToken, FeatureCloneRevokeCallback, "later_feature"), nil)
	if rec.Code != 200 {
		t.Fatalf("claim: %d", rec.Code)
	}
	var claim struct {
		Clone map[string]string `json:"clone"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &claim)
	if claim.Clone["provider"] != ProviderHarnessCode || claim.Clone["username"] != HarnessUsername || claim.Clone["url"] != "https://"+HarnessGitHost+HarnessRepoPath {
		t.Fatalf("clone %v", claim.Clone)
	}
	gitURL := "https://" + HarnessGitHost + HarnessRepoPath + "/info/refs?service=git-upload-pack"
	// The git host's API doesn't exist for Harness Code, and calling it is a contract error.
	if rec := do(s, "DELETE", "https://"+HarnessGitHost+"/api/v3/installation/token", nil, map[string]string{"Authorization": "token " + j.CloneToken}); rec.Code != 404 || len(s.ContractErrors()) != 1 {
		t.Fatalf("api: %d %v", rec.Code, s.ContractErrors())
	}
	// GitHub's username is refused.
	if rec := do(s, "GET", gitURL, nil, map[string]string{"Authorization": "Basic " + basic("x-access-token", j.CloneToken)}); rec.Code != 401 {
		t.Fatalf("x-access-token: %d", rec.Code)
	}
	cb := map[string]string{"Authorization": "Bearer " + j.CallbackToken}
	if rec := do(s, "POST", base+"/clone-done", []byte(`{"x":1}`), cb); rec.Code != 400 {
		t.Fatalf("clone-done with a field: %d", rec.Code)
	}
	if rec := do(s, "POST", base+"/clone-done", []byte(`{}`), cb); rec.Code != 500 {
		t.Fatalf("first clone-done (knob): %d", rec.Code)
	}
	if rec := do(s, "POST", base+"/clone-done", []byte(`{}`), cb); rec.Code != 204 || !j.CloneDeleted {
		t.Fatalf("clone-done: %d deleted=%v", rec.Code, j.CloneDeleted)
	}
	if rec := do(s, "POST", base+"/clone-done", nil, cb); rec.Code != 204 {
		t.Fatalf("repeated empty clone-done: %d", rec.Code)
	}
	// After clone-done the token no longer opens the repository.
	if rec := do(s, "GET", gitURL, nil, map[string]string{"Authorization": "Basic " + basic(HarnessUsername, j.CloneToken)}); rec.Code != 401 {
		t.Fatalf("git after clone-done: %d", rec.Code)
	}
	// The GitHub host is never contacted for a Harness Code job.
	if rec := do(s, "GET", "https://"+GitHost+"/org/repo.git/info/refs", nil, nil); rec.Code != 404 {
		t.Fatalf("github host: %d", rec.Code)
	}
	if n := len(s.ContractErrors()); n != 3 {
		t.Errorf("contract errors %v", s.ContractErrors())
	}
}

// A GitHub claim is unchanged: no provider or username in clone; clone-done is a no-op 204.
func TestGitHubClaimUnchanged(t *testing.T) {
	s := &Server{BaseSHA: strings.Repeat("a", 40)}
	j := s.NewJob(Knobs{})
	base := "https://" + PlatformHost + "/api/v1/jobs/" + j.ID
	rec := do(s, "POST", base+"/claim", claimBody(j.ClaimToken, FeatureCloneRevokeCallback), nil)
	if rec.Code != 200 {
		t.Fatalf("claim: %d", rec.Code)
	}
	var claim struct {
		Clone map[string]string `json:"clone"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &claim)
	if _, ok := claim.Clone["provider"]; ok || claim.Clone["username"] != "" || len(claim.Clone) != 4 {
		t.Errorf("clone %v", claim.Clone)
	}
	if rec := do(s, "POST", base+"/clone-done", []byte(`{}`), map[string]string{"Authorization": "Bearer " + j.CallbackToken}); rec.Code != 204 || j.CloneDeleted {
		t.Errorf("github clone-done: %d", rec.Code)
	}
	if len(s.ContractErrors()) != 0 {
		t.Errorf("contract errors %v", s.ContractErrors())
	}
}
