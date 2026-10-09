package platform

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

// reviewVector is jobs-v1/review.json (kete-code-platform docs/contracts/test-vectors/jobs-v1/,
// copied byte for byte into internal/fakeplatform/testdata/jobs-v1; SHA256SUMS beside it).
type reviewVector struct {
	Request struct {
		ClaimToken string   `json:"claim_token"`
		Features   []string `json:"features"`
	} `json:"request"`
	Response       json.RawMessage   `json:"response"`
	Result         json.RawMessage   `json:"result"`
	InvalidReviews []json.RawMessage `json:"invalid_reviews"`
}

func loadReviewVector(t *testing.T) reviewVector {
	t.Helper()
	var v reviewVector
	readJobsVector(t, "review.json", &v)
	return v
}

// parseCloudReview is the cloud entrypoint's whole check of a review claim: the claim response's
// own rules (Validate, for the vector's platform URL) and the review's.
func parseCloudReview(t *testing.T, raw json.RawMessage) (*Claim, *SpecReview, error) {
	t.Helper()
	resp, err := ParseClaim(raw)
	if err != nil {
		return nil, nil, err
	}
	now, _ := time.Parse(time.RFC3339, "2026-10-08T10:00:00Z")
	claim, field := resp.Validate("https://portal.kete.example", "storage.kete.example", now)
	if claim == nil {
		return nil, nil, errors.New(field)
	}
	if !HasReview(resp.Spec) {
		return claim, nil, errors.New("no review")
	}
	rv, err := ParseReview(resp.Spec, CloneRef{Ref: claim.Ref, BaseSHA: claim.BaseSHA})
	return claim, rv, err
}

// mutate decodes the vector's response, applies f to it and encodes it again.
func mutate(t *testing.T, raw json.RawMessage, f func(m map[string]any)) json.RawMessage {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	f(m)
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestReviewClaimVector(t *testing.T) {
	v := loadReviewVector(t)
	// review_v1 is announced by the cloud entrypoint (which has review mode), with every feature the
	// vector's request names; the kubevm profile never announces it.
	if !slices.Contains(ClaimFeatures, FeatureReview) || FeatureReview != "review_v1" {
		t.Errorf("ClaimFeatures %v lacks review_v1", ClaimFeatures)
	}
	for _, f := range v.Request.Features {
		if !slices.Contains(ClaimFeatures, f) {
			t.Errorf("the vector announces %q, the entrypoint doesn't", f)
		}
	}
	if slices.Contains(RuntimeClaimFeatures, FeatureReview) {
		t.Error("the kubevm entrypoint announces review_v1 without review mode")
	}
	claim, rv, err := parseCloudReview(t, v.Response)
	if err != nil {
		t.Fatalf("vector response refused: %v", err)
	}
	if rv.Pull() != 42 || rv.HeadRef != "refs/pull/42/head" || !rv.Untrusted || rv.Max() != 50 || claim.Ref != "main" || claim.BaseSHA != rv.HeadSHA {
		t.Errorf("parsed %+v (claim ref %q base %q)", rv, claim.Ref, claim.BaseSHA)
	}
}

func TestReviewClaimRefusals(t *testing.T) {
	v := loadReviewVector(t)
	review := func(f func(r map[string]any)) func(m map[string]any) {
		return func(m map[string]any) { f(m["spec"].(map[string]any)["review"].(map[string]any)) }
	}
	cases := map[string]func(m map[string]any){
		"head moved (base_sha isn't the head)": func(m map[string]any) {
			m["clone"].(map[string]any)["base_sha"] = strings.Repeat("a", 40)
		},
		"clone.ref isn't the base": func(m map[string]any) { m["clone"].(map[string]any)["ref"] = "develop" },
		"head_ref of another pull": review(func(r map[string]any) { r["head_ref"] = "refs/pull/43/head" }),
		"head_ref a branch":        review(func(r map[string]any) { r["head_ref"] = "refs/heads/main" }),
		"unknown key":              review(func(r map[string]any) { r["verdict"] = "approve" }),
		"missing key":              review(func(r map[string]any) { delete(r, "untrusted") }),
		"null untrusted":           review(func(r map[string]any) { r["untrusted"] = nil }),
		"version 2":                review(func(r map[string]any) { r["version"] = 2 }),
		"pull 0":                   review(func(r map[string]any) { r["pull_number"] = 0 }),
		"pull fractional":          review(func(r map[string]any) { r["pull_number"] = 1.5 }),
		"pull too large":           review(func(r map[string]any) { r["pull_number"] = 2147483648 }),
		"head_sha uppercase":       review(func(r map[string]any) { r["head_sha"] = strings.Repeat("A", 40) }),
		"base_ref traversal":       review(func(r map[string]any) { r["base_ref"] = "../main" }),
		"max_findings 0":           review(func(r map[string]any) { r["max_findings"] = 0 }),
		"max_findings 51":          review(func(r map[string]any) { r["max_findings"] = 51 }),
		"orchestrated review": func(m map[string]any) {
			m["spec"].(map[string]any)["orchestration"] = map[string]any{"version": 1}
		},
		"branch is the base": func(m map[string]any) {
			m["spec"].(map[string]any)["branch"] = "kete/job/base"
			m["spec"].(map[string]any)["review"].(map[string]any)["base_ref"] = "kete/job/base"
			m["clone"].(map[string]any)["ref"] = "kete/job/base"
		},
		"prompt_file": func(m map[string]any) { m["spec"].(map[string]any)["prompt_file"] = "x" },
		"spec budget over the limit": func(m map[string]any) {
			m["spec"].(map[string]any)["policy"].(map[string]any)["budget"] = 26
		},
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			if _, rv, err := parseCloudReview(t, mutate(t, v.Response, f)); err == nil {
				t.Fatalf("accepted: %+v", rv)
			} else if strings.Contains(err.Error(), "acme") || strings.Contains(err.Error(), "ghs_") {
				t.Errorf("the error quotes a value: %v", err)
			}
		})
	}
}

// TestReviewRefusedByKubeVM: the kubevm profile's strict JobSpec refuses a spec with `review`.
func TestReviewRefusedByKubeVM(t *testing.T) {
	var rt runtimeClaimVector
	readJobsVector(t, "claim-runtime-repo.json", &rt)
	v := loadReviewVector(t)
	var spec map[string]any
	_ = json.Unmarshal(v.Response, &spec)
	body := mutate(t, rt.Response, func(m map[string]any) {
		m["spec"].(map[string]any)["review"] = spec["spec"].(map[string]any)["review"]
	})
	if c, err := ParseRuntimeClaimResponse(body, rt.KubeVM.LocalRepositoryName); err == nil {
		t.Fatalf("accepted: %+v", c)
	}
}

func TestReviewOutputVector(t *testing.T) {
	v := loadReviewVector(t)
	var result struct {
		Review json.RawMessage `json:"review"`
	}
	if err := json.Unmarshal(v.Result, &result); err != nil {
		t.Fatal(err)
	}
	out, err := ParseReviewOutput(result.Review)
	if err != nil || len(out.Findings) != 2 || out.Findings[1].Side == nil || *out.Findings[1].Side != "LEFT" {
		t.Fatalf("vector result refused: %v %+v", err, out)
	}
	// The bounded form of a valid review is the same value.
	bounded, notes, err := BoundReview(result.Review, 50)
	if err != nil || len(notes) != 0 {
		t.Fatalf("bound: %v %v", err, notes)
	}
	var a, b any
	_ = json.Unmarshal(bounded, &a)
	_ = json.Unmarshal(result.Review, &b)
	if fmt.Sprint(a) != fmt.Sprint(b) {
		t.Errorf("bounded %s, vector %s", bounded, result.Review)
	}
	if len(v.InvalidReviews) != 7 {
		t.Fatalf("%d invalid reviews; the vector has 7", len(v.InvalidReviews))
	}
	for i, raw := range v.InvalidReviews {
		t.Run(fmt.Sprintf("invalid/%d", i), func(t *testing.T) {
			if _, err := ParseReviewOutput(raw); !errors.Is(err, ErrReviewInvalid) {
				t.Fatalf("got %v for %s", err, raw)
			}
		})
	}
	if _, err := ParseReviewOutput(nil); !errors.Is(err, ErrReviewMissing) {
		t.Error("absent review isn't missing")
	}
	if _, err := ParseReviewOutput(json.RawMessage("null")); !errors.Is(err, ErrReviewMissing) {
		t.Error("null review isn't missing")
	}
}

func finding(path string, line int, body string) map[string]any {
	return map[string]any{"path": path, "line": line, "severity": "minor", "body": body}
}

func reviewJSON(t *testing.T, summary string, findings ...map[string]any) json.RawMessage {
	t.Helper()
	if findings == nil {
		findings = []map[string]any{}
	}
	b, err := json.Marshal(map[string]any{"version": 1, "summary": summary, "findings": findings})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestBoundReview(t *testing.T) {
	t.Run("caps the count at max_findings", func(t *testing.T) {
		var fs []map[string]any
		for i := range 60 {
			fs = append(fs, finding("a.go", i+1, "x"))
		}
		out, notes, err := BoundReview(reviewJSON(t, "s", fs...), 50)
		if err != nil {
			t.Fatal(err)
		}
		r, err := ParseReviewOutput(out)
		if err != nil || len(r.Findings) != 50 || len(notes) != 1 {
			t.Fatalf("%v %d %v", err, len(r.Findings), notes)
		}
		out, _, _ = BoundReview(reviewJSON(t, "s", fs...), 3)
		if r, _ := ParseReviewOutput(out); len(r.Findings) != 3 {
			t.Errorf("max 3 kept %d", len(r.Findings))
		}
	})
	t.Run("cuts long texts (JavaScript length) and drops invalid findings", func(t *testing.T) {
		long := strings.Repeat("é", 2500) // 2500 UTF-16 units, 5000 bytes
		emoji := strings.Repeat("😀", 150) // 300 UTF-16 units
		f := finding("a.go", 1, long)
		f["title"] = emoji
		out, notes, err := BoundReview(reviewJSON(t, strings.Repeat("s", 5000), f, finding("../x", 1, "b"), finding("b.go", 0, "b"), finding("c.go", 1, "")), 50)
		if err != nil {
			t.Fatal(err)
		}
		r, err := ParseReviewOutput(out)
		if err != nil || len(r.Findings) != 1 || jsLen(r.Findings[0].Body) != 2000 || jsLen(*r.Findings[0].Title) != 200 || jsLen(r.Summary) != 4000 {
			t.Fatalf("%v %+v", err, r)
		}
		if len(notes) != 3 {
			t.Errorf("notes %v", notes)
		}
		for _, n := range notes {
			if strings.Contains(n, "é") || strings.Contains(n, "../x") {
				t.Errorf("a note quotes a value: %q", n)
			}
		}
	})
	t.Run("drops findings from the end to fit 64 KiB", func(t *testing.T) {
		var fs []map[string]any
		for i := range 50 {
			fs = append(fs, finding("a.go", i+1, strings.Repeat("<&>", 666))) // 1998 chars; no HTML escaping
		}
		out, notes, err := BoundReview(reviewJSON(t, "s", fs...), 50)
		if err != nil {
			t.Fatal(err)
		}
		r, err := ParseReviewOutput(out)
		if err != nil || len(out) > ReviewMaxBytes || len(r.Findings) >= 50 || len(r.Findings) < 30 {
			t.Fatalf("%v: %d bytes, %d findings", err, len(out), len(r.Findings))
		}
		if strings.Contains(string(out), "\\u003c") || !strings.Contains(string(out), "<&>") {
			t.Error("HTML-escaped")
		}
		if len(notes) != 1 || !strings.Contains(notes[0], "size limit") {
			t.Errorf("notes %v", notes)
		}
	})
	t.Run("a shape the contract refuses is dropped whole", func(t *testing.T) {
		for _, raw := range []string{
			`{"version":2,"summary":"","findings":[]}`,
			`{"version":1,"summary":"x","findings":[],"verdict":"approve"}`,
			`{"version":1,"summary":"x","findings":[{"path":"a","line":1,"severity":"info","body":"x","suggestion":"y"}]}`,
			`{"version":1,"summary":"x","findings":[{"path":"a","line":"1","severity":"info","body":"x"}]}`,
			`{"version":1,"summary":"x","findings":[{"path":"a","line":1,"side":null,"severity":"info","body":"x"}]}`,
			`{"version":1,"summary":"x"}`,
			`[1]`,
			`"text"`,
		} {
			if out, _, err := BoundReview(json.RawMessage(raw), 50); !errors.Is(err, ErrReviewInvalid) {
				t.Errorf("%s: %v %s", raw, err, out)
			}
		}
		if _, _, err := BoundReview(nil, 50); !errors.Is(err, ErrReviewMissing) {
			t.Error("absent isn't missing")
		}
	})
}

func TestValidReviewPath(t *testing.T) {
	for _, bad := range []string{"", "/abs", "a//b", "a/./b", "a/../b", `a\b`, "a\x07b", "a\x7fb", strings.Repeat("x", 1025)} {
		if ValidReviewPath(bad) {
			t.Errorf("accepted %q", bad)
		}
	}
	for _, good := range []string{"a.ts", "src/deep/file.go", ".github/workflows/ci.yml", "dir/..hidden", strings.Repeat("x", 1024)} {
		if !ValidReviewPath(good) {
			t.Errorf("refused %q", good)
		}
	}
}
