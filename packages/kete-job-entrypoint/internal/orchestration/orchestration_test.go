package orchestration

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// vectorDir holds the orchestrations-v1 vectors, copied byte for byte from kete-code-platform
// docs/contracts/test-vectors/orchestrations-v1/ (one copy for the Go and the TypeScript tests;
// SHA256SUMS beside them catches drift: `shasum -a 256 bundles.json dag.json messages.json
// naming.json plan-files.json`).
var vectorDir = filepath.Join("..", "..", "..", "..", "docs", "platform", "test-vectors", "orchestrations-v1")

var vectorFiles = []string{"bundles.json", "dag.json", "messages.json", "naming.json", "plan-files.json"}

func load(t *testing.T, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(vectorDir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatal(err)
	}
}

func TestVectorChecksums(t *testing.T) {
	sums, err := os.ReadFile(filepath.Join(vectorDir, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	var want strings.Builder
	for _, name := range vectorFiles {
		data, err := os.ReadFile(filepath.Join(vectorDir, name))
		if err != nil {
			t.Fatal(err)
		}
		want.WriteString(SHA256Hex(data) + "  " + name + "\n")
	}
	if string(sums) != want.String() {
		t.Errorf("SHA256SUMS = %q, want %q (a vector drifted from the platform's copy)", sums, want.String())
	}
	entries, err := os.ReadDir(vectorDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(vectorFiles)+1 {
		t.Errorf("%s holds %d entries, want the %d vectors and SHA256SUMS", vectorDir, len(entries), len(vectorFiles))
	}
}

// TestVectorsMatchPlatform compares the copies with the platform's when
// KETE_PLATFORM_ORCHESTRATION_VECTORS points at kete-code-platform's
// docs/contracts/test-vectors/orchestrations-v1 (a local cross-repo check; CI has one repository).
func TestVectorsMatchPlatform(t *testing.T) {
	dir := os.Getenv("KETE_PLATFORM_ORCHESTRATION_VECTORS")
	if dir == "" {
		t.Skip("KETE_PLATFORM_ORCHESTRATION_VECTORS not set")
	}
	for _, name := range vectorFiles {
		ours, err1 := os.ReadFile(filepath.Join(vectorDir, name))
		theirs, err2 := os.ReadFile(filepath.Join(dir, name))
		if err1 != nil || err2 != nil {
			t.Fatal(err1, err2)
		}
		if !bytes.Equal(ours, theirs) {
			t.Errorf("%s differs from the platform's copy", name)
		}
	}
}

type planFileCase struct {
	Name         string          `json:"name"`
	Text         *string         `json:"text"`
	Base64       *string         `json:"base64"`
	Valid        bool            `json:"valid"`
	Reason       string          `json:"reason"`
	ProposalSend json.RawMessage `json:"proposal_send"`
	ProposalOmit json.RawMessage `json:"proposal_omit"`
}

func (c planFileCase) bytes(t *testing.T) []byte {
	t.Helper()
	switch {
	case c.Text != nil:
		return []byte(*c.Text)
	case c.Base64 != nil:
		b, err := base64.StdEncoding.DecodeString(*c.Base64)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	t.Fatalf("%s: neither text nor base64", c.Name)
	return nil
}

type planFiles struct {
	Files []planFileCase `json:"files"`
	Reads []struct {
		Name   string `json:"name"`
		Expect struct {
			OrchestrationID string `json:"orchestration_id"`
			Rev             int64  `json:"rev"`
			Key             string `json:"key"`
			PromptDigest    string `json:"prompt_digest"`
		} `json:"expect"`
		File   string `json:"file"`
		Result struct {
			OK     bool   `json:"ok"`
			Prompt string `json:"prompt"`
			Reason string `json:"reason"`
		} `json:"result"`
	} `json:"reads"`
}

// sameJSON compares two JSON documents as parsed values (member order is irrelevant).
func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(x, y)
}

func TestPlanFiles(t *testing.T) {
	var v planFiles
	load(t, "plan-files.json", &v)
	if len(v.Files) != 38 || len(v.Reads) != 5 {
		t.Fatalf("%d files and %d reads; the contract has 38 and 5", len(v.Files), len(v.Reads))
	}
	for _, c := range v.Files {
		t.Run(c.Name, func(t *testing.T) {
			data := c.bytes(t)
			p, reason := ParsePlanFile(data)
			if c.Valid != (p != nil) {
				t.Fatalf("valid = %v (reason %q), want %v", p != nil, reason, c.Valid)
			}
			if !c.Valid {
				if string(reason) != c.Reason {
					t.Errorf("reason %q, want %q", reason, c.Reason)
				}
				return
			}
			for _, tc := range []struct {
				titles Titles
				want   json.RawMessage
			}{{TitlesSend, c.ProposalSend}, {TitlesOmit, c.ProposalOmit}} {
				prop, r := PlanProposal(data, tc.titles)
				if prop == nil {
					t.Fatalf("proposal refused: %s", r)
				}
				got, err := json.Marshal(prop)
				if err != nil {
					t.Fatal(err)
				}
				if !sameJSON(t, got, tc.want) {
					t.Errorf("proposal (titles %s) = %s, want %s", tc.titles, got, tc.want)
				}
			}
		})
	}
	byName := map[string]planFileCase{}
	for _, c := range v.Files {
		byName[c.Name] = c
	}
	for _, r := range v.Reads {
		t.Run("read/"+r.Name, func(t *testing.T) {
			f, ok := byName[r.File]
			if !ok {
				t.Fatalf("no file %q", r.File)
			}
			prompt, reason := ReadNodePrompt(f.bytes(t), PromptExpectation{
				OrchestrationID: r.Expect.OrchestrationID, Rev: r.Expect.Rev, Key: r.Expect.Key, PromptDigest: r.Expect.PromptDigest,
			})
			if r.Result.OK {
				if reason != "" || prompt != r.Result.Prompt {
					t.Errorf("got %q (%s), want the prompt", prompt, reason)
				}
				return
			}
			if string(reason) != r.Result.Reason {
				t.Errorf("reason %q, want %q", reason, r.Result.Reason)
			}
		})
	}
}

func TestBundles(t *testing.T) {
	var v struct {
		Cases []struct {
			Name    string `json:"name"`
			Kind    string `json:"kind"`
			Entries []struct {
				Path    string `json:"path"`
				Deleted bool   `json:"deleted"`
				Mode    string `json:"mode"`
				Size    int64  `json:"size"`
			} `json:"entries"`
			Refusal *string `json:"refusal"`
		} `json:"cases"`
	}
	load(t, "bundles.json", &v)
	if len(v.Cases) != 19 {
		t.Fatalf("%d cases; the contract has 19", len(v.Cases))
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var entries []BundleEntry
			for _, e := range c.Entries {
				entries = append(entries, BundleEntry{Path: e.Path, Deleted: e.Deleted, Mode: e.Mode, Size: e.Size})
			}
			got := CheckBundle(entries, BundleKind(c.Kind))
			want := ""
			if c.Refusal != nil {
				want = *c.Refusal
			}
			if string(got) != want {
				t.Errorf("refusal %q, want %q", got, want)
			}
		})
	}
}

func TestFoldComponentSpecialCasing(t *testing.T) {
	// JavaScript's toUpperCase maps U+FB06 (st ligature) to "ST", so the platform folds this
	// component to `.kete-orchestration`; the Go side must refuse it too.
	if got := FoldComponent(".kete-orcheﬆration"); got != ".kete-orchestration" {
		t.Errorf("fold = %q", got)
	}
	if got := FoldComponent(".KETE-orcheſtration.. "); got != ".kete-orchestration" {
		t.Errorf("fold = %q", got)
	}
}

func TestNaming(t *testing.T) {
	var v struct {
		Branches []struct {
			OrchestrationID string `json:"orchestration_id"`
			PlanRev         *int64 `json:"plan_rev"`
			NodeKey         string `json:"node_key"`
			Branch          string `json:"branch"`
		} `json:"branches"`
		CommitMessages []struct {
			Name  string `json:"name"`
			Input struct {
				JobID           string `json:"jobId"`
				CIEnabled       bool   `json:"ciEnabled"`
				OrchestrationID string `json:"orchestrationId"`
				Key             string `json:"key"`
				Attempt         int    `json:"attempt"`
				Note            string `json:"note"`
			} `json:"input"`
			Message string `json:"message"`
		} `json:"commit_messages"`
	}
	load(t, "naming.json", &v)
	if len(v.Branches) == 0 || len(v.CommitMessages) == 0 {
		t.Fatal("no cases")
	}
	for _, b := range v.Branches {
		got := ""
		if b.PlanRev != nil {
			got = PlanBranch(b.OrchestrationID, *b.PlanRev)
		} else {
			got = NodeBranch(b.OrchestrationID, b.NodeKey)
		}
		if got != b.Branch {
			t.Errorf("branch %q, want %q", got, b.Branch)
		}
	}
	for _, c := range v.CommitMessages {
		t.Run(c.Name, func(t *testing.T) {
			in := c.Input
			got := NodeCommitMessage(NodeCommit{JobID: in.JobID, CIEnabled: in.CIEnabled, OrchestrationID: in.OrchestrationID, Key: in.Key, Attempt: in.Attempt, Note: in.Note})
			if got != c.Message {
				t.Errorf("message\n%q\nwant\n%q", got, c.Message)
			}
		})
	}
}

func TestValidators(t *testing.T) {
	for _, k := range []string{"a", "sdk-core", "a234567890123456789012345678901b"} {
		if !ValidNodeKey(k) {
			t.Errorf("%q refused", k)
		}
	}
	for _, k := range []string{"", "plan", "plan-1", "A", "1a", "a_b", "a2345678901234567890123456789012c"} {
		if ValidNodeKey(k) {
			t.Errorf("%q accepted", k)
		}
	}
}

// TestPlanFileAdditions: kete-code's additions to the plan-file vectors
// (docs/test-vectors/orchestrations-v1-additions/plan-files.json, read by the TypeScript tests too).
func TestPlanFileAdditions(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "test-vectors", "orchestrations-v1-additions", "plan-files.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v planFiles
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Files) < 6 {
		t.Fatalf("%d cases", len(v.Files))
	}
	for _, c := range v.Files {
		t.Run(c.Name, func(t *testing.T) {
			p, reason := ParsePlanFile(c.bytes(t))
			if c.Valid != (p != nil) || !c.Valid && string(reason) != c.Reason {
				t.Errorf("valid %v reason %q, want %v %q", p != nil, reason, c.Valid, c.Reason)
			}
		})
	}
}

// TestPlanJSONDepth: a deeply nested document is refused without deep recursion.
func TestPlanJSONDepth(t *testing.T) {
	deep := strings.Repeat("[", 100000) + strings.Repeat("]", 100000)
	if _, r := ParsePlanFile([]byte(deep)); r != RefuseNotJSON {
		t.Errorf("200 KB of brackets: %s", r)
	}
	deep = strings.Repeat("[", 9) + strings.Repeat("]", 9)
	if _, r := ParsePlanFile([]byte(deep)); r != RefuseNotJSON {
		t.Errorf("nine levels: %s", r)
	}
}
