package contract

// job-host-v2 orchestration additions (additive, 2026-10-09; platform ADR 0026; kete-code ADR 0012;
// `docs/platform/job-host-v2.md` "Orchestration"): the report's `features` and `cleanup`, the
// boundary's `orchestration_titles`, the run machine's pinned `repository.base_sha` (failed reason
// `ref_mismatch`) and `publish.orchestration`, and the desired state's `cleanup` items, each checked
// on its own. Mirror types and value rules only: the agent reports no feature and no cleanup until
// the runner's publisher handles them (piece O10), and builds reports exactly as before (every new
// field is omitted when empty).

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Orchestration constants of job-host-v2.
const (
	FeatureOrchestration = "orchestration_v1"
	V2MaxCleanup         = 64
	V2MaxFeatures        = 16
	ReasonRefMismatch    = "ref_mismatch"

	orchestrationMaxTurns    = 6
	orchestrationMaxAttempts = 3
	orchestrationMaxNodes    = 16
)

// JobHostV2Features is JOB_HOST_V2_FEATURES: the host features the platform knows.
var JobHostV2Features = []string{FeatureOrchestration}

var (
	featureNameRe    = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)
	orchestrationRe  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	nodeKeyRe        = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	planDigestRe     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	workBranchRe     = regexp.MustCompile(`^kete/job/[0-9a-f]{8}-(.+)$`)
	planBranchTailRe = regexp.MustCompile(`^plan-[1-6]$`)
)

// ValidNodeKey is OrchestrationNodeKey.
func ValidNodeKey(s string) bool {
	return nodeKeyRe.MatchString(s) && s != "plan" && !strings.HasPrefix(s, "plan-")
}

// ValidOrchestrationID is OrchestrationId (a lowercase UUID).
func ValidOrchestrationID(s string) bool { return orchestrationRe.MatchString(s) }

// OrchestrationPlanBranch is orchestrationPlanBranch: `kete/job/<o8>-plan-<rev>`.
func OrchestrationPlanBranch(id string, rev int) string {
	return jobBranchPrefix + id[:min(8, len(id))] + "-plan-" + strconv.Itoa(rev)
}

// OrchestrationNodeBranch is orchestrationNodeBranch: `kete/job/<o8>-<key>`.
func OrchestrationNodeBranch(id, key string) string {
	return jobBranchPrefix + id[:min(8, len(id))] + "-" + key
}

// IsOrchestrationWorkBranch is isOrchestrationWorkBranch: exactly an orchestration's plan branch
// (`kete/job/<8 lowercase hex>-plan-<1–6>`) or node branch (`kete/job/<8 lowercase hex>-<key>`).
func IsOrchestrationWorkBranch(branch string) bool {
	m := workBranchRe.FindStringSubmatch(branch)
	if m == nil {
		return false
	}
	return planBranchTailRe.MatchString(m[1]) || ValidNodeKey(m[1])
}

// ---------------------------------------------------------------- report

// Cleanup outcome statuses and the reasons each allows (JOB_HOST_CLEANUP_REASONS).
var CleanupReasons = map[string][]string{
	"deleted": {},
	"absent":  {},
	"moved":   {},
	"refused": {"invalid_item", "repository_unknown", "branch_protected"},
	"failed":  {"provider_unavailable", "provider_error"},
}

// CleanupOutcome is JobHostCleanupOutcome.
type CleanupOutcome struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

func (CleanupOutcome) strictObject() {}

// Validate applies JobHostCleanupOutcome: a known status, its reason required where it has any and
// fitting it.
func (c CleanupOutcome) Validate() error {
	allowed, ok := CleanupReasons[c.Status]
	if !ValidUUID(c.ID) || !ok {
		return errors.New("cleanup outcome: invalid id or status")
	}
	if len(allowed) > 0 && c.Reason == "" {
		return errors.New("cleanup outcome: reason is required")
	}
	if c.Reason != "" && !slices.Contains(allowed, c.Reason) {
		return errors.New("cleanup outcome: reason does not fit the status")
	}
	return nil
}

// validateOrchestrationReport applies the report's orchestration rules: features (≤ 16 names,
// unique; orchestration_v1 only while publish references are sent), cleanup outcomes (≤ 64, ids
// unique).
func (r ReportV2) validateOrchestration() error {
	if r.Features != nil {
		if len(r.Features) > V2MaxFeatures || !unique(r.Features) {
			return fmt.Errorf("report: features must be at most %d distinct names", V2MaxFeatures)
		}
		for _, f := range r.Features {
			if !featureNameRe.MatchString(f) {
				return errors.New("report: invalid feature name")
			}
		}
		if slices.Contains(r.Features, FeatureOrchestration) && r.Boundary.PublishRefs != boundarySend {
			return errors.New("report: orchestration_v1 needs a boundary that sends publish references")
		}
	}
	if r.Cleanup != nil {
		if len(r.Cleanup) > V2MaxCleanup {
			return fmt.Errorf("report: at most %d cleanup outcomes", V2MaxCleanup)
		}
		ids := make([]string, 0, len(r.Cleanup))
		for _, c := range r.Cleanup {
			if err := c.Validate(); err != nil {
				return fmt.Errorf("report: %w", err)
			}
			ids = append(ids, c.ID)
		}
		if !unique(ids) {
			return errors.New("report: duplicate cleanup id")
		}
	}
	return nil
}

// ---------------------------------------------------------------- desired state

// Orchestration publish kinds.
const (
	PublishKindPlan        = "plan"
	PublishKindNode        = "node"
	PublishKindIntegration = "integration"
)

// IntegrationNode is one node an integration publish lists.
type IntegrationNode struct {
	Key       string  `json:"key"`
	State     string  `json:"state"`
	CommitSHA *string `json:"commit_sha" shape:"nullable"`
}

var integrationNodeStates = []string{"succeeded", "succeeded_empty", "failed", "blocked", "superseded", "cancelled"}

// PublishOrchestration is JobHostV2PublishOrchestration (a union on Kind; unknown fields ignored).
// Rev and PlanDigest are a plan's, Key and Attempt a node's, Nodes an integration's.
type PublishOrchestration struct {
	Kind       string            `json:"kind"`
	ID         string            `json:"id"`
	Rev        int               `json:"rev,omitempty"`
	PlanDigest string            `json:"plan_digest,omitempty"`
	Key        string            `json:"key,omitempty"`
	Attempt    int               `json:"attempt,omitempty"`
	Nodes      []IntegrationNode `json:"nodes,omitempty"`

	present map[string]bool
}

// UnmarshalJSON records which members were present (each kind's fields are required).
func (p *PublishOrchestration) UnmarshalJSON(data []byte) error {
	type plain PublishOrchestration
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	var v plain
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	*p = PublishOrchestration(v)
	p.present = map[string]bool{}
	for k, val := range raw {
		p.present[k] = string(val) != "null"
	}
	return nil
}

// Validate applies the union's rules for its kind.
func (p PublishOrchestration) Validate() error {
	need := func(names ...string) error {
		for _, n := range names {
			if !p.present[n] {
				return fmt.Errorf("publish.orchestration: %s required", n)
			}
		}
		return nil
	}
	if !ValidOrchestrationID(p.ID) {
		return errors.New("publish.orchestration: invalid id")
	}
	switch p.Kind {
	case PublishKindPlan:
		if err := need("rev", "plan_digest"); err != nil {
			return err
		}
		if p.Rev < 1 || p.Rev > orchestrationMaxTurns || !planDigestRe.MatchString(p.PlanDigest) {
			return errors.New("publish.orchestration: invalid plan")
		}
	case PublishKindNode:
		if err := need("key", "attempt"); err != nil {
			return err
		}
		if !ValidNodeKey(p.Key) || p.Attempt < 1 || p.Attempt > orchestrationMaxAttempts {
			return errors.New("publish.orchestration: invalid node")
		}
	case PublishKindIntegration:
		if err := need("nodes"); err != nil {
			return err
		}
		if len(p.Nodes) > orchestrationMaxNodes {
			return errors.New("publish.orchestration: too many nodes")
		}
		for _, n := range p.Nodes {
			if !ValidNodeKey(n.Key) || !slices.Contains(integrationNodeStates, n.State) || (n.CommitSHA != nil && !ValidGitSHA(*n.CommitSHA)) {
				return errors.New("publish.orchestration: invalid integration node")
			}
		}
	default:
		return errors.New("publish.orchestration: unknown kind")
	}
	return nil
}

// validateOrchestration applies the run machine's orchestration rules: a pinned base is a SHA; a
// plan or node publish goes to exactly that orchestration branch, and only an integration opens a
// merge request.
func (m RunMachineV2) validateOrchestration() error {
	if r := m.Repository; r != nil && r.BaseSHA != "" && !ValidGitSHA(r.BaseSHA) {
		return errors.New("run machine: invalid repository.base_sha")
	}
	p := m.Publish
	if p == nil || p.Orchestration == nil {
		return nil
	}
	o := p.Orchestration
	if err := o.Validate(); err != nil {
		return fmt.Errorf("run machine: %w", err)
	}
	switch o.Kind {
	case PublishKindPlan:
		if p.Branch != OrchestrationPlanBranch(o.ID, o.Rev) {
			return errors.New("run machine: publish.branch is not the plan's branch")
		}
	case PublishKindNode:
		if p.Branch != OrchestrationNodeBranch(o.ID, o.Key) {
			return errors.New("run machine: publish.branch is not the node's branch")
		}
	}
	if (o.Kind == PublishKindIntegration) != p.OpenMR {
		return errors.New("run machine: only an integration opens a merge request")
	}
	return nil
}

// CleanupItemRef is a desired-state cleanup item as the poll response checks it (a loose object
// with an id); each item's own rules are CleanupItem's, applied item by item.
type CleanupItemRef struct {
	ID  string          `json:"id"`
	Raw json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps the item's raw bytes for ParseCleanupItem.
func (c *CleanupItemRef) UnmarshalJSON(data []byte) error {
	var head struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return err
	}
	c.ID, c.Raw = head.ID, append(json.RawMessage(nil), data...)
	return nil
}

// CleanupItem is JobHostCleanupItem: an orchestration plan or node branch to compare-and-delete.
type CleanupItem struct {
	ID         string `json:"id"`
	Repository string `json:"repository"`
	Branch     string `json:"branch"`
	ExpectSHA  string `json:"expect_sha"`
}

func (CleanupItem) strictObject() {}

// Validate applies JobHostCleanupItem.
func (c CleanupItem) Validate() error {
	switch {
	case !ValidUUID(c.ID):
		return errors.New("cleanup item: invalid id")
	case !ValidRuntimeRepoName(c.Repository):
		return errors.New("cleanup item: invalid repository")
	case !ValidJobBranch(c.Branch) || !IsOrchestrationWorkBranch(c.Branch):
		return errors.New("cleanup item: not an orchestration plan or node branch")
	case !ValidGitSHA(c.ExpectSHA):
		return errors.New("cleanup item: invalid expect_sha")
	}
	return nil
}

// ParseCleanupItem decodes and checks one desired-state cleanup item; a host reports an item that
// fails it `refused`/`invalid_item` and goes on with the others.
func ParseCleanupItem(raw []byte) (CleanupItem, error) {
	var c CleanupItem
	if err := Decode(raw, &c); err != nil {
		return CleanupItem{}, fmt.Errorf("cleanup item: %w", err)
	}
	return c, c.Validate()
}

// validateCleanup applies the desired state's `cleanup`: ≤ 64 items, each with a valid id, ids
// unique.
func (d DesiredStateV2) validateCleanup() error {
	if d.Cleanup == nil {
		return nil
	}
	if len(d.Cleanup) > V2MaxCleanup {
		return fmt.Errorf("poll response: at most %d cleanup items", V2MaxCleanup)
	}
	ids := make([]string, 0, len(d.Cleanup))
	for _, c := range d.Cleanup {
		if !ValidUUID(c.ID) {
			return errors.New("poll response: invalid cleanup id")
		}
		ids = append(ids, c.ID)
	}
	if !unique(ids) {
		return errors.New("poll response: duplicate cleanup id")
	}
	return nil
}
