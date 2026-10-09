package fakeplatform

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
)

// TestReviewClaim: a review job is served only to a claim announcing review_v1; its claim passes the
// entrypoint's checks (the contract's) and its pinned head is the repository's refs/pull/7/head.
func TestReviewClaim(t *testing.T) {
	s, j := orchestrationServer(t, Knobs{Review: true})
	if st, _ := claimOf(t, s, j, `"clone_revoke_callback","orchestration_v1"`); st != 404 {
		t.Fatalf("a claim without review_v1 = %d", st)
	}
	st, body := claimOf(t, s, j, `"clone_revoke_callback","orchestration_v1","review_v1"`)
	if st != 200 {
		t.Fatalf("claim %d", st)
	}
	resp, err := platform.ParseClaim(body)
	if err != nil {
		t.Fatal(err)
	}
	claim, field := resp.Validate("https://"+PlatformHost, "storage.other.test", time.Now())
	if claim == nil {
		t.Fatalf("claim field %s", field)
	}
	rv, err := platform.ParseReview(resp.Spec, platform.CloneRef{Ref: claim.Ref, BaseSHA: claim.BaseSHA})
	if err != nil {
		t.Fatalf("the fake's claim fails the contract: %v", err)
	}
	out, err := exec.Command("git", "--git-dir="+filepath.Join(s.repoDir, "org", "repo.git"), "rev-parse", ReviewHeadRef).Output()
	if err != nil || strings.TrimSpace(string(out)) != rv.HeadSHA || rv.HeadSHA == s.BaseSHA {
		t.Fatalf("refs/pull/7/head = %q (%v), spec head %s, main %s", out, err, rv.HeadSHA, s.BaseSHA)
	}
	if len(s.ContractErrors()) != 0 {
		t.Errorf("contract errors %v", s.ContractErrors())
	}
}
