package platform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// orchestrationVector is jobs-v1/orchestration.json (kete-code-platform
// docs/contracts/test-vectors/jobs-v1/, copied byte for byte into
// internal/fakeplatform/testdata/jobs-v1; SHA256SUMS beside it catches drift).
type orchestrationVector struct {
	Request struct {
		ClaimToken string   `json:"claim_token"`
		Features   []string `json:"features"`
	} `json:"request"`
	Responses map[string]json.RawMessage `json:"responses"`
	Runtime   struct {
		LocalRepositoryName string          `json:"local_repository_name"`
		Response            json.RawMessage `json:"response"`
		RequestFeatures     []string        `json:"request_features"`
	} `json:"runtime"`
	Refusals []struct {
		Name     string          `json:"name"`
		Response json.RawMessage `json:"response"`
	} `json:"refusals"`
	Boundaries []struct {
		A        DataBoundary `json:"a"`
		B        DataBoundary `json:"b"`
		Narrowed DataBoundary `json:"narrowed"`
	} `json:"boundaries"`
}

func loadOrchestrationVector(t *testing.T) orchestrationVector {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "fakeplatform", "testdata", "jobs-v1", "orchestration.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v orchestrationVector
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// parseCloudOrchestrated is the cloud entrypoint's whole check of an orchestrated claim: the claim
// response's own rules (Validate, for the vector's platform URL) and the orchestration's.
func parseCloudOrchestrated(raw json.RawMessage) (*OrchestratedClaim, error) {
	resp, err := ParseClaim(raw)
	if err != nil {
		return nil, err
	}
	now, _ := time.Parse(time.RFC3339, "2026-10-09T10:00:00Z")
	claim, field := resp.Validate("https://portal.kete.example", "storage.kete.example", now)
	if claim == nil {
		return nil, &fieldError{field}
	}
	return ParseOrchestrated(resp.Spec, resp.Fetch, &CloneRef{Ref: claim.Ref, BaseSHA: claim.BaseSHA})
}

type fieldError struct{ field string }

func (e *fieldError) Error() string { return e.field }

func TestOrchestratedClaimVectors(t *testing.T) {
	v := loadOrchestrationVector(t)
	if !slices.Equal(v.Request.Features, ClaimFeatures) {
		t.Errorf("the vector's request announces %v, the entrypoint %v", v.Request.Features, ClaimFeatures)
	}
	if len(v.Responses) != 4 || len(v.Refusals) != 22 {
		t.Fatalf("%d responses and %d refusals; the contract has 4 and 22", len(v.Responses), len(v.Refusals))
	}
	for name, raw := range v.Responses {
		t.Run("accept/"+name, func(t *testing.T) {
			if !HasOrchestration(mustSpec(t, raw)) {
				t.Fatal("no orchestration")
			}
			c, err := parseCloudOrchestrated(raw)
			if err != nil {
				t.Fatalf("refused: %v", err)
			}
			if (c.Spec.Orchestration.Coordinator == nil) == (c.Spec.Orchestration.Worker == nil) {
				t.Error("exactly one role")
			}
		})
	}
	for _, r := range v.Refusals {
		t.Run("refuse/"+r.Name, func(t *testing.T) {
			if _, err := parseCloudOrchestrated(r.Response); err == nil {
				t.Error("accepted")
			} else if testing.Verbose() {
				t.Log(err)
			}
		})
	}
}

func mustSpec(t *testing.T, raw json.RawMessage) json.RawMessage {
	t.Helper()
	var top struct {
		Spec json.RawMessage `json:"spec"`
	}
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatal(err)
	}
	return top.Spec
}

func TestRuntimeOrchestratedClaimVector(t *testing.T) {
	v := loadOrchestrationVector(t)
	r, err := ParseRuntimeOrchestratedClaimResponse(v.Runtime.Response, v.Runtime.LocalRepositoryName)
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if r.Orchestrated.Spec.Orchestration.Worker == nil || len(r.Orchestrated.Fetch) != 2 {
		t.Error("lost the orchestration")
	}
	if _, err := ParseRuntimeOrchestratedClaimResponse(v.Runtime.Response, "gitlab:other/repo"); err == nil {
		t.Error("another repository accepted")
	}
	// A plain runtime claim parser never accepts an orchestrated spec.
	if _, err := ParseRuntimeClaimResponse(v.Runtime.Response, v.Runtime.LocalRepositoryName); err == nil {
		t.Error("ParseRuntimeClaimResponse accepted an orchestrated spec")
	}
}

func TestBoundaryTitlesVectors(t *testing.T) {
	v := loadOrchestrationVector(t)
	if len(v.Boundaries) == 0 {
		t.Fatal("no cases")
	}
	for i, c := range v.Boundaries {
		if err := c.A.Validate(); err != nil {
			t.Fatal(err)
		}
		if got := c.A.Narrow(c.B); got != c.Narrowed {
			t.Errorf("case %d: %+v, want %+v", i, got, c.Narrowed)
		}
	}
	if (DataBoundary{Summary: "none", Denials: "count", PublishRefs: "send", OrchestrationTitles: "maybe"}).Validate() == nil {
		t.Error("an unknown titles setting accepted")
	}
}

// TestPlainClaimHasNoOrchestration: a claim without spec.orchestration is untouched by any of it.
func TestPlainClaimHasNoOrchestration(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "fakeplatform", "testdata", "jobs-v1", "claim-harness-code.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Response struct {
			Spec json.RawMessage `json:"spec"`
		} `json:"response"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	if HasOrchestration(v.Response.Spec) {
		t.Error("a plain spec reads as orchestrated")
	}
}
