package platform

// jobs-v1 runtime repositories (additive, 2026-10-07; platform ADR 0025; `docs/platform/jobs-v1.md`
// "Runtime repositories"): the `kubevm` profile's claim, finish and result bodies. The claim
// features and the fail-closed claim check (ParseRuntimeClaimResponse, the platform's
// `parseRuntimeClaimResponse`), the outbox finish, and the result bounded by the runner's data
// boundary (BoundRunResult, `boundJobRunResult`). Types and parsers only: the entrypoint's kubevm
// control flow uses them from piece P2.

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// Claim features of the runtime path. A runtime repository's claim is refused unless the request
// names both FeatureRuntimeRepo and FeatureRuntimePublish.
const (
	FeatureRuntimeRepo    = "runtime_repo"
	FeatureRuntimePublish = "runtime_publish"
)

// RuntimeClaimFeatures is what the kubevm entrypoint announces in its claim request (the vector's
// order). Only the kubevm profile sends the runtime features.
var RuntimeClaimFeatures = []string{FeatureCloneRevokeCallback, FeatureRuntimeRepo, FeatureRuntimePublish}

// RuntimeRepoProvider is `repository.provider` of a runtime claim.
const RuntimeRepoProvider = "runtime"

// Limits of the job spec (jobs-v1 JobSpec).
const (
	jobPromptMaxBytes  = 262_144
	jobBudgetMaxUSD    = 25
	jobTimeoutMaxMin   = 120
	jobAllowMaxRules   = 50
	jobBranchPrefix    = "kete/job/"
	runtimeRepoNameMax = 200
	maxSafeInteger     = 1<<53 - 1
)

var (
	runtimeRepoNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,19}:[A-Za-z0-9_][A-Za-z0-9._-]*(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)*$`)
	agentSlugRe       = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	gatewayKeyRe      = regexp.MustCompile(`^[\x21-\x7E]{1,200}$`)
	callbackTokenRe   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	gitRefCharsRe     = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,255}$`)
	gitRefBadRe       = regexp.MustCompile(`(^[-/.]|/$|\.$|//|\.\.|/\.|\.lock(/|$)|@\{)`)
	dnsHost           = `(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?`
	httpsURLRe        = regexp.MustCompile(`^https://` + dnsHost + `(?::443)?(?:/[\x21-\x22\x24-\x3E\x40-\x7E]*)?$`)
	httpsOriginRe     = regexp.MustCompile(`^https://` + dnsHost + `(?::443)?/?$`)
	timestampRe       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$`)
	outcomeRe         = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)
	sessionIDRe       = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	denialActionRe    = regexp.MustCompile(`^[a-z][a-z0-9_.:-]{0,63}$`)
)

// ValidRuntimeRepoName reports a JobRuntimeRepoName: `<kind>:<path>` (e.g. `gitlab:payments/api`),
// a label, never a URL; every segment starts with a letter, digit or `_`.
func ValidRuntimeRepoName(s string) bool {
	return len(s) <= runtimeRepoNameMax && runtimeRepoNameRe.MatchString(s)
}

// validJobGitRef is the platform's isJobGitRef.
func validJobGitRef(s string) bool {
	return gitRefCharsRe.MatchString(s) && !gitRefBadRe.MatchString(s)
}

// validJobBranch is JobBranch: `kete/job/<suffix>`, a valid ref.
func validJobBranch(s string) bool {
	return len(s) > len(jobBranchPrefix) && strings.HasPrefix(s, jobBranchPrefix) && validJobGitRef(s)
}

// jsLen is a JavaScript string's length (UTF-16 code units), what Zod's min and max count.
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		n += max(1, utf16.RuneLen(r))
	}
	return n
}

// jsSpace is JavaScript's WhiteSpace and LineTerminator (String.prototype.trim, regex \s).
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// validHTTPSHost is the schema's hostOk: the host part is at most 253 characters.
func validHTTPSHost(u string) bool {
	rest := strings.TrimPrefix(u, "https://")
	if i := strings.IndexAny(rest, ":/?"); i >= 0 {
		rest = rest[:i]
	}
	return len(rest) <= 253
}

func validHTTPSURL(u string) bool {
	return len(u) <= 2000 && httpsURLRe.MatchString(u) && validHTTPSHost(u) && !strings.Contains(u, "..")
}

func validHTTPSOrigin(u string) bool {
	return len(u) <= 300 && httpsOriginRe.MatchString(u) && validHTTPSHost(u)
}

// validTimestamp is Zod's iso.datetime({ offset: true }): seconds required, Z or ±hh:mm, a real
// calendar date.
func validTimestamp(s string) bool {
	if !timestampRe.MatchString(s) {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

// ---------------------------------------------------------------- the claim

// JobAllowRule is one allow rule of the job policy.
type JobAllowRule struct {
	Action   string `json:"action"`
	Resource string `json:"resource"`
}

func (JobAllowRule) strictObject() {}

// JobPolicy is the spec's policy.
type JobPolicy struct {
	Version float64        `json:"version"`
	Allow   []JobAllowRule `json:"allow"`
	Budget  float64        `json:"budget"`
	Timeout float64        `json:"timeout"`
}

func (JobPolicy) strictObject() {}

// JobSpec is jobs-v1 JobSpec as the platform compiles it (strict).
type JobSpec struct {
	Version float64   `json:"version"`
	Prompt  string    `json:"prompt"`
	Agent   string    `json:"agent"`
	Model   string    `json:"model"`
	Policy  JobPolicy `json:"policy"`
	Branch  string    `json:"branch"`
}

func (JobSpec) strictObject() {}

// Validate applies JobSpec's value rules. It names the first bad field, never a value.
func (s JobSpec) Validate() error {
	switch {
	case s.Version != 1:
		return errors.New("spec.version")
	case strings.TrimFunc(s.Prompt, jsSpace) == "" || len(s.Prompt) > jobPromptMaxBytes || !utf8.ValidString(s.Prompt):
		return errors.New("spec.prompt")
	case len(s.Agent) > 60 || !agentSlugRe.MatchString(s.Agent):
		return errors.New("spec.agent")
	case jsLen(s.Model) > 205 || !strings.HasPrefix(s.Model, "kete/") || len(s.Model) == len("kete/") || strings.ContainsFunc(s.Model[len("kete/"):], jsSpace):
		return errors.New("spec.model")
	case s.Policy.Version != 1:
		return errors.New("spec.policy.version")
	case len(s.Policy.Allow) > jobAllowMaxRules:
		return errors.New("spec.policy.allow")
	case !(s.Policy.Budget > 0 && s.Policy.Budget <= jobBudgetMaxUSD):
		return errors.New("spec.policy.budget")
	case s.Policy.Timeout != float64(int(s.Policy.Timeout)) || s.Policy.Timeout < 1 || s.Policy.Timeout > jobTimeoutMaxMin:
		return errors.New("spec.policy.timeout")
	case !validJobBranch(s.Branch):
		return errors.New("spec.branch")
	}
	for _, r := range s.Policy.Allow {
		if n := jsLen(r.Action); n < 1 || n > 200 {
			return errors.New("spec.policy.allow.action")
		}
		if n := jsLen(r.Resource); n < 1 || n > 500 {
			return errors.New("spec.policy.allow.resource")
		}
	}
	return nil
}

// RuntimeRepository is a runtime claim's `repository`.
type RuntimeRepository struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
}

// RuntimeClaimResponse is JobRuntimeClaimResponse: the claim response without `clone`, with the
// runtime repository's name. Unknown top-level fields are ignored (the spec is strict).
type RuntimeClaimResponse struct {
	Spec          JobSpec           `json:"-"`
	SpecRaw       json.RawMessage   `json:"spec"`
	GatewayKey    string            `json:"gateway_key"`
	CallbackToken string            `json:"callback_token"`
	GatewayURL    string            `json:"gateway_url"`
	PlatformURL   string            `json:"platform_url"`
	Deadline      string            `json:"deadline"`
	Repository    RuntimeRepository `json:"repository"`
	// Clone must be absent: a response with `clone` (a JobClaimResponse, or both) is refused.
	Clone json.RawMessage `json:"clone,omitempty"`
}

// ParseRuntimeClaimResponse is the kubevm entrypoint's fail-closed claim check
// (`parseRuntimeClaimResponse(value, localName)`): the body must be a JobRuntimeClaimResponse —
// no `clone`, provider `runtime` — naming exactly localName, the repository its runner looked up
// and resolved for this machine. Anything else is refused before anything is cloned; the error
// names the field, never a value. The caller's own checks (platform_url equals the machine's,
// deadline in the future) still follow.
func ParseRuntimeClaimResponse(data []byte, localName string) (*RuntimeClaimResponse, error) {
	var c RuntimeClaimResponse
	if err := decodeShape(data, &c); err != nil {
		return nil, fmt.Errorf("runtime claim: %w", err)
	}
	if err := decodeShape(c.SpecRaw, &c.Spec); err != nil {
		return nil, fmt.Errorf("runtime claim: spec: %w", err)
	}
	if err := c.validate(); err != nil {
		return nil, fmt.Errorf("runtime claim: %w", err)
	}
	if c.Repository.Name != localName {
		return nil, errors.New("runtime claim: repository.name is not the repository the runner resolved")
	}
	return &c, nil
}

func (c *RuntimeClaimResponse) validate() error {
	switch {
	case len(c.Clone) != 0:
		return errors.New("clone (a runtime claim never carries one)")
	case c.Repository.Provider != RuntimeRepoProvider:
		return errors.New("repository.provider")
	case !ValidRuntimeRepoName(c.Repository.Name):
		return errors.New("repository.name")
	case !gatewayKeyRe.MatchString(c.GatewayKey):
		return errors.New("gateway_key")
	case !callbackTokenRe.MatchString(c.CallbackToken):
		return errors.New("callback_token")
	case !validHTTPSURL(c.GatewayURL):
		return errors.New("gateway_url")
	case !validHTTPSOrigin(c.PlatformURL):
		return errors.New("platform_url")
	case !validTimestamp(c.Deadline):
		return errors.New("deadline")
	}
	return c.Spec.Validate()
}

// RuntimeFinishRequest is JobRuntimeFinishRequest: the bundle, audit and proxy log are in the
// runner's outbox, never uploaded.
type RuntimeFinishRequest struct {
	Outbox bool `json:"outbox"`
}

// NewRuntimeFinishRequest is the one valid body, `{"outbox":true}`.
func NewRuntimeFinishRequest() RuntimeFinishRequest { return RuntimeFinishRequest{Outbox: true} }

// ---------------------------------------------------------------- data boundary and result

// DataBoundary is JobDataBoundary: what the runner lets leave the enterprise. Each setting's
// values are ordered strictest first.
type DataBoundary struct {
	Summary     string `json:"summary"`
	Denials     string `json:"denials"`
	PublishRefs string `json:"publish_refs"`
}

func (DataBoundary) strictObject() {}

var (
	boundarySummary     = []string{"none", "redacted", "full"}
	boundaryDenials     = []string{"count", "actions", "full"}
	boundaryPublishRefs = []string{"omit", "send"}
)

// DefaultDataBoundary is JOB_DATA_BOUNDARY_DEFAULT.
var DefaultDataBoundary = DataBoundary{Summary: "none", Denials: "actions", PublishRefs: "send"}

// Validate applies JobDataBoundary.
func (b DataBoundary) Validate() error {
	if !slices.Contains(boundarySummary, b.Summary) || !slices.Contains(boundaryDenials, b.Denials) || !slices.Contains(boundaryPublishRefs, b.PublishRefs) {
		return errors.New("boundary: unknown setting")
	}
	return nil
}

// Narrow is narrowJobDataBoundary: the stricter of two boundaries, setting by setting.
func (b DataBoundary) Narrow(o DataBoundary) DataBoundary {
	stricter := func(options []string, x, y string) string {
		if slices.Index(options, x) <= slices.Index(options, y) {
			return x
		}
		return y
	}
	return DataBoundary{
		Summary:     stricter(boundarySummary, b.Summary, o.Summary),
		Denials:     stricter(boundaryDenials, b.Denials, o.Denials),
		PublishRefs: stricter(boundaryPublishRefs, b.PublishRefs, o.PublishRefs),
	}
}

// RuntimeDenial is JobRuntimeRunDenial: Count is set when denials of one action were aggregated.
type RuntimeDenial struct {
	Action    string   `json:"action"`
	Resources []string `json:"resources"`
	Message   *string  `json:"message,omitempty"`
	Count     *int64   `json:"count,omitempty"`
}

// RuntimeRunResult is JobRuntimeRunResult: `kete job run --json` result v1 with fixed-code
// outcome, session id and branch, and `denied_count`. Optional fields are pointers so an absent
// field stays absent; unknown fields are dropped (Zod parses, then the platform bounds the parsed
// value).
type RuntimeRunResult struct {
	Version     int             `json:"version"`
	Outcome     string          `json:"outcome"`
	ExitCode    int             `json:"exit_code"`
	SessionID   *string         `json:"session_id,omitempty"`
	Text        *string         `json:"text,omitempty"`
	Isolated    *bool           `json:"isolated,omitempty"`
	Branch      *string         `json:"branch,omitempty"`
	Worktree    *string         `json:"worktree,omitempty"`
	Directory   *string         `json:"directory,omitempty"`
	CostUSD     *float64        `json:"cost_usd,omitempty"`
	CostScope   *string         `json:"cost_scope,omitempty"`
	DurationMS  *int64          `json:"duration_ms,omitempty"`
	AuditLog    *string         `json:"audit_log,omitempty"`
	AuditLocal  *bool           `json:"audit_local,omitempty"`
	Denied      []RuntimeDenial `json:"denied"`
	DeniedCount *int64          `json:"denied_count,omitempty"`
	Message     *string         `json:"message,omitempty"`
}

// Validate applies JobRuntimeRunResult's value rules.
func (r RuntimeRunResult) Validate() error {
	switch {
	case r.Version != 1:
		return errors.New("result: version")
	case !outcomeRe.MatchString(r.Outcome):
		return errors.New("result: outcome")
	case r.ExitCode < 0 || r.ExitCode > 255:
		return errors.New("result: exit_code")
	case r.SessionID != nil && !sessionIDRe.MatchString(*r.SessionID):
		return errors.New("result: session_id")
	case r.Branch != nil && !validJobBranch(*r.Branch):
		return errors.New("result: branch")
	case r.CostUSD != nil && *r.CostUSD < 0:
		return errors.New("result: cost_usd")
	case r.CostScope != nil && *r.CostScope != "family" && *r.CostScope != "root":
		return errors.New("result: cost_scope")
	case r.DurationMS != nil && *r.DurationMS < 0:
		return errors.New("result: duration_ms")
	case r.DeniedCount != nil && (*r.DeniedCount < 0 || *r.DeniedCount > maxSafeInteger):
		return errors.New("result: denied_count")
	case r.Denied == nil:
		return errors.New("result: denied")
	}
	for _, d := range r.Denied {
		if !denialActionRe.MatchString(d.Action) || d.Resources == nil || (d.Count != nil && (*d.Count < 1 || *d.Count > maxSafeInteger)) {
			return errors.New("result: denied")
		}
	}
	return nil
}

// ParseRuntimeRunResult decodes (shape rules; unknown fields dropped) and validates a result.
func ParseRuntimeRunResult(data []byte) (RuntimeRunResult, error) {
	var r RuntimeRunResult
	if err := decodeShape(data, &r); err != nil {
		return RuntimeRunResult{}, fmt.Errorf("result: %w", err)
	}
	return r, r.Validate()
}

// BoundRunResult is boundJobRunResult: it applies a boundary to a result before it is sent.
// summary: `none` drops text, message and the local paths (worktree, directory, audit_log);
// `redacted` keeps text and message through redact and drops the paths; `full` keeps all.
// denials: `actions` makes one entry per action, in order of first appearance,
// `{ action, resources: [], count }`; `count` empties `denied`; both set `denied_count`; `full`
// keeps them as reported. Pure, and idempotent when redact is.
func BoundRunResult(r RuntimeRunResult, b DataBoundary, redact func(string) string) RuntimeRunResult {
	out := r
	if b.Summary != "full" {
		out.Worktree, out.Directory, out.AuditLog = nil, nil, nil
	}
	for _, field := range []**string{&out.Text, &out.Message} {
		switch {
		case *field == nil:
		case b.Summary == "none":
			*field = nil
		case b.Summary == "redacted":
			v := redact(**field)
			*field = &v
		}
	}
	if b.Denials == "full" {
		return out
	}
	var total int64
	if r.DeniedCount != nil {
		total = *r.DeniedCount
	} else {
		for _, d := range r.Denied {
			total += countOf(d)
		}
	}
	out.DeniedCount = &total
	if b.Denials == "count" {
		out.Denied = []RuntimeDenial{}
		return out
	}
	var order []string
	byAction := map[string]int64{}
	for _, d := range r.Denied {
		if _, seen := byAction[d.Action]; !seen {
			order = append(order, d.Action)
		}
		byAction[d.Action] += countOf(d)
	}
	out.Denied = make([]RuntimeDenial, 0, len(order))
	for _, a := range order {
		n := byAction[a]
		out.Denied = append(out.Denied, RuntimeDenial{Action: a, Resources: []string{}, Count: &n})
	}
	return out
}

func countOf(d RuntimeDenial) int64 {
	if d.Count != nil {
		return *d.Count
	}
	return 1
}
