package vectors

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVectorsMatchChecksums fails when a vector file drifts from the checked-in SHA256SUMS. The
// files are a contract: change them only by re-copying the platform's files byte for byte and
// regenerating SHA256SUMS (`shasum -a 256 config-disk.json hpke.json signatures.json`).
func TestVectorsMatchChecksums(t *testing.T) {
	sums, err := os.ReadFile(filepath.Join(Dir(), "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(sums), "\n"), "\n")
	if len(lines) != len(Files) {
		t.Fatalf("SHA256SUMS lists %d files, want %d", len(lines), len(Files))
	}
	for i, line := range lines {
		want, name, ok := strings.Cut(line, "  ")
		if !ok || name != Files[i] {
			t.Fatalf("SHA256SUMS line %d = %q, want <sha256>  %s", i+1, line, Files[i])
		}
		b, err := os.ReadFile(filepath.Join(Dir(), name))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(b)
		if got := hex.EncodeToString(sum[:]); got != want {
			t.Errorf("%s: sha256 %s, SHA256SUMS says %s (vectors drifted from the contract)", name, got, want)
		}
	}
	entries, err := os.ReadDir(Dir())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(Files)+1 {
		t.Errorf("testdata/job-host-v1 holds %d entries, want the %d vectors and SHA256SUMS", len(entries), len(Files))
	}
}

// TestVectorsMatchPlatform compares the copies with the platform's files byte for byte when
// KETE_PLATFORM_VECTORS points at kete-code-platform's docs/contracts/test-vectors/job-host-v1
// (a local cross-repo check; CI has only this repository).
func TestVectorsMatchPlatform(t *testing.T) {
	dir := os.Getenv("KETE_PLATFORM_VECTORS")
	if dir == "" {
		t.Skip("KETE_PLATFORM_VECTORS not set")
	}
	for _, name := range Files {
		ours, err1 := os.ReadFile(filepath.Join(Dir(), name))
		theirs, err2 := os.ReadFile(filepath.Join(dir, name))
		if err1 != nil || err2 != nil {
			t.Fatal(err1, err2)
		}
		if !bytes.Equal(ours, theirs) {
			t.Errorf("%s differs from the platform's copy", name)
		}
	}
}
