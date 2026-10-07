//go:build linux

package hostprofile

import (
	"errors"
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

// kernelTree is a machine for GatherKernel: PID 1's argv, the mount table, marker files, and the
// namespaces' inode numbers.
func kernelTree(t *testing.T, args, mountinfo string, markers []string, user, pid uint64) KernelPaths {
	t.Helper()
	d := t.TempDir()
	write(t, filepath.Join(d, "cmdline"), args)
	write(t, filepath.Join(d, "mountinfo"), mountinfo)
	p := KernelPaths{Proc1Cmdline: filepath.Join(d, "cmdline"), MountInfo: filepath.Join(d, "mountinfo")}
	for _, m := range []string{".dockerenv", "run/.containerenv"} {
		p.MarkerFiles = append(p.MarkerFiles, filepath.Join(d, m))
	}
	for _, m := range markers {
		write(t, filepath.Join(d, m), "")
	}
	p.NSInode = func(name string) (uint64, error) {
		switch name {
		case "user":
			return user, nil
		case "pid":
			return pid, nil
		}
		return 0, errors.New("no such namespace")
	}
	return p
}

// TestGatherKernel: the four machines of kernel_test.go read from files, through the same rules.
func TestGatherKernel(t *testing.T) {
	const other = 0xF0000123
	cases := []struct {
		name            string
		p               KernelPaths
		vm, dedicated   bool
		mount           string
		marker, pid1Set bool
	}{
		{"privileged docker", kernelTree(t, "bash\x00scripts/integration.sh\x00", mountsDocker, []string{".dockerenv"}, InitUserNSIno, other), false, false, "/etc/resolv.conf", true, true},
		{"capability pod", kernelTree(t, "/pause\x00", mountsPod, nil, InitUserNSIno, other), false, false, "/etc/hosts", false, true},
		{"podman", kernelTree(t, "/usr/local/libexec/kete/kete-job-entrypoint\x00", "1 0 0:1 / / rw - overlay overlay rw\n", []string{"run/.containerenv"}, InitUserNSIno, other), false, false, "", true, true},
		{"rootless container", kernelTree(t, "/proc/self/exe\x00"+DedicatedInitArg+"\x00", mountsDedicated, nil, other, other), false, false, "", false, true},
		{"dedicated", kernelTree(t, "/proc/self/exe\x00"+DedicatedInitArg+"\x00", mountsDedicated, nil, InitUserNSIno, other), false, true, "", false, true},
		{"vm", kernelTree(t, "/usr/local/libexec/kete/kete-job-init\x00__guest\x00", mountsVM, nil, InitUserNSIno, InitPIDNSIno), true, false, "", false, true},
	}
	for _, c := range cases {
		k, err := GatherKernel(c.p)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if OwnKernel(k) != c.vm || DedicatedReaper(k) != c.dedicated || k.RuntimeMount != c.mount || k.MarkerFile != c.marker || (len(k.PID1Args) > 0) != c.pid1Set {
			t.Errorf("%s: %+v", c.name, k)
		}
	}
	// PID 1's argv unreadable (gone, or another's under hidepid) is no argv, never an error.
	p := kernelTree(t, "", mountsDedicated, nil, InitUserNSIno, other)
	os.Remove(p.Proc1Cmdline)
	if k, err := GatherKernel(p); err != nil || k.PID1Args != nil || DedicatedReaper(k) {
		t.Errorf("no cmdline: %+v %v", k, err)
	}
	// A namespace or the mount table that can't be read fails (the caller refuses).
	p = kernelTree(t, "", mountsDedicated, nil, InitUserNSIno, other)
	p.NSInode = func(string) (uint64, error) { return 0, os.ErrPermission }
	if _, err := GatherKernel(p); err == nil {
		t.Error("unreadable namespace accepted")
	}
	p = kernelTree(t, "", mountsDedicated, nil, InitUserNSIno, other)
	os.Remove(p.MountInfo)
	if _, err := GatherKernel(p); err == nil {
		t.Error("missing mount table accepted")
	}
	// The real reader: stat of /proc/self/ns/<name> gives nsfs inode numbers (this test process is
	// never in a namespace whose number is below the dynamic range, other than the initial ones).
	if _, err := os.Stat("/proc/self/ns/pid"); err == nil {
		k, err := GatherKernel(KernelPaths{NSDir: "/proc/self/ns", Proc1Cmdline: "/proc/1/cmdline", MountInfo: "/proc/self/mountinfo"})
		if err != nil {
			t.Fatalf("real machine: %v", err)
		}
		t.Logf("this machine: %+v", k)
		if DedicatedReaper(k) {
			t.Error("a test process passes as the dedicated reaper's job")
		}
	}
}
