package orchestration

// The plan file (orchestrations-v1 "The plan file"): the one safe reader every side uses
// (`parseOrchestrationPlanFile`), the proposal a file stands for (`orchestrationPlanProposal`) and
// a worker's prompt (`readOrchestrationNodePrompt`). Size, then strict UTF-8, then strict JSON
// (planjson.go), then the strict schema, so this reader and the platform's agree byte for byte.

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode/utf16"
)

// Refusal is why a plan file (or a worker's read of it) is refused.
type Refusal string

const (
	RefuseTooLarge     Refusal = "too_large"
	RefuseNotUTF8      Refusal = "not_utf8"
	RefuseNotJSON      Refusal = "not_json"
	RefuseNotCanonical Refusal = "not_canonical"
	RefuseInvalid      Refusal = "invalid"
	// A worker's read only.
	RefusePlanMismatch   Refusal = "plan_mismatch"
	RefuseNoSuchNode     Refusal = "no_such_node"
	RefusePromptMismatch Refusal = "prompt_mismatch"
)

// Limits of the plan file (contract maxima).
const (
	PlanFileMaxBytes    = 262_144
	NodePromptMaxBytes  = 65_536
	NotesMaxBytes       = 32_768
	TitleMaxChars       = 80
	MaxNodesPerPlan     = 8
	MaxNodes            = 16
	MaxDependencies     = MaxNodes - 1
	MaxTurns            = 6
	MaxAttempts         = 3
	MaxParallel         = 8
	MinNodeBudgetMicros = 250_000
	JobBudgetMaxMicros  = 25_000_000
	JobTimeoutMaxMin    = 120
	agentSlugMax        = 60
)

var (
	idRe        = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	nodeKeyRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	agentSlugRe = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	sha256Re    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ValidID is OrchestrationId: a lowercase UUID.
func ValidID(s string) bool { return idRe.MatchString(s) }

// ValidNodeKey is OrchestrationNodeKey: `^[a-z][a-z0-9-]{0,31}$`, never `plan` or `plan-…`.
func ValidNodeKey(s string) bool {
	return nodeKeyRe.MatchString(s) && s != "plan" && !strings.HasPrefix(s, "plan-")
}

// ValidDigest is a SHA-256 in lowercase hex.
func ValidDigest(s string) bool { return sha256Re.MatchString(s) }

// SHA256Hex is the lowercase hex SHA-256 of b.
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// PlanNode is one node of the plan file.
type PlanNode struct {
	Key            string
	Title          *string
	Prompt         string
	DependsOn      []string
	BaseFrom       *string
	Agent          string
	BudgetMicros   int64
	TimeoutMinutes int64
	MaxAttempts    int64
}

// PlanFile is `.kete-orchestration/plan.json` (OrchestrationPlanFile).
type PlanFile struct {
	Version         int64
	OrchestrationID string
	Rev             int64
	Notes           string
	MaxParallel     *int64
	Nodes           []PlanNode
}

// ParsePlanFile is parseOrchestrationPlanFile: too_large, not_utf8, not_json, not_canonical or
// invalid, in that order.
func ParsePlanFile(data []byte) (*PlanFile, Refusal) {
	if len(data) > PlanFileMaxBytes {
		return nil, RefuseTooLarge
	}
	if !validUTF8(data) {
		return nil, RefuseNotUTF8
	}
	v, err := parsePlanJSON(string(data))
	if err != nil {
		return nil, err.(*planJSONError).reason
	}
	p, ok := planFromJSON(v)
	if !ok {
		return nil, RefuseInvalid
	}
	return p, ""
}

// --- the schema ---

// fields checks an object's member names: every required one present, nothing unknown.
func fields(v jsonValue, required, optional []string) bool {
	if v.kind != kindObject {
		return false
	}
	known := map[string]bool{}
	for _, n := range required {
		known[n] = true
		if _, ok := v.get(n); !ok {
			return false
		}
	}
	for _, n := range optional {
		known[n] = true
	}
	for _, m := range v.members {
		if !known[m.name] {
			return false
		}
	}
	return true
}

func intIn(v jsonValue, lo, hi float64) (int64, bool) {
	if v.kind != kindNumber || v.num < lo || v.num > hi || v.num != float64(int64(v.num)) {
		return 0, false
	}
	return int64(v.num), true
}

func stringOf(v jsonValue) (string, bool) {
	if v.kind != kindString {
		return "", false
	}
	return v.str, true
}

// jsSpace is JavaScript's WhiteSpace and LineTerminator (String.prototype.trim).
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// jsLen is a string's length in UTF-16 code units (what Zod's min and max count).
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		n += max(1, utf16.RuneLen(r))
	}
	return n
}

func blank(s string) bool { return strings.TrimFunc(s, jsSpace) == "" }

// validTitle is OrchestrationTitle: 1–80 characters, not blank, no control character, UTF-8.
func validTitle(s string) bool {
	if hasLoneSurrogate(s) || blank(s) {
		return false
	}
	if n := jsLen(s); n < 1 || n > TitleMaxChars {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7F {
			return false
		}
	}
	return true
}

func validPrompt(s string) bool {
	return !blank(s) && !hasLoneSurrogate(s) && len(s) <= NodePromptMaxBytes
}

func validNotes(s string) bool { return !hasLoneSurrogate(s) && len(s) <= NotesMaxBytes }

func validAgent(s string) bool { return len(s) <= agentSlugMax && agentSlugRe.MatchString(s) }

func nodeKeyOf(v jsonValue) (string, bool) {
	s, ok := stringOf(v)
	return s, ok && ValidNodeKey(s)
}

func planNodeFromJSON(v jsonValue) (PlanNode, bool) {
	var n PlanNode
	if !fields(v, []string{"key", "prompt", "depends_on", "base_from", "agent", "budget_micros", "timeout_minutes", "max_attempts"}, []string{"title"}) {
		return n, false
	}
	var ok bool
	get := func(name string) jsonValue { x, _ := v.get(name); return x }
	if n.Key, ok = nodeKeyOf(get("key")); !ok {
		return n, false
	}
	if t, present := v.get("title"); present {
		s, ok := stringOf(t)
		if !ok || !validTitle(s) {
			return n, false
		}
		n.Title = &s
	}
	if n.Prompt, ok = stringOf(get("prompt")); !ok || !validPrompt(n.Prompt) {
		return n, false
	}
	deps := get("depends_on")
	if deps.kind != kindArray || len(deps.arr) > MaxDependencies {
		return n, false
	}
	n.DependsOn = make([]string, 0, len(deps.arr))
	for _, d := range deps.arr {
		k, ok := nodeKeyOf(d)
		if !ok {
			return n, false
		}
		n.DependsOn = append(n.DependsOn, k)
	}
	if b := get("base_from"); b.kind != kindNull {
		k, ok := nodeKeyOf(b)
		if !ok {
			return n, false
		}
		n.BaseFrom = &k
	}
	if n.Agent, ok = stringOf(get("agent")); !ok || !validAgent(n.Agent) {
		return n, false
	}
	if n.BudgetMicros, ok = intIn(get("budget_micros"), MinNodeBudgetMicros, JobBudgetMaxMicros); !ok {
		return n, false
	}
	if n.TimeoutMinutes, ok = intIn(get("timeout_minutes"), 1, JobTimeoutMaxMin); !ok {
		return n, false
	}
	if n.MaxAttempts, ok = intIn(get("max_attempts"), 1, MaxAttempts); !ok {
		return n, false
	}
	return n, true
}

func planFromJSON(v jsonValue) (*PlanFile, bool) {
	if !fields(v, []string{"version", "orchestration_id", "rev", "notes", "nodes"}, []string{"max_parallel"}) {
		return nil, false
	}
	get := func(name string) jsonValue { x, _ := v.get(name); return x }
	p := &PlanFile{}
	var ok bool
	if ver := get("version"); ver.kind != kindNumber || ver.num != 1 {
		return nil, false
	}
	p.Version = 1
	if p.OrchestrationID, ok = stringOf(get("orchestration_id")); !ok || !ValidID(p.OrchestrationID) {
		return nil, false
	}
	if p.Rev, ok = intIn(get("rev"), 1, MaxTurns); !ok {
		return nil, false
	}
	if p.Notes, ok = stringOf(get("notes")); !ok || !validNotes(p.Notes) {
		return nil, false
	}
	if mp, present := v.get("max_parallel"); present {
		n, ok := intIn(mp, 1, MaxParallel)
		if !ok {
			return nil, false
		}
		p.MaxParallel = &n
	}
	nodes := get("nodes")
	if nodes.kind != kindArray || len(nodes.arr) < 1 || len(nodes.arr) > MaxNodesPerPlan {
		return nil, false
	}
	keys := map[string]bool{}
	for _, raw := range nodes.arr {
		n, ok := planNodeFromJSON(raw)
		if !ok || keys[n.Key] {
			return nil, false
		}
		keys[n.Key] = true
		p.Nodes = append(p.Nodes, n)
	}
	return p, true
}

// --- what the platform sees, and what a worker reads ---

// ProposalNode is OrchestrationProposalNode: the plan node without its prompt, with the prompt's
// SHA-256; Title only where titles may leave.
type ProposalNode struct {
	Key            string   `json:"key"`
	Title          *string  `json:"title,omitempty"`
	DependsOn      []string `json:"depends_on"`
	BaseFrom       *string  `json:"base_from"`
	Agent          string   `json:"agent"`
	BudgetMicros   int64    `json:"budget_micros"`
	TimeoutMinutes int64    `json:"timeout_minutes"`
	MaxAttempts    int64    `json:"max_attempts"`
	PromptDigest   string   `json:"prompt_digest"`
}

// Proposal is OrchestrationPlanProposal.
type Proposal struct {
	Version     int64          `json:"version"`
	Rev         int64          `json:"rev"`
	PlanDigest  string         `json:"plan_digest"`
	MaxParallel *int64         `json:"max_parallel,omitempty"`
	Nodes       []ProposalNode `json:"nodes"`
}

// Titles is OrchestrationTitles.
type Titles string

const (
	TitlesOmit Titles = "omit"
	TitlesSend Titles = "send"
)

// PlanProposal is orchestrationPlanProposal: the proposal the file's bytes stand for.
func PlanProposal(data []byte, titles Titles) (*Proposal, Refusal) {
	p, r := ParsePlanFile(data)
	if p == nil {
		return nil, r
	}
	out := &Proposal{Version: 1, Rev: p.Rev, PlanDigest: SHA256Hex(data), MaxParallel: p.MaxParallel, Nodes: []ProposalNode{}}
	for _, n := range p.Nodes {
		pn := ProposalNode{
			Key: n.Key, DependsOn: n.DependsOn, BaseFrom: n.BaseFrom, Agent: n.Agent, BudgetMicros: n.BudgetMicros,
			TimeoutMinutes: n.TimeoutMinutes, MaxAttempts: n.MaxAttempts, PromptDigest: SHA256Hex([]byte(n.Prompt)),
		}
		if titles == TitlesSend {
			pn.Title = n.Title
		}
		out.Nodes = append(out.Nodes, pn)
	}
	return out, ""
}

// PromptExpectation is what a worker's spec says its prompt must be.
type PromptExpectation struct {
	OrchestrationID string
	Rev             int64
	Key             string
	PromptDigest    string
}

// ReadNodePrompt is readOrchestrationNodePrompt: the plan must be the orchestration's at the
// expected revision (plan_mismatch), name the node (no_such_node), and the node's prompt must have
// the committed digest (prompt_mismatch).
func ReadNodePrompt(data []byte, e PromptExpectation) (string, Refusal) {
	p, r := ParsePlanFile(data)
	if p == nil {
		return "", r
	}
	if p.OrchestrationID != e.OrchestrationID || p.Rev != e.Rev {
		return "", RefusePlanMismatch
	}
	for _, n := range p.Nodes {
		if n.Key == e.Key {
			if SHA256Hex([]byte(n.Prompt)) != e.PromptDigest {
				return "", RefusePromptMismatch
			}
			return n.Prompt, ""
		}
	}
	return "", RefuseNoSuchNode
}
