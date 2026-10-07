package platform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

func readJobsVector(t *testing.T, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "fakeplatform", "testdata", "jobs-v1", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatal(err)
	}
}

type runtimeClaimVector struct {
	Request        ClaimRequest    `json:"request"`
	Response       json.RawMessage `json:"response"`
	RefusedWithout [][]string      `json:"refused_without"`
	Finish         struct {
		Method        string          `json:"method"`
		Path          string          `json:"path"`
		Authorization string          `json:"authorization"`
		Body          json.RawMessage `json:"body"`
		Status        int             `json:"status"`
	} `json:"finish"`
	KubeVM struct {
		LocalRepositoryName string `json:"local_repository_name"`
		Refusals            []struct {
			Name     string          `json:"name"`
			Response json.RawMessage `json:"response"`
		} `json:"refusals"`
	} `json:"kubevm"`
}

// TestRuntimeClaimVector: claim-runtime-repo.json (copied byte for byte from the platform). Our
// runtime claim request is the vector's; the response passes the fail-closed check for the
// runner's name and every kubevm refusal is refused; the finish body is `{"outbox":true}`.
func TestRuntimeClaimVector(t *testing.T) {
	var v runtimeClaimVector
	readJobsVector(t, "claim-runtime-repo.json", &v)

	ours, _ := json.Marshal(ClaimRequest{ClaimToken: v.Request.ClaimToken, Features: RuntimeClaimFeatures})
	theirs, _ := json.Marshal(v.Request)
	if string(ours) != string(theirs) {
		t.Errorf("claim request %s, vector %s", ours, theirs)
	}
	// The platform refuses a runtime claim without both runtime features: each refused set lacks
	// one, and ours has both.
	both := func(fs []string) bool {
		return slices.Contains(fs, FeatureRuntimeRepo) && slices.Contains(fs, FeatureRuntimePublish)
	}
	if !both(RuntimeClaimFeatures) {
		t.Error("RuntimeClaimFeatures lacks a runtime feature")
	}
	for _, fs := range v.RefusedWithout {
		if both(fs) {
			t.Errorf("refused_without %v has both features", fs)
		}
	}

	c, err := ParseRuntimeClaimResponse(v.Response, v.KubeVM.LocalRepositoryName)
	if err != nil {
		t.Fatalf("vector response refused: %v", err)
	}
	if c.Repository.Name != "gitlab:payments/api" || c.Spec.Branch != "kete/job/5d2e8a41" || c.Spec.Policy.Timeout != 30 ||
		c.PlatformURL != "https://portal.kete.example" || len(c.Clone) != 0 || len(c.SpecRaw) == 0 {
		t.Errorf("parsed %+v", c)
	}

	if len(v.KubeVM.Refusals) != 5 {
		t.Fatalf("%d kubevm refusals, the contract has 5", len(v.KubeVM.Refusals))
	}
	for _, r := range v.KubeVM.Refusals {
		t.Run(r.Name, func(t *testing.T) {
			if c, err := ParseRuntimeClaimResponse(r.Response, v.KubeVM.LocalRepositoryName); err == nil || c != nil {
				t.Fatalf("accepted: %+v", c)
			} else {
				t.Log(err)
			}
		})
	}

	f := v.Finish
	if f.Method != "POST" || f.Path != "/api/v1/jobs/{id}/finish" || f.Authorization != "Bearer <callback_token>" || f.Status != 202 {
		t.Errorf("finish %+v", f)
	}
	var want, got any
	body, _ := json.Marshal(NewRuntimeFinishRequest())
	_ = json.Unmarshal(f.Body, &want)
	_ = json.Unmarshal(body, &got)
	if !reflect.DeepEqual(want, got) || string(body) != `{"outbox":true}` {
		t.Errorf("finish body %s, vector %s", body, f.Body)
	}
}

// TestRuntimeClaimRefusals: further shapes the fail-closed check refuses (each a single change to
// the vector's response), and what it tolerates (an unknown top-level field).
func TestRuntimeClaimRefusals(t *testing.T) {
	var v runtimeClaimVector
	readJobsVector(t, "claim-runtime-repo.json", &v)
	name := v.KubeVM.LocalRepositoryName
	mutate := func(f func(m map[string]any)) []byte {
		var m map[string]any
		if err := json.Unmarshal(v.Response, &m); err != nil {
			t.Fatal(err)
		}
		f(m)
		b, _ := json.Marshal(m)
		return b
	}
	spec := func(m map[string]any) map[string]any { return m["spec"].(map[string]any) }
	for label, body := range map[string][]byte{
		"clone null":         mutate(func(m map[string]any) { m["clone"] = nil }),
		"clone empty object": mutate(func(m map[string]any) { m["clone"] = map[string]any{} }),
		"no repository":      mutate(func(m map[string]any) { delete(m, "repository") }),
		"repository null":    mutate(func(m map[string]any) { m["repository"] = nil }),
		"name with ..": mutate(func(m map[string]any) {
			m["repository"] = map[string]any{"provider": "runtime", "name": "gitlab:payments/../api"}
		}),
		"name with empty seg": mutate(func(m map[string]any) {
			m["repository"] = map[string]any{"provider": "runtime", "name": "gitlab:payments//api"}
		}),
		"name scp-like": mutate(func(m map[string]any) {
			m["repository"] = map[string]any{"provider": "runtime", "name": "git@gitlab.corp:payments/api"}
		}),
		"spec unknown field":    mutate(func(m map[string]any) { spec(m)["prompt_file"] = "x" }),
		"spec version 2":        mutate(func(m map[string]any) { spec(m)["version"] = 2 }),
		"spec blank prompt":     mutate(func(m map[string]any) { spec(m)["prompt"] = " \u00a0\ufeff\n" }),
		"spec model whitespace": mutate(func(m map[string]any) { spec(m)["model"] = "kete/a\u2003b" }),
		"spec branch":           mutate(func(m map[string]any) { spec(m)["branch"] = "main" }),
		"spec timeout fraction": mutate(func(m map[string]any) { spec(m)["policy"].(map[string]any)["timeout"] = 1.5 }),
		"spec timeout too long": mutate(func(m map[string]any) { spec(m)["policy"].(map[string]any)["timeout"] = 121 }),
		"spec budget zero":      mutate(func(m map[string]any) { spec(m)["policy"].(map[string]any)["budget"] = 0 }),
		"spec allow extra field": mutate(func(m map[string]any) {
			spec(m)["policy"].(map[string]any)["allow"] = []any{map[string]any{"action": "a", "resource": "b", "x": 1}}
		}),
		"gateway_key space":    mutate(func(m map[string]any) { m["gateway_key"] = "a b" }),
		"callback_token upper": mutate(func(m map[string]any) { m["callback_token"] = strings.ToUpper(m["callback_token"].(string)) }),
		"gateway_url http":     mutate(func(m map[string]any) { m["gateway_url"] = "http://gateway.kete.example" }),
		"gateway_url ..":       mutate(func(m map[string]any) { m["gateway_url"] = "https://gateway.kete.example/a/../b" }),
		"platform_url path":    mutate(func(m map[string]any) { m["platform_url"] = "https://portal.kete.example/x" }),
		"deadline no offset":   mutate(func(m map[string]any) { m["deadline"] = "2026-10-07T10:40:00" }),
		"deadline no seconds":  mutate(func(m map[string]any) { m["deadline"] = "2026-10-07T10:40Z" }),
		"deadline bad date":    mutate(func(m map[string]any) { m["deadline"] = "2026-02-30T10:40:00Z" }),
		"trailing data":        append(append([]byte{}, v.Response...), []byte(" {}")...),
	} {
		if _, err := ParseRuntimeClaimResponse(body, name); err == nil {
			t.Errorf("%s accepted", label)
		}
	}
	if _, err := ParseRuntimeClaimResponse(mutate(func(m map[string]any) { m["future_field"] = 1 }), name); err != nil {
		t.Errorf("an unknown top-level field refused: %v", err)
	}
	if _, err := ParseRuntimeClaimResponse(mutate(func(m map[string]any) { m["deadline"] = "2026-10-07T12:40:00.5+02:00" }), name); err != nil {
		t.Errorf("an offset deadline refused: %v", err)
	}
	// The v1 claim path never accepts a runtime response: it has no clone.
	if c, err := ParseClaim(v.Response); err == nil {
		if cl, _ := c.Validate("https://portal.kete.example", "storage.kete.example", testTime(t, "2026-10-07T10:00:00Z")); cl != nil {
			t.Error("the v1 claim check accepted a runtime response")
		}
	}
}

type boundaryVector struct {
	Input  json.RawMessage `json:"input"`
	Redact string          `json:"redact"`
	Cases  []struct {
		Name     string          `json:"name"`
		Boundary DataBoundary    `json:"boundary"`
		Output   json.RawMessage `json:"output"`
	} `json:"cases"`
}

func asJSONValue(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestResultBoundaryVector: result-boundary.json. The input parses as a JobRuntimeRunResult;
// bounding it under each case's boundary gives the case's output, compared as parsed JSON; and
// bounding the output again changes nothing.
func TestResultBoundaryVector(t *testing.T) {
	var v boundaryVector
	readJobsVector(t, "result-boundary.json", &v)
	in, err := ParseRuntimeRunResult(v.Input)
	if err != nil {
		t.Fatalf("input refused: %v", err)
	}
	if !reflect.DeepEqual(asJSONValue(t, in), asJSONValue(t, v.Input)) {
		t.Fatal("the input doesn't round-trip")
	}
	redact := func(string) string { return v.Redact }
	if len(v.Cases) != 4 {
		t.Fatalf("%d cases, the contract has 4", len(v.Cases))
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if err := c.Boundary.Validate(); err != nil {
				t.Fatal(err)
			}
			got := BoundRunResult(in, c.Boundary, redact)
			if g, w := asJSONValue(t, got), asJSONValue(t, c.Output); !reflect.DeepEqual(g, w) {
				t.Errorf("bounded:\n%v\nwant:\n%v", g, w)
			}
			if err := got.Validate(); err != nil {
				t.Errorf("bounded result invalid: %v", err)
			}
			again := BoundRunResult(got, c.Boundary, redact)
			if !reflect.DeepEqual(asJSONValue(t, again), asJSONValue(t, got)) {
				t.Error("bounding twice changed the result")
			}
			out, err := ParseRuntimeRunResult(c.Output)
			if err != nil {
				t.Fatalf("output refused: %v", err)
			}
			if !reflect.DeepEqual(asJSONValue(t, BoundRunResult(out, c.Boundary, redact)), asJSONValue(t, c.Output)) {
				t.Error("bounding the vector's output changed it")
			}
		})
	}
	// The input is not mutated.
	if !reflect.DeepEqual(asJSONValue(t, in), asJSONValue(t, v.Input)) {
		t.Error("BoundRunResult mutated its input")
	}
}

// TestRuntimeRunResultRules: the fixed-code fields refuse free text; unknown fields are dropped.
func TestRuntimeRunResultRules(t *testing.T) {
	base := `{"version":1,"outcome":"completed","exit_code":0,"denied":[]}`
	if r, err := ParseRuntimeRunResult([]byte(`{"version":1,"outcome":"completed","exit_code":0,"denied":[],"extra":"x"}`)); err != nil {
		t.Errorf("unknown field refused: %v", err)
	} else if b, _ := json.Marshal(r); string(b) != base {
		t.Errorf("re-encoded %s", b)
	}
	for label, body := range map[string]string{
		"free-text outcome": strings.Replace(base, `"completed"`, `"it went fine"`, 1),
		"exit code 256":     strings.Replace(base, `"exit_code":0`, `"exit_code":256`, 1),
		"denial action":     strings.Replace(base, `"denied":[]`, `"denied":[{"action":"Shell rm","resources":[]}]`, 1),
		"denial count 0":    strings.Replace(base, `"denied":[]`, `"denied":[{"action":"shell","resources":[],"count":0}]`, 1),
		"no resources":      strings.Replace(base, `"denied":[]`, `"denied":[{"action":"shell"}]`, 1),
		"no denied":         `{"version":1,"outcome":"completed","exit_code":0}`,
		"session id":        strings.Replace(base, `"denied"`, `"session_id":"a b","denied"`, 1),
		"branch":            strings.Replace(base, `"denied"`, `"branch":"main","denied"`, 1),
		"text null":         strings.Replace(base, `"denied"`, `"text":null,"denied"`, 1),
		"version 2":         strings.Replace(base, `"version":1`, `"version":2`, 1),
	} {
		if _, err := ParseRuntimeRunResult([]byte(body)); err == nil {
			t.Errorf("%s accepted", label)
		}
	}
	// denied_count is kept when present (the platform bounds a bounded result again).
	n := int64(7)
	r := RuntimeRunResult{Version: 1, Outcome: "completed", Denied: []RuntimeDenial{}, DeniedCount: &n}
	if got := BoundRunResult(r, DataBoundary{Summary: "none", Denials: "count", PublishRefs: "omit"}, nil); *got.DeniedCount != 7 {
		t.Errorf("denied_count %d", *got.DeniedCount)
	}
}

func TestDataBoundaryNarrow(t *testing.T) {
	full := DataBoundary{Summary: "full", Denials: "full", PublishRefs: "send"}
	if got := full.Narrow(DefaultDataBoundary); got != DefaultDataBoundary {
		t.Errorf("narrow = %+v", got)
	}
	if got := (DataBoundary{Summary: "redacted", Denials: "count", PublishRefs: "send"}).Narrow(DataBoundary{Summary: "full", Denials: "actions", PublishRefs: "omit"}); got != (DataBoundary{Summary: "redacted", Denials: "count", PublishRefs: "omit"}) {
		t.Errorf("narrow = %+v", got)
	}
	var b DataBoundary
	if err := decodeShape([]byte(`{"summary":"none","denials":"actions","publish_refs":"send","prompts":"full"}`), &b); err == nil {
		t.Error("an unknown boundary setting accepted")
	}
}

func testTime(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return tm
}
