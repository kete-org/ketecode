package platform

// jobs-v1 orchestrated jobs (additive, 2026-10-09; platform ADR 0026; `docs/platform/jobs-v1.md`
// "Orchestrated jobs" and `docs/platform/orchestrations-v1.md`): the claim feature, the
// orchestrated spec (`JobOrchestratedSpec`, with `JobSpecOrchestration`), the extra refs to fetch
// (`JobOrchestrationFetch`) and the fail-closed checks every orchestrated claim passes
// (`checkOrchestratedClaim`). An entrypoint that doesn't announce the feature never receives any
// of it; one that does refuses a response that fails any rule here before anything is cloned.

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/orchestration"
)

// FeatureOrchestration is the claim feature for orchestrated jobs: announced only by an
// entrypoint that fetches pinned refs, reads a worker's prompt from the plan file and builds plan
// bundles (O6). The platform refuses an orchestrated job's claim without it.
const FeatureOrchestration = "orchestration_v1"

// ClaimFeatures is what the cloud entrypoint announces in its claim request.
var ClaimFeatures = []string{FeatureCloneRevokeCallback, FeatureOrchestration}

// MaxFetch is ORCHESTRATION_MAX_FETCH: every node branch plus the plan branch.
const MaxFetch = orchestration.MaxNodes + 1

// Orchestration roles.
const (
	RoleCoordinator = "coordinator"
	RoleWorker      = "worker"
)

var (
	fetchNameRe = regexp.MustCompile(`^(?:plan|nodes/[a-z][a-z0-9-]{0,31})$`)
)

// PlanRef is OrchestrationPlanRef: a committed plan revision's branch and recorded commit.
type PlanRef struct {
	Rev    float64 `json:"rev"`
	Branch string  `json:"branch"`
	SHA    string  `json:"sha"`
}

func (PlanRef) strictObject() {}

func (p PlanRef) validate() error {
	if p.Rev != float64(int(p.Rev)) || p.Rev < 1 || p.Rev > orchestration.MaxTurns || !validJobBranch(p.Branch) || !shaPattern.MatchString(p.SHA) {
		return errors.New("plan")
	}
	return nil
}

// CoordinatorSpec is JobSpecOrchestration for a coordinator turn.
type CoordinatorSpec struct {
	Version float64  `json:"version"`
	ID      string   `json:"id"`
	Role    string   `json:"role"`
	Turn    float64  `json:"turn"`
	Final   bool     `json:"final"`
	Plan    *PlanRef `json:"plan" shape:"nullable"`
	Titles  string   `json:"titles"`
}

func (CoordinatorSpec) strictObject() {}

// WorkerSpec is JobSpecOrchestration for a node's attempt.
type WorkerSpec struct {
	Version      float64 `json:"version"`
	ID           string  `json:"id"`
	Role         string  `json:"role"`
	Node         string  `json:"node"`
	Attempt      float64 `json:"attempt"`
	Plan         PlanRef `json:"plan"`
	PromptDigest string  `json:"prompt_digest"`
	BaseFrom     *string `json:"base_from" shape:"nullable"`
}

func (WorkerSpec) strictObject() {}

// SpecOrchestration is `spec.orchestration`: exactly one of Coordinator or Worker is set.
type SpecOrchestration struct {
	Coordinator *CoordinatorSpec
	Worker      *WorkerSpec
}

// ID is the orchestration's id.
func (o SpecOrchestration) ID() string {
	if o.Coordinator != nil {
		return o.Coordinator.ID
	}
	return o.Worker.ID
}

// Plan is the plan revision the job fetches, or nil (a coordinator's first turn).
func (o SpecOrchestration) Plan() *PlanRef {
	if o.Coordinator != nil {
		return o.Coordinator.Plan
	}
	return &o.Worker.Plan
}

func parseSpecOrchestration(raw json.RawMessage) (SpecOrchestration, error) {
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil || obj == nil {
		return SpecOrchestration{}, errors.New("spec.orchestration: not an object")
	}
	var role string
	if r, ok := obj["role"]; !ok || json.Unmarshal(r, &role) != nil {
		return SpecOrchestration{}, errors.New("spec.orchestration.role")
	}
	switch role {
	case RoleCoordinator:
		var c CoordinatorSpec
		if err := decodeShape(raw, &c); err != nil {
			return SpecOrchestration{}, fmt.Errorf("spec.orchestration: %w", err)
		}
		switch {
		case c.Version != 1:
			return SpecOrchestration{}, errors.New("spec.orchestration.version")
		case !orchestration.ValidID(c.ID):
			return SpecOrchestration{}, errors.New("spec.orchestration.id")
		case c.Turn != float64(int(c.Turn)) || c.Turn < 1 || c.Turn > orchestration.MaxTurns:
			return SpecOrchestration{}, errors.New("spec.orchestration.turn")
		case c.Titles != string(orchestration.TitlesOmit) && c.Titles != string(orchestration.TitlesSend):
			return SpecOrchestration{}, errors.New("spec.orchestration.titles")
		}
		if c.Plan != nil {
			if err := c.Plan.validate(); err != nil {
				return SpecOrchestration{}, errors.New("spec.orchestration.plan")
			}
		}
		return SpecOrchestration{Coordinator: &c}, nil
	case RoleWorker:
		var w WorkerSpec
		if err := decodeShape(raw, &w); err != nil {
			return SpecOrchestration{}, fmt.Errorf("spec.orchestration: %w", err)
		}
		switch {
		case w.Version != 1:
			return SpecOrchestration{}, errors.New("spec.orchestration.version")
		case !orchestration.ValidID(w.ID):
			return SpecOrchestration{}, errors.New("spec.orchestration.id")
		case !orchestration.ValidNodeKey(w.Node):
			return SpecOrchestration{}, errors.New("spec.orchestration.node")
		case w.Attempt != float64(int(w.Attempt)) || w.Attempt < 1 || w.Attempt > orchestration.MaxAttempts:
			return SpecOrchestration{}, errors.New("spec.orchestration.attempt")
		case w.Plan.validate() != nil:
			return SpecOrchestration{}, errors.New("spec.orchestration.plan")
		case !orchestration.ValidDigest(w.PromptDigest):
			return SpecOrchestration{}, errors.New("spec.orchestration.prompt_digest")
		case w.BaseFrom != nil && !orchestration.ValidNodeKey(*w.BaseFrom):
			return SpecOrchestration{}, errors.New("spec.orchestration.base_from")
		}
		return SpecOrchestration{Worker: &w}, nil
	}
	return SpecOrchestration{}, errors.New("spec.orchestration.role")
}

// OrchestratedSpec is JobOrchestratedSpec: JobSpec without `review`, `prompt` exactly for a
// coordinator, and `orchestration`.
type OrchestratedSpec struct {
	Version          float64         `json:"version"`
	Prompt           *string         `json:"prompt,omitempty"`
	Agent            string          `json:"agent"`
	Model            string          `json:"model"`
	Policy           JobPolicy       `json:"policy"`
	Branch           string          `json:"branch"`
	OrchestrationRaw json.RawMessage `json:"orchestration"`

	Orchestration SpecOrchestration `json:"-"`
}

func (OrchestratedSpec) strictObject() {}

// FetchRef is JobOrchestrationFetch: an extra ref fetched in the clone phase as
// refs/heads/<Branch>, checked to be at SHA and exposed as refs/kete/<Name>.
type FetchRef struct {
	Name   string `json:"name"`
	Branch string `json:"branch"`
	SHA    string `json:"sha"`
}

func (FetchRef) strictObject() {}

// OrchestratedClaim is what an orchestrated claim adds to a claim: the strict spec and the fetches.
type OrchestratedClaim struct {
	Spec  OrchestratedSpec
	Fetch []FetchRef
}

// HasOrchestration reports whether a claim's spec carries `orchestration` (then it must pass
// ParseOrchestrated; a plain JobSpec never has the field).
func HasOrchestration(spec json.RawMessage) bool {
	var obj map[string]json.RawMessage
	if json.Unmarshal(spec, &obj) != nil {
		return false
	}
	_, ok := obj["orchestration"]
	return ok
}

// ParseOrchestrated checks an orchestrated claim's spec and fetches (shape and value rules) and
// the rules relating them to each other and to the clone (checkOrchestratedClaim). clone is nil
// for a runtime repository's claim (the runner pinned its base). The error names the rule, never a
// value.
func ParseOrchestrated(specRaw, fetchRaw json.RawMessage, clone *CloneRef) (*OrchestratedClaim, error) {
	var s OrchestratedSpec
	if err := decodeShape(specRaw, &s); err != nil {
		return nil, fmt.Errorf("spec: %w", err)
	}
	o, err := parseSpecOrchestration(s.OrchestrationRaw)
	if err != nil {
		return nil, err
	}
	s.Orchestration = o
	if err := s.validate(); err != nil {
		return nil, err
	}
	if len(fetchRaw) == 0 {
		return nil, errors.New("fetch: required")
	}
	var fetch []FetchRef
	if err := decodeShape(fetchRaw, &fetch); err != nil {
		return nil, fmt.Errorf("fetch: %w", err)
	}
	if len(fetch) > MaxFetch {
		return nil, errors.New("fetch: too many refs")
	}
	for _, f := range fetch {
		if !fetchNameRe.MatchString(f.Name) || !validJobBranch(f.Branch) || !shaPattern.MatchString(f.SHA) {
			return nil, errors.New("fetch: invalid ref")
		}
	}
	c := &OrchestratedClaim{Spec: s, Fetch: fetch}
	if err := c.check(clone); err != nil {
		return nil, err
	}
	return c, nil
}

// CloneRef is the part of a claim's clone the checks need.
type CloneRef struct {
	Ref     string
	BaseSHA string
}

func (s OrchestratedSpec) validate() error {
	base := JobSpec{Version: s.Version, Prompt: "x", Agent: s.Agent, Model: s.Model, Policy: s.Policy, Branch: s.Branch}
	if s.Prompt != nil {
		base.Prompt = *s.Prompt
	}
	if err := base.Validate(); err != nil {
		return err
	}
	if (s.Orchestration.Coordinator != nil) != (s.Prompt != nil) {
		return errors.New("spec.prompt (exactly for a coordinator)")
	}
	return nil
}

// check is checkOrchestratedClaim.
func (c *OrchestratedClaim) check(clone *CloneRef) error {
	o := c.Spec.Orchestration
	id := o.ID()
	prefix := orchestration.JobBranchPrefix + orchestration.ShortID(id) + "-"
	names := map[string]bool{}
	branches := map[string]bool{}
	for _, f := range c.Fetch {
		if names[f.Name] {
			return errors.New("fetch: duplicate name")
		}
		names[f.Name] = true
		if branches[f.Branch] {
			return errors.New("fetch: duplicate branch")
		}
		branches[f.Branch] = true
		if f.Name == "plan" {
			p := o.Plan()
			if p == nil || f.Branch != p.Branch || f.SHA != p.SHA {
				return errors.New("fetch: plan must be spec.orchestration.plan")
			}
			continue
		}
		key := strings.TrimPrefix(f.Name, "nodes/")
		if !orchestration.ValidNodeKey(key) || f.Branch != orchestration.NodeBranch(id, key) {
			return errors.New("fetch: not this orchestration's node branch")
		}
	}
	if p := o.Plan(); p != nil {
		if p.Branch != orchestration.PlanBranch(id, int64(p.Rev)) {
			return errors.New("spec.orchestration.plan: not this orchestration's plan branch")
		}
		if !names["plan"] {
			return errors.New("fetch: the plan revision must be fetched")
		}
	}
	if w := o.Worker; w != nil && c.Spec.Branch != orchestration.NodeBranch(id, w.Node) {
		return errors.New("spec.branch: a worker pushes its node's branch")
	}
	if o.Coordinator != nil && strings.HasPrefix(c.Spec.Branch, prefix) {
		return errors.New("spec.branch: a coordinator's branch is the integration branch")
	}
	if clone != nil {
		based := o.Worker != nil && o.Worker.BaseFrom != nil
		if based {
			if clone.Ref != orchestration.NodeBranch(id, *o.Worker.BaseFrom) {
				return errors.New("clone.ref: a worker based on a node clones that node's branch")
			}
			for _, f := range c.Fetch {
				if f.Name == "nodes/"+*o.Worker.BaseFrom && f.SHA != clone.BaseSHA {
					return errors.New("clone.base_sha: the base node's fetch and the clone disagree")
				}
			}
		} else if strings.HasPrefix(clone.Ref, orchestration.JobBranchPrefix) {
			return errors.New("clone.ref: the orchestration's base is never a job branch")
		}
	}
	return nil
}

// RuntimeOrchestratedClaimResponse is JobRuntimeOrchestratedClaimResponse: a runtime claim whose
// spec is orchestrated, with `fetch`. Types and the fail-closed check only: the kubevm entrypoint
// doesn't announce orchestration_v1 (the runner side is O10).
type RuntimeOrchestratedClaimResponse struct {
	RuntimeClaimResponse
	Orchestrated *OrchestratedClaim
}

// ParseRuntimeOrchestratedClaimResponse is parseRuntimeOrchestratedClaimResponse(value,
// localName): as ParseRuntimeClaimResponse, with the orchestrated spec and fetch.
func ParseRuntimeOrchestratedClaimResponse(data []byte, localName string) (*RuntimeOrchestratedClaimResponse, error) {
	var c RuntimeClaimResponse
	if err := decodeShape(data, &c); err != nil {
		return nil, fmt.Errorf("runtime claim: %w", err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return nil, errors.New("runtime claim: not an object")
	}
	oc, err := ParseOrchestrated(c.SpecRaw, top["fetch"], nil)
	if err != nil {
		return nil, fmt.Errorf("runtime claim: %w", err)
	}
	r := &RuntimeOrchestratedClaimResponse{RuntimeClaimResponse: c, Orchestrated: oc}
	// The response rules but the spec's (checked above, as an orchestrated spec).
	r.Spec = JobSpec{Version: 1, Prompt: "x", Agent: oc.Spec.Agent, Model: oc.Spec.Model, Policy: oc.Spec.Policy, Branch: oc.Spec.Branch}
	if err := r.validate(); err != nil {
		return nil, fmt.Errorf("runtime claim: %w", err)
	}
	if r.Repository.Name != localName {
		return nil, errors.New("runtime claim: repository.name is not the repository the runner resolved")
	}
	return r, nil
}
