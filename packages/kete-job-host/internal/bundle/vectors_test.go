package bundle

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The vectors in testdata/bundle-v1 are the platform validator's own answers (generate.ts runs
// kete-code-platform's validateBundle on Node over every bundle); the Go port must give the same
// reason, or accept with the same entries. No known divergence: every case passes. Unicode
// tables can differ between Node's ICU and golang.org/x/text for code points assigned after
// x/text's Unicode version; no case uses such a code point.

func vectorsDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "testdata", "bundle-v1")
}

type vectorEntry struct {
	Path    string `json:"path"`
	Deleted bool   `json:"deleted"`
	Mode    string `json:"mode"`
	BlobSHA string `json:"blob_sha"`
	Binary  bool   `json:"binary"`
	Inline  bool   `json:"inline"`
}

type vectorCase struct {
	Name   string `json:"name"`
	Bundle string `json:"bundle_b64"`
	Expect struct {
		OK      bool          `json:"ok"`
		Reason  string        `json:"reason"`
		Entries []vectorEntry `json:"entries"`
	} `json:"expect"`
}

func TestVectorsChecksums(t *testing.T) {
	sums, err := os.ReadFile(filepath.Join(vectorsDir(), "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(sums)), "\n")
	if len(lines) != 3 {
		t.Fatalf("SHA256SUMS lists %d files, want bundles.json, generate.sh, generate.ts", len(lines))
	}
	for _, l := range lines {
		want, name, ok := strings.Cut(l, "  ")
		if !ok {
			t.Fatalf("bad line %q", l)
		}
		b, err := os.ReadFile(filepath.Join(vectorsDir(), name))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(b)
		if hex.EncodeToString(sum[:]) != want {
			t.Errorf("%s: SHA-256 mismatch (regenerate with generate.sh, never edit by hand)", name)
		}
	}
}

func TestVectors(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(vectorsDir(), "bundles.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		PlatformCommit string       `json:"platform_commit"`
		Cases          []vectorCase `json:"cases"`
	}
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 200 {
		t.Fatalf("only %d cases", len(file.Cases))
	}
	reasons := map[string]bool{}
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			raw, err := base64.StdEncoding.DecodeString(c.Bundle)
			if err != nil {
				t.Fatal(err)
			}
			entries, ref := Validate(raw)
			if !c.Expect.OK {
				reasons[c.Expect.Reason] = true
				if ref == nil {
					t.Fatalf("accepted, the platform refuses %s", c.Expect.Reason)
				}
				if ref.Reason != c.Expect.Reason {
					t.Fatalf("refused %s, the platform refuses %s", ref.Reason, c.Expect.Reason)
				}
				return
			}
			if ref != nil {
				t.Fatalf("refused %s, the platform accepts", ref.Reason)
			}
			if len(entries) != len(c.Expect.Entries) {
				t.Fatalf("%d entries, want %d", len(entries), len(c.Expect.Entries))
			}
			for i, w := range c.Expect.Entries {
				g := entries[i]
				got := vectorEntry{Path: g.Path, Deleted: g.Deleted}
				if !g.Deleted {
					got.Mode, got.BlobSHA, got.Binary, got.Inline = g.Mode, g.BlobSHA, g.Binary, g.Inline
				}
				if got != w {
					t.Fatalf("entry %d: %+v, want %+v", i, got, w)
				}
			}
		})
	}
	// Every refusal code but bundle_too_large (TestBundleTooLarge) appears in the vectors.
	for _, r := range []string{"bad_gzip", "decompressed_too_large", "multi_member_gzip", "trailing_data", "truncated", "bad_header", "bad_checksum",
		"base256_size", "entry_type", "pax_global", "pax_key", "sparse", "bad_extension", "double_extension", "dangling_extension", "gnu_long_link",
		"manifest_not_first", "manifest_too_large", "manifest_invalid", "too_many_entries", "duplicate_path", "invalid_path", "protected_path",
		"ci_path", "case_collision", "ancestor_conflict", "outside_files", "unlisted_file", "deleted_with_entry", "duplicate_entry", "missing_file",
		"file_too_large", "binary_too_large", "too_many_binaries", "secret_shape"} {
		if !reasons[r] {
			t.Errorf("no vector refuses %s", r)
		}
	}
}

// bundle_too_large is checked before anything is read: not stored in the vectors (10 MB).
func TestBundleTooLarge(t *testing.T) {
	big := make([]byte, MaxCompressed+1)
	if _, r := Validate(big); r == nil || r.Reason != "bundle_too_large" {
		t.Fatalf("got %v", r)
	}
	// At the cap it is parsed (and refused for what it is, not its size).
	if _, r := Validate(big[:MaxCompressed]); r == nil || r.Reason != "bad_gzip" {
		t.Fatalf("got %v", r)
	}
}

func TestFold(t *testing.T) {
	for in, want := range map[string]string{
		".GIT":               ".git",
		".git. . ":           ".git",
		".g\u200cit":         ".git",
		"\ufeff.git":         ".git",
		"Stra\u00dfe":        "strasse",
		"\u212a":             "k",
		"\u0391\u03a3":       "\u03b1\u03c2", // final sigma, as JavaScript's toLowerCase
		"\u0391\u03a3\u0391": "\u03b1\u03c3\u03b1",
		"\u0130":             "i\u0307",
		"\ufb00":             "ff",
		"...":                "",
		"a\u200b":            "a\u200b", // ZWSP is not HFS-ignorable
		"Kete.JSONC":         "kete.jsonc",
		"\u0149":             "\u02bcn",
	} {
		if got := Fold(in); got != want {
			t.Errorf("Fold(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestShortName(t *testing.T) {
	for in, want := range map[string]bool{
		"git~1": true, "gi7eba~1": true, "a~1.txt": true, "a~12.tx": true, "abcdef~9": true,
		"abcdefg~1": false, "~1": false, "a~": false, "a~1.": true, "a~1.abcd": false, "a~1.a.b": false, "a.b~1": false, "a~1x": false,
		"\U0001F600\U0001F600\U0001F600~1": true, "\U0001F600\U0001F600\U0001F600\U0001F600~1": false,
	} {
		if got := isShortName(in); got != want {
			t.Errorf("isShortName(%q) = %v", in, got)
		}
	}
}

func TestSecretShapeBoundaries(t *testing.T) {
	r := strings.Repeat
	for in, want := range map[string]string{
		"sk-" + r("a", 20):        "openai_or_anthropic_key",
		"xsk-" + r("a", 20):       "",
		"-sk-" + r("a", 20):       "",
		"_sk-" + r("a", 20):       "",
		".sk-" + r("a", 20):       "openai_or_anthropic_key",
		"sk-" + r("a", 19):        "",
		"AKIA" + r("A", 16):       "aws_access_key",
		"AKIA" + r("A", 17):       "",
		"AKIA" + r("A", 16) + "a": "aws_access_key",
		"AKIA" + r("A", 15):       "",
		"eyJ" + r("a", 10) + ".eyJ" + r("b", 10) + "." + r("c", 10): "jwt",
		"eyJ" + r("a", 10) + ".eyJ" + r("b", 10) + "." + r("c", 9):  "",
		"-----BEGIN RSA PRIVATE KEY-----":                           "private_key",
		"-----BEGIN rsa PRIVATE KEY-----":                           "",
		"\xff\x00glpat-" + r("z", 20):                               "gitlab_token",
		"AIza" + r("_", 35):                                         "google_api_key",
		"kete_test_" + r("-", 20):                                   "kete_key",
		"github_pat_" + r("_", 22):                                  "github_pat",
	} {
		if got := FindSecretShape([]byte(in)); got != want {
			t.Errorf("FindSecretShape(%q) = %q, want %q", in, got, want)
		}
	}
}

// A bundle built with Go's archive/tar in the entrypoint's format validates (the entrypoint's
// writer and this reader agree).
func TestStdlibTarAccepted(t *testing.T) {
	var tarBuf bytes.Buffer
	tw := newTestTar(&tarBuf)
	tw.add("manifest.json", []byte(`[{"path":"a.txt","mode":"100644"}]`))
	tw.add("files/a.txt", []byte("hello\n"))
	tw.close()
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(tarBuf.Bytes())
	_ = zw.Close()
	entries, r := Validate(gz.Bytes())
	if r != nil || len(entries) != 1 || entries[0].BlobSHA != "ce013625030ba8dba906f756967f9e9ca394464a" {
		t.Fatalf("%+v %v", entries, r)
	}
}
