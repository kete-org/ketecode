package fakeplatform

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// The synced fixtures every job gets (kete-code-platform sync v1, util/src/kete/sync/contract.ts).
const (
	// Model is an Anthropic model in the runtime's bundled models.dev snapshot with tool calls
	// (core/src/models-dev/snapshot.txt): a job can only use models in that snapshot, since port A
	// never reaches models.dev. The synced agent maps it to `kete/<Model>`.
	Model     = "claude-haiku-4-5"
	AgentSlug = "e2e-developer"
	SkillSlug = "e2e-notes"
	OrgName   = "Kete E2E"
	// SkillFile is the synced skill's one supporting file.
	SkillFile        = "notes.md"
	SkillFileContent = "# e2e notes\n\nNothing to see here.\n"
)

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// headerLeaks records a credential presented to a host that must never see it (s.mu held): the
// gateway key on a job callback or the git host; the claim, callback or clone token on the sync or
// gateway routes.
func (s *Server) headerLeaks(j *Job, r *http.Request) {
	var forbidden map[string]string
	switch host(r) {
	case PlatformHost:
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v1/jobs/"+j.ID+"/orchestration"):
			// The coordinator routes take the turn's job key (orchestrations-v1), nothing else.
			forbidden = map[string]string{"claim token": j.ClaimToken, "callback token": j.CallbackToken, "clone token": j.CloneToken}
		case strings.HasPrefix(r.URL.Path, "/api/v1/jobs/"):
			forbidden = map[string]string{"gateway key": j.GatewayKey}
		default:
			forbidden = map[string]string{"claim token": j.ClaimToken, "callback token": j.CallbackToken, "clone token": j.CloneToken}
		}
	case GatewayHost:
		forbidden = map[string]string{"claim token": j.ClaimToken, "callback token": j.CallbackToken, "clone token": j.CloneToken}
	case GitHost, HarnessGitHost:
		forbidden = map[string]string{"gateway key": j.GatewayKey, "callback token": j.CallbackToken, "claim token": j.ClaimToken}
	case StorageHost:
		forbidden = map[string]string{"gateway key": j.GatewayKey, "callback token": j.CallbackToken, "claim token": j.ClaimToken, "clone token": j.CloneToken}
	}
	for name, tok := range forbidden {
		for hname, vals := range r.Header {
			for _, v := range vals {
				if strings.Contains(v, tok) {
					s.leaks = append(s.leaks, r.Method+" "+host(r)+r.URL.Path+": the "+name+" in header "+hname)
				}
			}
		}
	}
}

func (j *Job) agent() map[string]any {
	return map[string]any{
		"id": j.AgentID, "slug": AgentSlug, "version": 1, "name": "E2E Developer",
		"description": "The end-to-end test's developer agent.", "mode": "primary",
		"model":        map[string]any{"provider": "anthropic", "model_id": Model},
		"instructions": "You are the end-to-end test's developer agent.",
		"tools": map[string]any{
			"edit": true, "shell": true, "web": false, "skills": []string{SkillSlug}, "subagents": []string{}, "mcp": map[string]any{},
		},
		"permissions": []map[string]string{{"action": "*", "resource": "*", "effect": "allow"}},
		"budget":      map[string]any{"monthly_micros": nil, "spent_micros": 0, "period": time.Now().UTC().Format("2006-01")},
	}
}

func (j *Job) skill() map[string]any {
	return map[string]any{
		"id": j.SkillID, "slug": SkillSlug, "name": "E2E notes", "description": "Notes for the end-to-end test.",
		"version": "1.0.0", "instructions": "Read notes.md when asked about the end-to-end test.", "requires_mcp": []string{},
		"files": []map[string]any{{"path": SkillFile, "size_bytes": len(SkillFileContent), "sha256": sha256Hex(SkillFileContent), "executable": false}},
	}
}

// platformGet serves the platform's GET routes `kete` uses with the job's gateway key: the sync,
// the skill files, the model prices and `me`. The Bearer must be the gateway key and the job must
// be running.
func (s *Server) platformGet(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j := s.job
	reply := func(kind string, status int, v any, hdr map[string]string) {
		s.record(kind, nil, status)
		s.mu.Unlock()
		for k, val := range hdr {
			w.Header().Set(k, val)
		}
		if v == nil {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	errBody := func(code, msg string) map[string]any {
		return map[string]any{"error": map[string]string{"code": code, "message": msg, "request_id": "e2e-" + random(4)}}
	}
	kind := "platform:?"
	path := r.URL.Path
	switch {
	case path == "/api/v1/sync":
		kind = "sync"
	case strings.HasPrefix(path, "/api/v1/sync/skills/") && strings.HasSuffix(path, "/files"):
		kind = "skill_files"
	case path == "/api/v1/models":
		kind = "models"
	case path == "/api/v1/me":
		kind = "me"
	}
	if j == nil || kind == "platform:?" {
		reply(kind, 404, errBody("not_found", "not found"), nil)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+j.GatewayKey {
		reply(kind, 401, errBody("invalid_key", "unknown key"), nil)
		return
	}
	if j.state != "running" {
		reply(kind, 401, errBody("invalid_key", "the job is not running"), nil)
		return
	}
	switch kind {
	case "sync":
		if j.Knobs.SyncStatus != 0 {
			reply(kind, j.Knobs.SyncStatus, errBody("e2e", "scripted failure"), nil)
			return
		}
		const etag = `"e2e-1"`
		if r.Header.Get("If-None-Match") == etag {
			reply(kind, 304, nil, map[string]string{"ETag": etag})
			return
		}
		reply(kind, 200, map[string]any{
			"organization": map[string]string{"id": j.OrgID, "name": OrgName},
			"generated_at": time.Now().UTC().Format(time.RFC3339),
			"agents":       []any{j.agent()},
			"skills":       []any{j.skill()},
			"mcp_servers":  []any{},
			// A loaded, empty policy set: the runtime's fail-closed guard is for a missing cache.
			"policies": []any{},
		}, map[string]string{"ETag": etag})
	case "skill_files":
		id := strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/sync/skills/"), "/files")
		if id != j.SkillID {
			reply(kind, 404, errBody("not_found", "unknown skill"), nil)
			return
		}
		reply(kind, 200, map[string]any{
			"skill": map[string]string{"id": j.SkillID, "slug": SkillSlug},
			"files": []map[string]any{{
				"path": SkillFile, "size_bytes": len(SkillFileContent), "sha256": sha256Hex(SkillFileContent),
				"executable": false, "content": SkillFileContent,
			}},
		}, nil)
	case "models":
		reply(kind, 200, map[string]any{"models": []map[string]any{{
			"provider": "anthropic", "model_id": Model,
			"pricing_micros_per_mtok": map[string]int{"input": 1_000_000, "output": 5_000_000, "cache_read": 100_000, "cache_write": 1_250_000},
		}}}, nil)
	case "me":
		reply(kind, 200, map[string]any{"organization": map[string]string{"name": OrgName}, "balance_micros": 100_000_000, "currency": "USD"}, nil)
	}
}
