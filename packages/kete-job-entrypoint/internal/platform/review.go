package platform

// jobs-v1 pull request review (additive, 2026-10-08; platform ADR 0028; `docs/platform/jobs-v1.md`
// "Pull request review"): the claim feature, the review spec (`JobSpecReview`) and the fail-closed
// checks a review claim passes (ParseReview), and the findings a review job reports in its result
// (`JobReviewOutput`): checked exactly as the platform's `parseJobReviewOutput` does
// (ParseReviewOutput) and bounded before they leave (BoundReview), so a review the platform would
// drop whole is cut to what it accepts instead. An entrypoint that doesn't announce the feature never
// receives a review job; this one refuses a review claim that fails any rule here before anything is
// cloned.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// FeatureReview is the claim feature for pull request review jobs: announced only by an entrypoint
// that fetches the pull request's head and base, checks the pinned head, runs kete in review mode
// (read-only, no subprocess) and reports the findings. The platform refuses a review job's claim
// without it (entrypoint_outdated).
const FeatureReview = "review_v1"

// Bounds of JobSpecReview and JobReviewOutput.
const (
	ReviewMaxFindings     = 50
	ReviewSummaryMaxChars = 4000
	ReviewBodyMaxChars    = 2000
	ReviewTitleMaxChars   = 200
	ReviewPathMaxChars    = 1024
	ReviewMaxLine         = 1_000_000
	// ReviewMaxBytes bounds the serialized review (UTF-8 JSON).
	ReviewMaxBytes      = 64 * 1024
	reviewMaxPullNumber = 2_147_483_647
)

// SpecReview is JobSpecReview: `spec.review` of a review job.
type SpecReview struct {
	Version     float64 `json:"version"`
	PullNumber  float64 `json:"pull_number"`
	HeadSHA     string  `json:"head_sha"`
	BaseRef     string  `json:"base_ref"`
	HeadRef     string  `json:"head_ref"`
	Untrusted   bool    `json:"untrusted"`
	MaxFindings float64 `json:"max_findings"`
}

func (SpecReview) strictObject() {}

// Pull is the pull request's number.
func (s SpecReview) Pull() int { return int(s.PullNumber) }

// Max is the spec's max_findings.
func (s SpecReview) Max() int { return int(s.MaxFindings) }

// ReviewSpec is JobSpec with `review` (strict): a review job's whole spec.
type ReviewSpec struct {
	Version float64    `json:"version"`
	Prompt  string     `json:"prompt"`
	Agent   string     `json:"agent"`
	Model   string     `json:"model"`
	Policy  JobPolicy  `json:"policy"`
	Branch  string     `json:"branch"`
	Review  SpecReview `json:"review"`
}

func (ReviewSpec) strictObject() {}

// HasReview reports whether a claim's spec carries `review` (then it must pass ParseReview).
func HasReview(spec json.RawMessage) bool {
	var obj map[string]json.RawMessage
	if json.Unmarshal(spec, &obj) != nil {
		return false
	}
	_, ok := obj["review"]
	return ok
}

func (s SpecReview) validate() error {
	switch {
	case s.Version != 1:
		return errors.New("spec.review.version")
	case s.PullNumber != float64(int64(s.PullNumber)) || s.PullNumber < 1 || s.PullNumber > reviewMaxPullNumber:
		return errors.New("spec.review.pull_number")
	case !shaPattern.MatchString(s.HeadSHA):
		return errors.New("spec.review.head_sha")
	case !validJobGitRef(s.BaseRef):
		return errors.New("spec.review.base_ref")
	case s.HeadRef != fmt.Sprintf("refs/pull/%d/head", int64(s.PullNumber)):
		return errors.New("spec.review.head_ref")
	case s.MaxFindings != float64(int(s.MaxFindings)) || s.MaxFindings < 1 || s.MaxFindings > ReviewMaxFindings:
		return errors.New("spec.review.max_findings")
	}
	return nil
}

// ParseReview checks a review claim's spec (strict JobSpec with `review`: no `orchestration`, no
// `prompt_file`, every value rule) and its relation to the clone: `clone.ref` is the pull request's
// base branch and `clone.base_sha` its pinned head. The error names the rule, never a value.
func ParseReview(specRaw json.RawMessage, clone CloneRef) (*SpecReview, error) {
	var s ReviewSpec
	if err := decodeShape(specRaw, &s); err != nil {
		return nil, fmt.Errorf("spec: %w", err)
	}
	base := JobSpec{Version: s.Version, Prompt: s.Prompt, Agent: s.Agent, Model: s.Model, Policy: s.Policy, Branch: s.Branch}
	if err := base.Validate(); err != nil {
		return nil, err
	}
	if err := s.Review.validate(); err != nil {
		return nil, err
	}
	if s.Review.BaseRef == s.Branch {
		return nil, errors.New("spec.branch: a review's branch is never the pull request's base")
	}
	if clone.Ref != s.Review.BaseRef {
		return nil, errors.New("clone.ref: a review clones the pull request's base branch")
	}
	if clone.BaseSHA != s.Review.HeadSHA {
		return nil, errors.New("clone.base_sha: a review pins the pull request's head commit")
	}
	return &s.Review, nil
}

// ReviewFinding is JobReviewFinding (strict).
type ReviewFinding struct {
	Path     string  `json:"path"`
	Line     float64 `json:"line"`
	Side     *string `json:"side,omitempty"`
	Severity string  `json:"severity"`
	Title    *string `json:"title,omitempty"`
	Body     string  `json:"body"`
}

func (ReviewFinding) strictObject() {}

// ReviewOutput is JobReviewOutput (strict).
type ReviewOutput struct {
	Version  float64         `json:"version"`
	Summary  string          `json:"summary"`
	Findings []ReviewFinding `json:"findings"`
}

func (ReviewOutput) strictObject() {}

// ValidReviewPath is the contract's path rule: relative, `/`-separated, no empty, `.` or `..`
// segment, no backslash, no control character, 1–1024 characters.
func ValidReviewPath(p string) bool {
	if n := jsLen(p); n < 1 || n > ReviewPathMaxChars || !utf8.ValidString(p) {
		return false
	}
	if strings.HasPrefix(p, "/") || strings.Contains(p, `\`) {
		return false
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

func validSeverity(s string) bool {
	return s == "info" || s == "minor" || s == "major" || s == "critical"
}

// findingProblem names the first rule a finding breaks ("" when none).
func findingProblem(f ReviewFinding) string {
	switch {
	case !ValidReviewPath(f.Path):
		return "path"
	case f.Line != float64(int64(f.Line)) || f.Line < 1 || f.Line > ReviewMaxLine:
		return "line"
	case f.Side != nil && *f.Side != "RIGHT" && *f.Side != "LEFT":
		return "side"
	case !validSeverity(f.Severity):
		return "severity"
	case f.Title != nil && jsLen(*f.Title) > ReviewTitleMaxChars:
		return "title"
	case jsLen(f.Body) < 1 || jsLen(f.Body) > ReviewBodyMaxChars:
		return "body"
	}
	return ""
}

// Review rejection reasons (parseJobReviewOutput's).
var (
	ErrReviewMissing  = errors.New("review: missing")
	ErrReviewTooLarge = errors.New("review: too_large")
	ErrReviewInvalid  = errors.New("review: invalid")
)

// ParseReviewOutput is parseJobReviewOutput: absent (or null) is ErrReviewMissing, more than
// ReviewMaxBytes compact JSON ErrReviewTooLarge, anything the strict schema refuses
// ErrReviewInvalid (wrapped with the rule). The compact size is never below what the platform
// measures (JSON.stringify writes no longer escapes than any valid JSON text of the same value).
func ParseReviewOutput(raw json.RawMessage) (ReviewOutput, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return ReviewOutput{}, ErrReviewMissing
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, trimmed); err != nil {
		return ReviewOutput{}, ErrReviewInvalid
	}
	if compact.Len() > ReviewMaxBytes {
		return ReviewOutput{}, ErrReviewTooLarge
	}
	var out ReviewOutput
	if err := decodeShape(trimmed, &out); err != nil {
		return ReviewOutput{}, fmt.Errorf("%w: %v", ErrReviewInvalid, err)
	}
	if out.Version != 1 {
		return ReviewOutput{}, fmt.Errorf("%w: version", ErrReviewInvalid)
	}
	if jsLen(out.Summary) > ReviewSummaryMaxChars {
		return ReviewOutput{}, fmt.Errorf("%w: summary", ErrReviewInvalid)
	}
	if len(out.Findings) > ReviewMaxFindings {
		return ReviewOutput{}, fmt.Errorf("%w: findings", ErrReviewInvalid)
	}
	for i, f := range out.Findings {
		if p := findingProblem(f); p != "" {
			return ReviewOutput{}, fmt.Errorf("%w: findings[%d].%s", ErrReviewInvalid, i, p)
		}
	}
	return out, nil
}

// truncJS cuts s to at most n UTF-16 code units (Zod's max counts those), on a rune boundary.
func truncJS(s string, n int) string {
	if jsLen(s) <= n {
		return s
	}
	used := 0
	for i, r := range s {
		w := max(1, utf16.RuneLen(r))
		if used+w > n {
			return s[:i]
		}
		used += w
	}
	return s
}

// marshalReview writes the review as the platform will measure it: compact, no HTML escaping.
func marshalReview(v ReviewOutput) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// BoundReview makes kete's `review` one the platform accepts, or drops it: a value that isn't a
// strict JobReviewOutput in shape (unknown keys, wrong types, version ≠ 1) is dropped whole
// (ErrReviewMissing / ErrReviewInvalid); otherwise strings over their bound are cut, findings that
// break a value rule are left out, at most max (the spec's max_findings, itself ≤ 50) are kept, and
// findings are dropped from the end until the serialized review fits ReviewMaxBytes. notes say what
// was cut, in fixed words (never a value).
func BoundReview(raw json.RawMessage, maxFindings int) (json.RawMessage, []string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return nil, nil, ErrReviewMissing
	}
	var in ReviewOutput
	if err := decodeShape(trimmed, &in); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrReviewInvalid, err)
	}
	if in.Version != 1 {
		return nil, nil, fmt.Errorf("%w: version", ErrReviewInvalid)
	}
	if maxFindings < 1 || maxFindings > ReviewMaxFindings {
		maxFindings = ReviewMaxFindings
	}
	var notes []string
	out := ReviewOutput{Version: 1, Summary: truncJS(in.Summary, ReviewSummaryMaxChars), Findings: []ReviewFinding{}}
	if out.Summary != in.Summary {
		notes = append(notes, "review: the summary was cut to its limit")
	}
	invalid, cut := 0, 0
	for _, f := range in.Findings {
		if f.Title != nil {
			t := truncJS(*f.Title, ReviewTitleMaxChars)
			if t != *f.Title {
				cut++
			}
			f.Title = &t
		}
		if b := truncJS(f.Body, ReviewBodyMaxChars); b != f.Body {
			f.Body = b
			cut++
		}
		if findingProblem(f) != "" {
			invalid++
			continue
		}
		out.Findings = append(out.Findings, f)
	}
	if invalid > 0 {
		notes = append(notes, fmt.Sprintf("review: %d invalid finding(s) left out", invalid))
	}
	if cut > 0 {
		notes = append(notes, fmt.Sprintf("review: %d finding text(s) cut to their limit", cut))
	}
	if len(out.Findings) > maxFindings {
		notes = append(notes, fmt.Sprintf("review: %d finding(s) over max_findings left out", len(out.Findings)-maxFindings))
		out.Findings = out.Findings[:maxFindings]
	}
	dropped := 0
	for {
		b, err := marshalReview(out)
		if err != nil {
			return nil, notes, fmt.Errorf("%w: %v", ErrReviewInvalid, err)
		}
		if len(b) <= ReviewMaxBytes {
			if dropped > 0 {
				notes = append(notes, fmt.Sprintf("review: %d finding(s) left out to fit the size limit", dropped))
			}
			return b, notes, nil
		}
		if len(out.Findings) == 0 {
			// Unreachable with the bounds above (a 4000-character summary is far below 64 KiB).
			return nil, notes, ErrReviewTooLarge
		}
		out.Findings = out.Findings[:len(out.Findings)-1]
		dropped++
	}
}
