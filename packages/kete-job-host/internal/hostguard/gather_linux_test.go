//go:build linux

package hostguard

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func tree(t *testing.T, environ string, markers []string, user, pid uint64) Paths {
	t.Helper()
	d := t.TempDir()
	if err := os.WriteFile(filepath.Join(d, "environ"), []byte(environ), 0o644); err != nil {
		t.Fatal(err)
	}
	p := Paths{Proc1Env: filepath.Join(d, "environ")}
	for _, m := range MarkerFiles {
		p.MarkerFiles = append(p.MarkerFiles, filepath.Join(d, m))
	}
	for _, m := range markers {
		f := filepath.Join(d, m)
		if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p.NSInode = func(name string) (uint64, error) {
		if name == "user" {
			return user, nil
		}
		return pid, nil
	}
	return p
}

func TestGather(t *testing.T) {
	if err := Run(tree(t, "PATH=/bin\x00", nil, InitUserNSIno, InitPIDNSIno)); err != nil {
		t.Errorf("host: %v", err)
	}
	for name, p := range map[string]Paths{
		"docker":        tree(t, "PATH=/bin\x00", []string{".dockerenv"}, InitUserNSIno, 0xF0000001),
		"podman marker": tree(t, "", []string{"run/.containerenv"}, InitUserNSIno, InitPIDNSIno),
		"systemd":       tree(t, "", []string{"run/systemd/container"}, InitUserNSIno, InitPIDNSIno),
		"host manager":  tree(t, "", []string{"run/host/container-manager"}, InitUserNSIno, InitPIDNSIno),
		"environ":       tree(t, "container=podman\x00", nil, InitUserNSIno, InitPIDNSIno),
		"pid ns":        tree(t, "", nil, InitUserNSIno, 0xF0000001),
	} {
		if err := Run(p); !errors.Is(err, ErrContainer) {
			t.Errorf("%s: %v", name, err)
		}
	}
	p := tree(t, "", nil, InitUserNSIno, InitPIDNSIno)
	os.Remove(p.Proc1Env)
	if err := Run(p); !errors.Is(err, ErrContainer) {
		t.Errorf("unreadable environ: %v", err)
	}
	// The real reader: nsfs files pass the magic check; a regular file doesn't.
	if _, err := os.Stat("/proc/self/ns/pid"); err == nil {
		if _, err := NSInode("/proc/self/ns/pid"); err != nil {
			t.Errorf("nsfs: %v", err)
		}
		if _, err := NSInode(p.Proc1Env + "x"); err == nil {
			t.Error("a missing file accepted")
		}
		f := filepath.Join(t.TempDir(), "pid")
		_ = os.WriteFile(f, nil, 0o644)
		if _, err := NSInode(f); err == nil {
			t.Error("a regular file accepted as a namespace")
		}
	}
}
