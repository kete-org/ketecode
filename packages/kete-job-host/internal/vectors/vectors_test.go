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
// v2: `shasum -a 256 hpke.json messages.json orchestration.json signatures.json` in testdata/job-host-v2.
func TestVectorsMatchChecksums(t *testing.T) {
	checkSums(t, Dir(), Files)
	checkSums(t, DirV2(), FilesV2)
}

func checkSums(t *testing.T, dir string, files []string) {
	t.Helper()
	sums, err := os.ReadFile(filepath.Join(dir, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(sums), "\n"), "\n")
	if len(lines) != len(files) {
		t.Fatalf("%s/SHA256SUMS lists %d files, want %d", dir, len(lines), len(files))
	}
	for i, line := range lines {
		want, name, ok := strings.Cut(line, "  ")
		if !ok || name != files[i] {
			t.Fatalf("SHA256SUMS line %d = %q, want <sha256>  %s", i+1, line, files[i])
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(b)
		if got := hex.EncodeToString(sum[:]); got != want {
			t.Errorf("%s: sha256 %s, SHA256SUMS says %s (vectors drifted from the contract)", name, got, want)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(files)+1 {
		t.Errorf("%s holds %d entries, want the %d vectors and SHA256SUMS", dir, len(entries), len(files))
	}
}

// TestVectorsMatchPlatform compares the copies with the platform's files byte for byte when
// KETE_PLATFORM_VECTORS points at kete-code-platform's docs/contracts/test-vectors/job-host-v1
// (a local cross-repo check; CI has only this repository). The v2 copies are compared with its
// sibling job-host-v2 directory.
func TestVectorsMatchPlatform(t *testing.T) {
	dir := os.Getenv("KETE_PLATFORM_VECTORS")
	if dir == "" {
		t.Skip("KETE_PLATFORM_VECTORS not set")
	}
	compare(t, Dir(), dir, Files)
	compare(t, DirV2(), filepath.Join(dir, "..", "job-host-v2"), FilesV2)
}

func compare(t *testing.T, oursDir, theirsDir string, files []string) {
	t.Helper()
	for _, name := range files {
		ours, err1 := os.ReadFile(filepath.Join(oursDir, name))
		theirs, err2 := os.ReadFile(filepath.Join(theirsDir, name))
		if err1 != nil || err2 != nil {
			t.Fatal(err1, err2)
		}
		if !bytes.Equal(ours, theirs) {
			t.Errorf("%s differs from the platform's copy", name)
		}
	}
}
