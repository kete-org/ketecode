package keys

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

func TestSaveLoad(t *testing.T) {
	dir := filepath.Join(testroot.Dir(t), "keys")
	k, err := Generate(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := Save(dir, k); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"", signingFile, sealingFile} {
		fi, err := os.Stat(filepath.Join(dir, f))
		want := os.FileMode(0o600)
		if f == "" {
			want = 0o700
		}
		if err != nil || fi.Mode().Perm() != want {
			t.Fatalf("%s: %v %v", f, fi.Mode(), err)
		}
	}
	l, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if l.Fingerprint() != k.Fingerprint() || !Exists(dir) {
		t.Fatal("round trip")
	}
}

func TestLoadRefusals(t *testing.T) {
	setup := func(t *testing.T) string {
		dir := filepath.Join(testroot.Dir(t), "keys")
		k, _ := Generate(rand.Reader)
		if err := Save(dir, k); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	t.Run("group-readable file", func(t *testing.T) {
		dir := setup(t)
		_ = os.Chmod(filepath.Join(dir, signingFile), 0o640)
		if _, err := Load(dir); err == nil {
			t.Fatal("loaded")
		}
	})
	t.Run("world-readable dir", func(t *testing.T) {
		dir := setup(t)
		_ = os.Chmod(dir, 0o755)
		if _, err := Load(dir); err == nil {
			t.Fatal("loaded")
		}
	})
	t.Run("symlinked key", func(t *testing.T) {
		dir := setup(t)
		other := filepath.Join(testroot.Dir(t), "x")
		_ = os.WriteFile(other, make([]byte, 32), 0o600)
		_ = os.Remove(filepath.Join(dir, signingFile))
		_ = os.Symlink(other, filepath.Join(dir, signingFile))
		if _, err := Load(dir); err == nil {
			t.Fatal("loaded")
		}
	})
	t.Run("short key", func(t *testing.T) {
		dir := setup(t)
		_ = os.WriteFile(filepath.Join(dir, sealingFile), make([]byte, 31), 0o600)
		if _, err := Load(dir); err == nil {
			t.Fatal("loaded")
		}
	})
	t.Run("not owned by root", func(t *testing.T) {
		dir := setup(t)
		_ = os.Chown(filepath.Join(dir, signingFile), 1000, 1000)
		if _, err := Load(dir); err == nil {
			t.Fatal("loaded")
		}
	})
}

func TestStaged(t *testing.T) {
	dir := filepath.Join(testroot.Dir(t), "keys")
	old, _ := Generate(rand.Reader)
	if err := Save(dir, old); err != nil {
		t.Fatal(err)
	}
	k, _ := Generate(rand.Reader)
	if err := SaveStaged(dir, k); err != nil || !Staged(dir) {
		t.Fatal(err)
	}
	if l, _ := Load(dir); l.Fingerprint() != old.Fingerprint() {
		t.Fatal("staged keys in use before commit")
	}
	if err := DiscardStaged(dir); err != nil || Staged(dir) {
		t.Fatal(err)
	}
	if l, _ := Load(dir); l.Fingerprint() != old.Fingerprint() {
		t.Fatal("discard touched the current keys")
	}
	if err := CommitStaged(dir); err == nil {
		t.Fatal("committed nothing")
	}
	_ = SaveStaged(dir, k)
	if err := CommitStaged(dir); err != nil || Staged(dir) {
		t.Fatal(err)
	}
	if l, _ := Load(dir); l.Fingerprint() != k.Fingerprint() {
		t.Fatal("commit didn't install the new keys")
	}
}
