package fakeplatform

// Pull request review jobs in the fake (jobs-v1 "Pull request review"): the repository gets one pull
// request's head ref (refs/pull/<ReviewPull>/head, one commit on top of main changing ReviewFile); a
// job made with Knobs.Review carries spec.review, clones main pinned at that head, and is served only
// to a claim announcing review_v1 (else 404, as the platform answers); its result's review is checked
// with the platform's rules (ParseReviewOutput) and recorded, its uploads must ask for no bundle,
// and its finish carries no push error.

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
)

// The fake's pull request.
const (
	FeatureReview = "review_v1"
	ReviewPull    = 7
	ReviewHeadRef = "refs/pull/7/head"
	// ReviewFile is the file the pull request changes; ReviewLine its changed line.
	ReviewFile    = "src/app.txt"
	ReviewNew     = "app\nwhile (true) {} // E2E_REVIEW_CHANGE\n"
	ReviewLine    = 2
	ReviewPrompt  = "Review pull request #7 of org/repo. Report findings only; change nothing."
	ReviewSummary = "E2E review: one finding."
	ReviewBody    = "This loop never ends: add an exit condition."
)

// makeReviewRef commits the pull request's change on a detached head and points ReviewHeadRef at it
// (in the work tree; the bare clone copies it with --mirror semantics below).
func makeReviewRef(work string) (string, error) {
	if err := gitCmd(work, nil, "checkout", "-q", "--detach", "main"); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(work, ReviewFile), []byte(ReviewNew), 0o644); err != nil {
		return "", err
	}
	if err := gitCmd(work, nil, "commit", "-q", "-am", "E2E pull request"); err != nil {
		return "", err
	}
	sha, err := gitOut(work, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	if err := gitCmd(work, nil, "update-ref", ReviewHeadRef, sha); err != nil {
		return "", err
	}
	return sha, gitCmd(work, nil, "checkout", "-q", "main")
}

// reviewSpec fills a review job's spec and clone (s.mu held by NewJob's caller or not yet shared).
func (s *Server) reviewSpec(j *Job) {
	j.cloneRef = "main"
	j.BaseSHA = s.reviewHead
	j.spec["prompt"] = ReviewPrompt
	j.spec["policy"].(map[string]any)["allow"] = []any{}
	j.spec["review"] = map[string]any{
		"version": 1, "pull_number": ReviewPull, "head_sha": s.reviewHead, "base_ref": "main",
		"head_ref": ReviewHeadRef, "untrusted": true, "max_findings": 10,
	}
}

// checkReviewResult validates a review job's result's review as the platform does (s.mu held).
func (s *Server) checkReviewResult(j *Job, body []byte) {
	var res struct {
		Review json.RawMessage `json:"review"`
	}
	_ = json.Unmarshal(body, &res)
	out, err := platform.ParseReviewOutput(res.Review)
	if err != nil {
		s.violation("result: review: %v", err)
		return
	}
	if len(out.Findings) > 10 {
		s.violation("result: review: more findings than max_findings")
	}
	j.Review = res.Review
}
