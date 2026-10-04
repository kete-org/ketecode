//go:build linux

package hostprofile

import (
	"os"
	"path/filepath"
	"testing"
)

func tree(t *testing.T) (string, Paths) {
	t.Helper()
	d := t.TempDir()
	for _, sub := range []string{"virtio", "dmi", "block", "dev"} {
		if err := os.MkdirAll(filepath.Join(d, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return d, Paths{
		FlyDir: filepath.Join(d, ".fly"), InitBin: "/usr/local/libexec/kete/kete-job-init", Proc1Exe: filepath.Join(d, "exe"),
		VirtioDir: filepath.Join(d, "virtio"), DMIDir: filepath.Join(d, "dmi"), SysBlockDir: filepath.Join(d, "block"), DevDir: filepath.Join(d, "dev"),
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGather(t *testing.T) {
	d, p := tree(t)
	s, err := Gather(p, Signals{Source: SourcePipe, Provider: "gcp"})
	if err != nil {
		t.Fatal(err)
	}
	if s.FlyDir || s.Init || s.Vsock || s.DMI != "" || s.Source != SourcePipe || s.Provider != "gcp" {
		t.Errorf("empty tree: %+v", s)
	}
	if err := os.Symlink(p.InitBin, p.Proc1Exe); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(p.FlyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(d, "virtio", "virtio0", "device"), "0x0002\n")
	write(t, filepath.Join(d, "virtio", "virtio1", "device"), "0x0013\n")
	write(t, filepath.Join(d, "dmi", "product_name"), "Google Compute Engine\n")
	s, err = Gather(p, Signals{})
	if err != nil {
		t.Fatal(err)
	}
	if !s.FlyDir || !s.Init || !s.Vsock || s.DMI != "gcp" {
		t.Errorf("full tree: %+v", s)
	}
	// A different PID 1 isn't kete-job-init; a virtio device without an id fails (never a default).
	os.Remove(p.Proc1Exe)
	if err := os.Symlink("/sbin/init", p.Proc1Exe); err != nil {
		t.Fatal(err)
	}
	if s, err := Gather(p, Signals{}); err != nil || s.Init {
		t.Errorf("other init: %+v %v", s, err)
	}
	if err := os.Mkdir(filepath.Join(d, "virtio", "virtio2"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Gather(p, Signals{}); err == nil {
		t.Error("unreadable virtio id accepted")
	}
}

func TestFindConfigDisk(t *testing.T) {
	d, p := tree(t)
	if got, err := FindConfigDisk(p.SysBlockDir, p.DevDir); err != nil || got != "" {
		t.Fatalf("no devices: %q %v", got, err)
	}
	// vda: an ordinary disk; vdb: empty (size 0, skipped even with the header); vdc: the config disk.
	write(t, filepath.Join(d, "block", "vda", "size"), "2048\n")
	write(t, filepath.Join(d, "dev", "vda"), "\x7fELF not a config disk at all")
	write(t, filepath.Join(d, "block", "vdb", "size"), "0\n")
	write(t, filepath.Join(d, "dev", "vdb"), ConfigDiskHeader+"{}")
	if got, err := FindConfigDisk(p.SysBlockDir, p.DevDir); err != nil || got != "" {
		t.Fatalf("no config disk: %q %v", got, err)
	}
	write(t, filepath.Join(d, "block", "vdc", "size"), "8\n")
	write(t, filepath.Join(d, "dev", "vdc"), ConfigDiskHeader+`{"job_id":"x"}`)
	got, err := FindConfigDisk(p.SysBlockDir, p.DevDir)
	if err != nil || got != filepath.Join(p.DevDir, "vdc") {
		t.Fatalf("config disk: %q %v", got, err)
	}
	devs, err := BlockDevices(p.SysBlockDir, p.DevDir)
	if err != nil || len(devs) != 2 {
		t.Errorf("block devices: %v %v", devs, err)
	}
	// A short device (shorter than the header) and a missing node are not config disks.
	write(t, filepath.Join(d, "block", "vdd", "size"), "8\n")
	write(t, filepath.Join(d, "dev", "vdd"), "kete")
	write(t, filepath.Join(d, "block", "vde", "size"), "8\n")
	if _, err := OpenConfigDisk(filepath.Join(p.DevDir, "vdd")); err != ErrNotConfigDisk {
		t.Errorf("short: %v", err)
	}
	if _, err := OpenConfigDisk(filepath.Join(p.DevDir, "vde")); err != ErrNotConfigDisk {
		t.Errorf("missing: %v", err)
	}
	// A symlinked node is refused, not followed.
	if err := os.Symlink(filepath.Join(p.DevDir, "vdc"), filepath.Join(p.DevDir, "vdf")); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenConfigDisk(filepath.Join(p.DevDir, "vdf")); err == nil || err == ErrNotConfigDisk {
		t.Errorf("symlink: %v", err)
	}
}
