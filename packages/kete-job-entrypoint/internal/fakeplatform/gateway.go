package fakeplatform

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// The scripted model's scenarios (Knobs.Scenario).
const (
	ScenarioLifecycle = "lifecycle" // shell `id -un`, an edit of README.md, the symlink steps (LifecycleSymlinks), then final text
	ScenarioAC5       = "ac5"       // an npm, a pip and a cargo install as the tool user, then final text
)

// The lifecycle scenario's edit: README.md's first line gains a suffix.
const (
	EditOld = "# fake repository"
	EditNew = "# fake repository (edited by the e2e)"
	// EditedReadme is README.md after the scripted edit.
	EditedReadme = EditNew + "\n"
	// ToolUser is the name `id -un` must print (the image's tool user).
	ToolUser = "kete-tool"
	// Worktree is where `kete job run` runs (the entrypoint's layout).
	Worktree = "/srv/kete-job/work/repo"
	// The lifecycle's planted symlinks (piece A3): the tool user links kete's own spec and a path in
	// kete's home into the worktree; kete's read and write tools must refuse to follow them.
	SymlinkPlant  = "ln -s /var/lib/kete-job/kete/spec.json e2e-read && ln -s /var/lib/kete-job/kete/e2e-written e2e-write"
	SymlinkRead   = Worktree + "/e2e-read"
	SymlinkWrite  = Worktree + "/e2e-write"
	SymlinkRemove = "rm e2e-read e2e-write"
)

// AC5Steps are the AC5 scenario's shell calls, in order, each ending in its marker. Everything goes
// to $TMPDIR, outside the worktree, so the bundle stays empty.
var AC5Steps = []struct{ Marker, Command string }{
	{"AC5_NPM_OK", `npm install --no-audit --no-fund --prefix "$TMPDIR/n" is-number@7.0.0 && echo AC5_NPM_OK`},
	{"AC5_PIP_OK", `python3 -m venv "$TMPDIR/v" && "$TMPDIR/v/bin/pip" install six==1.16.0 && echo AC5_PIP_OK`},
	{"AC5_CARGO_OK", `mkdir -p "$TMPDIR/c/src" && cd "$TMPDIR/c" && printf '[package]\nname = "e2e"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nitoa = "=1.0.11"\n' > Cargo.toml && echo 'fn main() {}' > src/main.rs && cargo fetch && echo AC5_CARGO_OK`},
}

// gateway is the fake Kete Model Gateway: the discovery routes and a scripted
// `POST /anthropic/v1/messages`. Every request must carry the job's gateway key in its route's
// header (`x-api-key` Anthropic, `x-goog-api-key` Gemini, `authorization: Bearer` the others); every message request must carry the
// synced agent's `x-kete-agent-id` and `x-kete-agent-version` (ADR 0020 rule 9), else 403
// `kete_agent_not_found` and a contract error.
func (s *Server) gateway(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	s.mu.Lock()
	j := s.job
	if j == nil {
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	key := r.Header.Get("X-Api-Key") // Anthropic
	if key == "" {
		key = r.Header.Get("X-Goog-Api-Key") // Gemini
	}
	if key == "" {
		key = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") // OpenAI and the compat routes
	}
	kind := "gateway:models"
	if r.URL.Path == "/anthropic/v1/messages" {
		kind = "messages"
	}
	if key != j.GatewayKey {
		s.record(kind, nil, 401)
		s.mu.Unlock()
		writeJSON(w, 401, map[string]any{"type": "error", "error": map[string]string{"type": "authentication_error", "message": "invalid key"}})
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/anthropic/v1/models":
		s.record(kind, []byte(r.URL.Path), 200)
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"data": []map[string]string{{"id": Model, "display_name": "Claude Haiku 4.5"}}})
	case r.Method == http.MethodGet && (r.URL.Path == "/openai/v1/models" || r.URL.Path == "/compat/deepseek/v1/models" || r.URL.Path == "/compat/openrouter/v1/models"):
		s.record(kind, []byte(r.URL.Path), 200)
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"object": "list", "data": []any{}})
	case r.Method == http.MethodGet && r.URL.Path == "/gemini/v1beta/models":
		s.record(kind, []byte(r.URL.Path), 200)
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"models": []any{}})
	case r.Method == http.MethodPost && kind == "messages":
		s.messages(w, r, j, body) // unlocks
	default:
		s.record("gateway:?", []byte(r.Method+" "+r.URL.Path), 404)
		s.mu.Unlock()
		writeJSON(w, 404, map[string]any{"type": "error", "error": map[string]string{"type": "not_found_error", "message": "not available"}})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type anthropicRequest struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
	Tools  []struct {
		Name string `json:"name"`
	} `json:"tools"`
	Messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"messages"`
}

// toolResults returns how many tool_result blocks the request carries and the last one's content
// as raw JSON (searched for markers).
func (req *anthropicRequest) toolResults() (int, string) {
	n, last := 0, ""
	for _, m := range req.Messages {
		var blocks []struct {
			Type    string          `json:"type"`
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(m.Content, &blocks) != nil {
			continue // a plain string
		}
		for _, b := range blocks {
			if b.Type == "tool_result" {
				n++
				last = string(b.Content)
			}
		}
	}
	return n, last
}

func (req *anthropicRequest) hasTool(name string) bool {
	for _, t := range req.Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// block is one content block of the scripted answer.
type block struct {
	text  string
	tool  string
	input map[string]any
}

// messages answers one model request from the scenario's script (s.mu held; unlocks).
func (s *Server) messages(w http.ResponseWriter, r *http.Request, j *Job, body []byte) {
	if r.Header.Get("X-Kete-Agent-Id") != j.AgentID || r.Header.Get("X-Kete-Agent-Version") != "1" {
		s.violation("messages: x-kete-agent-id %q / x-kete-agent-version %q, want the synced agent's id and version 1",
			r.Header.Get("X-Kete-Agent-Id"), r.Header.Get("X-Kete-Agent-Version"))
		s.record("messages", []byte(`{"agent_headers":false}`), 403)
		s.mu.Unlock()
		w.Header().Set("x-kete-error-code", "kete_agent_not_found")
		writeJSON(w, 403, map[string]any{"type": "error", "error": map[string]string{"type": "permission_error", "message": "unknown agent"}})
		return
	}
	var req anthropicRequest
	if err := json.Unmarshal(body, &req); err != nil {
		s.violation("messages: body: %v", err)
		s.record("messages", nil, 400)
		s.mu.Unlock()
		writeJSON(w, 400, map[string]any{"type": "error", "error": map[string]string{"type": "invalid_request_error", "message": "bad body"}})
		return
	}
	if req.Model != Model {
		s.violation("messages: model %q, want %q", req.Model, Model)
	}
	n, last := req.toolResults()
	var answer block
	stop := "tool_use"
	switch {
	case !req.hasTool("shell") || !req.hasTool("edit"):
		// Not the agent's turn (e.g. a title or summary request): plain text.
		answer, stop = block{text: "E2E job"}, "end_turn"
	case j.Knobs.Scenario == ScenarioAC5:
		if n > 0 && n <= len(AC5Steps) {
			s.checks[AC5Steps[n-1].Marker] = strings.Contains(last, AC5Steps[n-1].Marker)
		}
		if n < len(AC5Steps) {
			answer = block{tool: "shell", input: map[string]any{"command": AC5Steps[n].Command, "timeout": 600000}}
		} else {
			answer, stop = block{text: "AC5 done."}, "end_turn"
		}
	default: // lifecycle
		if !req.hasTool("read") || !req.hasTool("write") {
			s.violation("messages: the agent's turn offers no read or write tool (the symlink steps need both)")
		}
		switch n {
		case 0:
			answer = block{tool: "shell", input: map[string]any{"command": "id -un"}}
		case 1:
			s.checks["tool_user"] = strings.Contains(last, ToolUser)
			answer = block{tool: "edit", input: map[string]any{"path": Worktree + "/README.md", "oldString": EditOld, "newString": EditNew}}
		case 2:
			s.checks["edit_ok"] = !strings.Contains(strings.ToLower(last), "error")
			answer = block{tool: "shell", input: map[string]any{"command": SymlinkPlant}}
		case 3:
			answer = block{tool: "read", input: map[string]any{"path": SymlinkRead}}
		case 4:
			// Refused: an error, and nothing of the spec (its branch, the agent's slug) leaked.
			s.checks["symlink_read_refused"] = strings.Contains(last, "Unable to read") &&
				!strings.Contains(last, j.Branch) && !strings.Contains(last, AgentSlug)
			answer = block{tool: "write", input: map[string]any{"path": SymlinkWrite, "content": "x"}}
		case 5:
			s.checks["symlink_write_refused"] = strings.Contains(last, "Unable to write")
			// The bundle refuses any symlink (push_error: symlink): remove them again.
			answer = block{tool: "shell", input: map[string]any{"command": SymlinkRemove}}
		default:
			answer, stop = block{text: "Done: README.md edited."}, "end_turn"
		}
	}
	summary, _ := json.Marshal(map[string]any{"agent_headers": true, "tool_results": n, "stream": req.Stream, "answer_tool": answer.tool})
	s.record("messages", summary, 200)
	s.mu.Unlock()
	id := "toolu_e2e_" + strconv.Itoa(n)
	if !req.Stream {
		content := map[string]any{"type": "text", "text": answer.text}
		if answer.tool != "" {
			content = map[string]any{"type": "tool_use", "id": id, "name": answer.tool, "input": answer.input}
		}
		writeJSON(w, 200, map[string]any{
			"id": "msg_e2e_" + strconv.Itoa(n), "type": "message", "role": "assistant", "model": Model,
			"content": []any{content}, "stop_reason": stop, "stop_sequence": nil,
			"usage": map[string]int{"input_tokens": 10, "output_tokens": 5},
		})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(200)
	ev := func(name string, v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, b)
	}
	ev("message_start", map[string]any{"type": "message_start", "message": map[string]any{
		"id": "msg_e2e_" + strconv.Itoa(n), "type": "message", "role": "assistant", "model": Model, "content": []any{},
		"stop_reason": nil, "stop_sequence": nil, "usage": map[string]int{"input_tokens": 10, "output_tokens": 1},
	}})
	if answer.tool != "" {
		input, _ := json.Marshal(answer.input)
		ev("content_block_start", map[string]any{"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "tool_use", "id": id, "name": answer.tool, "input": map[string]any{}}})
		ev("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": string(input)}})
	} else {
		ev("content_block_start", map[string]any{"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "text", "text": ""}})
		ev("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": answer.text}})
	}
	ev("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	ev("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": stop, "stop_sequence": nil},
		"usage": map[string]int{"output_tokens": 5}})
	ev("message_stop", map[string]any{"type": "message_stop"})
}
