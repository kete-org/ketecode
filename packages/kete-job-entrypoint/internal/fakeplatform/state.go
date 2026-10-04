package fakeplatform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Done is closed when the job's finish is accepted.
func (j *Job) Done() <-chan struct{} { return j.done }

// Checks returns the scripted model's checks (tool user, edit, AC5 markers).
func (s *Server) Checks() map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]bool{}
	for k, v := range s.checks {
		out[k] = v
	}
	return out
}

// StateCall is one recorded request in calls.json.
type StateCall struct {
	Time   time.Time `json:"time"`
	Kind   string    `json:"kind"`
	Status int       `json:"status"`
	Body   string    `json:"body,omitempty"`
}

// StateJob is job.json: what the e2e asserter needs to know about the job.
type StateJob struct {
	ID            string `json:"id"`
	Branch        string `json:"branch"`
	BaseSHA       string `json:"base_sha"`
	AgentID       string `json:"agent_id"`
	Model         string `json:"model"`
	Scenario      string `json:"scenario"`
	PolicyTimeout int    `json:"policy_timeout"`
	OmitAgent     bool   `json:"omit_agent"`
	EditedReadme  string `json:"edited_readme"`
	ToolUser      string `json:"tool_user"`
	Finished      bool   `json:"finished"`
}

// StateTokens is tokens.json: the job's credentials, for the e2e's scans only.
type StateTokens struct {
	Claim      string `json:"claim"`
	Callback   string `json:"callback"`
	Clone      string `json:"clone"`
	GatewayKey string `json:"gateway_key"`
}

// WriteState writes the fake's records to dir: job.json, calls.json (bodies with every token
// replaced by its name), contract.json, leaks.json, checks.json, dns.json, uploads/<kind>, and
// tokens.json (the credentials, for the scans; never uploaded as a CI artifact).
func (s *Server) WriteState(dir string) error {
	s.mu.Lock()
	j := s.job
	calls := append([]Call(nil), s.calls...)
	contract := append([]string{}, s.contract...)
	leaks := append([]string{}, s.leaks...)
	dns := append([]string{}, s.dnsSeen...)
	checks := map[string]bool{}
	for k, v := range s.checks {
		checks[k] = v
	}
	var uploads map[string][]byte
	if j != nil {
		uploads = map[string][]byte{}
		for k, v := range j.uploaded {
			uploads[k] = v
		}
	}
	s.mu.Unlock()
	if j == nil {
		return os.ErrNotExist
	}
	scrub := strings.NewReplacer(j.ClaimToken, "<claim_token>", j.CallbackToken, "<callback_token>", j.CloneToken, "<clone_token>", j.GatewayKey, "<gateway_key>")
	out := make([]StateCall, 0, len(calls))
	for _, c := range calls {
		out = append(out, StateCall{Time: c.Time, Kind: c.Kind, Status: c.Status, Body: scrub.Replace(string(c.Body))})
	}
	scenario := j.Knobs.Scenario
	if scenario == "" {
		scenario = ScenarioLifecycle
	}
	files := map[string]any{
		"job.json": StateJob{
			ID: j.ID, Branch: j.Branch, BaseSHA: j.BaseSHA, AgentID: j.AgentID, Model: Model, Scenario: scenario,
			PolicyTimeout: j.Knobs.PolicyTimeout, OmitAgent: j.Knobs.OmitAgent, EditedReadme: EditedReadme, ToolUser: ToolUser,
			Finished: j.finished,
		},
		"calls.json":    out,
		"contract.json": contract,
		"leaks.json":    leaks,
		"checks.json":   checks,
		"dns.json":      dns,
		"tokens.json":   StateTokens{Claim: j.ClaimToken, Callback: j.CallbackToken, Clone: j.CloneToken, GatewayKey: j.GatewayKey},
	}
	if err := os.MkdirAll(filepath.Join(dir, "uploads"), 0o755); err != nil {
		return err
	}
	for name, v := range files {
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, name), append(b, '\n'), 0o644); err != nil {
			return err
		}
	}
	for kind, data := range uploads {
		if err := os.WriteFile(filepath.Join(dir, "uploads", kind), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}
