//go:build linux

package setup

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func needRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root (chown); runs in the golang container")
	}
}

func flyDir(t *testing.T, withSocket bool) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), ".fly")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if withSocket {
		ln, err := net.Listen("unix", filepath.Join(dir, "api"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { ln.Close() })
		if err := os.Chmod(filepath.Join(dir, "api"), 0o666); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestLockFlyAbsent(t *testing.T) {
	missing := filepath.Join(t.TempDir(), ".fly")
	if err := LockFly(missing, false); err != nil {
		t.Errorf("off Fly, no directory: %v", err)
	}
	if err := LockFly(missing, true); !errors.Is(err, ErrFlyAPIMissing) {
		t.Errorf("on Fly, no directory: %v", err)
	}
}

func TestLockFlyLocks(t *testing.T) {
	needRoot(t)
	for _, onFly := range []bool{true, false} {
		dir := flyDir(t, true)
		if err := LockFly(dir, onFly); err != nil {
			t.Fatalf("onFly=%v: %v", onFly, err)
		}
		var st syscall.Stat_t
		if err := syscall.Lstat(dir, &st); err != nil || st.Uid != 0 || st.Gid != 0 || st.Mode&0o7777 != 0o700 {
			t.Errorf("dir mode %o uid %d (%v)", st.Mode&0o7777, st.Uid, err)
		}
		if err := syscall.Lstat(filepath.Join(dir, "api"), &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFSOCK || st.Mode&0o7777 != 0o600 {
			t.Errorf("socket mode %o (%v)", st.Mode&0o7777, err)
		}
	}
}

// A Fly directory without the API socket means the socket is somewhere else: fail closed, even
// when Fly's variables are missing (the directory itself says this is Fly).
func TestLockFlyMissingSocket(t *testing.T) {
	needRoot(t)
	for _, onFly := range []bool{true, false} {
		if err := LockFly(flyDir(t, false), onFly); !errors.Is(err, ErrFlyAPIMissing) {
			t.Errorf("onFly=%v: %v", onFly, err)
		}
	}
}

func TestLockFlyRefusesOddTypes(t *testing.T) {
	needRoot(t)
	base := t.TempDir()
	file := filepath.Join(base, "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := LockFly(file, true); err == nil || errors.Is(err, ErrFlyAPIMissing) {
		t.Errorf("a file: %v", err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(flyDir(t, true), link); err != nil {
		t.Fatal(err)
	}
	if err := LockFly(link, true); err == nil {
		t.Error("a symlinked directory was accepted")
	}
	dir := flyDir(t, false)
	if err := os.WriteFile(filepath.Join(dir, "api"), nil, 0o666); err != nil {
		t.Fatal(err)
	}
	if err := LockFly(dir, true); err == nil || errors.Is(err, ErrFlyAPIMissing) {
		t.Errorf("api is a regular file: %v", err)
	}
	dir = flyDir(t, false)
	if err := os.Symlink("/run/elsewhere.sock", filepath.Join(dir, "api")); err != nil {
		t.Fatal(err)
	}
	if err := LockFly(dir, true); err == nil || errors.Is(err, ErrFlyAPIMissing) {
		t.Errorf("api is a symlink: %v", err)
	}
}

// TestFlyPresent: the read-only presence check: no directory or no socket is ErrFlyAPIMissing, a
// file in either place is an error, a directory with its socket passes; nothing is changed.
func TestFlyPresent(t *testing.T) {
	d := filepath.Join(t.TempDir(), ".fly")
	if err := FlyPresent(d); !errors.Is(err, ErrFlyAPIMissing) {
		t.Errorf("no directory: %v", err)
	}
	if err := os.WriteFile(d, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := FlyPresent(d); err == nil || errors.Is(err, ErrFlyAPIMissing) {
		t.Errorf("a file: %v", err)
	}
	os.Remove(d)
	if err := os.Mkdir(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := FlyPresent(d); !errors.Is(err, ErrFlyAPIMissing) {
		t.Errorf("no socket: %v", err)
	}
	api := filepath.Join(d, "api")
	if err := os.WriteFile(api, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := FlyPresent(d); err == nil || errors.Is(err, ErrFlyAPIMissing) {
		t.Errorf("a file for the socket: %v", err)
	}
	os.Remove(api)
	ln, err := net.Listen("unix", api)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := FlyPresent(d); err != nil {
		t.Errorf("directory and socket: %v", err)
	}
	if fi, err := os.Stat(d); err != nil || fi.Mode().Perm() != 0o755 {
		t.Errorf("the directory changed: %v %v", fi.Mode(), err)
	}
}
