package fakeplatform

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
