package fsutil

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

func TestPrivateDirAndFiles(t *testing.T) {
	base := testroot.Dir(t)
	dir := filepath.Join(base, "state", "keys")
	if err := EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "f")
	if err := WritePrivate(p, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	b, err := ReadPrivate(p, 16)
	if err != nil || string(b) != "secret" {
		t.Fatalf("%q %v", b, err)
	}
	if _, err := ReadPrivate(p, 3); err == nil {
		t.Fatal("over the limit accepted")
	}
}

func TestRefusals(t *testing.T) {
	base := testroot.Dir(t)
	dir := filepath.Join(base, "d")
	if err := EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "f")
	if err := WritePrivate(p, []byte("x")); err != nil {
		t.Fatal(err)
	}
	t.Run("file not owned by root", func(t *testing.T) {
		_ = os.Chown(p, 1000, 1000)
		defer os.Chown(p, 0, 0)
		if _, err := ReadPrivate(p, 8); err == nil || !strings.Contains(err.Error(), "root") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("dir not owned by root", func(t *testing.T) {
		_ = os.Chown(dir, 1000, 1000)
		defer os.Chown(dir, 0, 0)
		if err := CheckPrivate(dir, true); err == nil {
			t.Fatal("accepted")
		}
	})
	t.Run("group-readable file", func(t *testing.T) {
		_ = os.Chmod(p, 0o640)
		defer os.Chmod(p, 0o600)
		if _, err := ReadPrivate(p, 8); err == nil {
			t.Fatal("accepted")
		}
	})
	t.Run("symlink", func(t *testing.T) {
		l := filepath.Join(dir, "link")
		_ = os.Symlink(p, l)
		if _, err := ReadPrivate(l, 8); err == nil || !strings.Contains(err.Error(), "symlink") {
			t.Fatalf("%v", err)
		}
	})
	t.Run("world-writable ancestor", func(t *testing.T) {
		_ = os.Chmod(base, 0o777)
		defer os.Chmod(base, 0o700)
		if err := CheckPrivate(dir, true); err == nil || !strings.Contains(err.Error(), "ancestor") {
			t.Fatalf("%v", err)
		}
		if err := EnsurePrivateDir(filepath.Join(base, "other")); err == nil {
			t.Fatal("created under a world-writable ancestor")
		}
	})
	t.Run("ancestor owned by another user", func(t *testing.T) {
		_ = os.Chown(base, 1000, 1000)
		defer os.Chown(base, 0, 0)
		if _, err := ReadPrivate(p, 8); err == nil {
			t.Fatal("accepted")
		}
	})
	t.Run("symlinked ancestor", func(t *testing.T) {
		l := filepath.Join(base, "dlink")
		_ = os.Symlink(dir, l)
		if _, err := ReadPrivate(filepath.Join(l, "f"), 8); err == nil {
			t.Fatal("accepted")
		}
	})
	t.Run("relative", func(t *testing.T) {
		if err := EnsurePrivateDir("rel/dir"); err == nil {
			t.Fatal("accepted")
		}
	})
}

func TestOpenRootFile(t *testing.T) {
	base := testroot.Dir(t)
	_ = os.Chmod(base, 0o755)
	p := filepath.Join(base, "config.json")
	_ = os.WriteFile(p, []byte("{}"), 0o644)
	f, err := OpenRootFile(p)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	_ = os.Chmod(p, 0o664)
	if _, err := OpenRootFile(p); err == nil {
		t.Fatal("group-writable config accepted")
	}
	_ = os.Chmod(p, 0o644)
	_ = os.Chown(p, 1000, 1000)
	if _, err := OpenRootFile(p); err == nil {
		t.Fatal("non-root config accepted")
	}
	_ = os.Chown(p, 0, 0)
	l := filepath.Join(base, "link.json")
	_ = os.Symlink(p, l)
	if _, err := OpenRootFile(l); err == nil {
		t.Fatal("symlinked config accepted")
	}
}
