//go:build linux

package firecracker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostnet"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

const vmID = "9b2f6a0e-3c1d-4e5f-8a7b-6c5d4e3f2a1b"

func testDriver(t *testing.T) (*Driver, string) {
	t.Helper()
	root := testroot.Dir(t)
	kernel := filepath.Join(root, "vmlinux")
	if err := os.WriteFile(kernel, []byte("not really a kernel"), 0o444); err != nil {
		t.Fatal(err)
	}
	sum, _ := fileSHA256(kernel)
	f := config.File{
		PlatformURL: "https://portal.kete.example", Driver: contract.DriverFirecracker, Slots: 2, Reset: contract.ResetNone,
		StateDir: filepath.Join(root, "state"), Resolvers: []string{"1.1.1.1"}, KernelAllowlist: []string{sum},
		Firecracker: &config.FirecrackerFile{Kernel: kernel, Uplink: "eth0"},
	}
	f.Versions.Firecracker, f.Versions.GuestKernel = "1.17.0", "6.18.55-kete.1"
	raw, _ := json.Marshal(f)
	cfg, err := config.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	cg := filepath.Join(root, "cgroup")
	d, err := New(Options{Config: cfg, Images: &image.Store{Dir: filepath.Join(root, "images")}, CgroupRoot: cg})
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{d.vmsDir, d.jailBase} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return d, root
}

// TestConfigDiskRoundTrip (AC2): the jail gets exactly seal.ConfigDisk's image of the canonical
// configuration (header, JSON, NUL padding), owned by the jail user 0600; nothing else in the jail
// holds the claim token.
func TestConfigDiskRoundTrip(t *testing.T) {
	d, _ := testDriver(t)
	mc := seal.MachineConfig{
		JobID: "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f", PlatformURL: "https://portal.kete.example",
		ClaimToken: strings.Repeat("ab", 32), StorageHost: "storage.kete.example", HostProfile: seal.ProfileMicroVM,
	}
	cfg, _ := mc.Canonical()
	rootfs := filepath.Join(d.o.Config.StateDir, "rootfs.ext4")
	if err := os.WriteFile(rootfs, []byte("rootfs"), 0o444); err != nil {
		t.Fatal(err)
	}
	jail := d.jailRoot(vmID)
	// Start mounts a tmpfs here (mountConfigFS); a plain directory stands in for it.
	if err := os.MkdirAll(filepath.Join(jail, jailConfigDir), 0o700); err != nil {
		t.Fatal(err)
	}
	m := sampleMachine(t)
	m.ID, m.ScratchGiB = vmID, 1
	if err := d.populateJail(context.Background(), jail, rootfs, m, cfg); err != nil {
		t.Fatal(err)
	}
	disk, err := os.ReadFile(filepath.Join(jail, jailConfig))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := seal.ConfigDisk(cfg)
	if !bytes.Equal(disk, want) || len(disk) != contract.ConfigDiskBytes || !bytes.HasPrefix(disk, []byte(contract.ConfigDiskHeader)) {
		t.Fatal("config disk differs from seal.ConfigDisk")
	}
	body := bytes.TrimRight(disk[len(contract.ConfigDiskHeader):], "\x00")
	back, err := seal.ParseMachineConfig(body)
	if err != nil || back != mc {
		t.Fatalf("round trip: %+v %v", back, err)
	}
	fi, _ := os.Stat(filepath.Join(jail, jailConfig))
	if fi.Mode().Perm() != 0o600 || ownerUID(fi) != m.UID {
		t.Fatalf("config disk mode %v owner %d", fi.Mode(), ownerUID(fi))
	}
	ents, _ := os.ReadDir(jail)
	for _, e := range ents {
		if e.Name() == jailConfigDir || e.Name() == jailScratch {
			continue
		}
		b, _ := os.ReadFile(filepath.Join(jail, e.Name()))
		if bytes.Contains(b, []byte(mc.ClaimToken)) {
			t.Errorf("%s holds the claim token", e.Name())
		}
	}
	sc, _ := os.ReadFile(filepath.Join(jail, jailScratch))
	if len(sc) < 1200 || !bytes.Equal(sc[1024+120:1024+120+len("kete-scratch")], []byte("kete-scratch")) {
		t.Fatal("scratch disk isn't ext4 labelled kete-scratch")
	}
}

func TestKernelNotAllowlisted(t *testing.T) {
	d, root := testDriver(t)
	if err := os.WriteFile(d.fc.Kernel, nil, 0o644); err != nil { // changed after the allowlist
		t.Fatal(err)
	}
	jail := filepath.Join(root, "j")
	_ = os.MkdirAll(filepath.Join(jail, jailConfigDir), 0o711)
	m := sampleMachine(t)
	err := d.populateJail(context.Background(), jail, d.fc.Kernel, m, []byte("{}"))
	if err == nil || !strings.Contains(err.Error(), "kernel_allowlist") {
		t.Fatalf("want a kernel_allowlist refusal, got %v", err)
	}
}

func TestLogsListStop(t *testing.T) {
	d, _ := testDriver(t)
	st, err := d.allocSlot(driver.Spec{MachineID: vmID, JobID: "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f"})
	if err != nil || st.Slot != 0 || st.UID != 900_000_000 {
		t.Fatalf("%+v %v", st, err)
	}
	console := d.consolePath(vmID)
	if err := os.WriteFile(console, []byte("boot noise\r\n{\"step\":\"x\"}\npartial"), 0o600); err != nil {
		t.Fatal(err)
	}
	lines, err := d.Logs(context.Background(), vmID)
	if err != nil || len(lines) != 2 || string(lines[0]) != "boot noise" || string(lines[1]) != `{"step":"x"}` {
		t.Fatalf("%q %v", lines, err)
	}
	f, _ := os.OpenFile(console, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString(" line\n")
	f.Close()
	lines, _ = d.Logs(context.Background(), vmID)
	if len(lines) != 1 || string(lines[0]) != "partial line" {
		t.Fatalf("%q", lines)
	}
	// A restarted driver resumes from the saved offset (no line twice).
	d2, _ := New(d.o)
	if lines, _ := d2.Logs(context.Background(), vmID); len(lines) != 0 {
		t.Fatalf("lines resent: %q", lines)
	}
	if err := os.MkdirAll(d.jailRoot(vmID), 0o700); err != nil {
		t.Fatal(err)
	}
	ids, err := d.List(context.Background())
	if err != nil || len(ids) != 1 || ids[0] != vmID {
		t.Fatalf("list %v %v", ids, err)
	}
	if s, _ := d.Status(context.Background(), vmID); s != driver.StatusCrashed {
		t.Fatalf("status of a never-started VM: %v", s)
	}
	if err := d.Stop(context.Background(), vmID); err != nil {
		t.Fatal(err)
	}
	if err := d.Stop(context.Background(), vmID); err != nil {
		t.Fatalf("stop not idempotent: %v", err)
	}
	if ids, _ := d.List(context.Background()); len(ids) != 0 {
		t.Fatalf("left %v", ids)
	}
	if s, _ := d.Status(context.Background(), vmID); s != driver.StatusGone {
		t.Fatalf("status after stop: %v", s)
	}
	if err := d.Stop(context.Background(), "../../etc"); err == nil {
		t.Fatal("stop accepted a path as a machine id")
	}
}

// fakeTable stands in for hostnet.Nft.
type fakeTable struct{ checkErr error }

func (f *fakeTable) Apply(context.Context, hostnet.Table) (string, error) { return "listing", nil }
func (f *fakeTable) Check(_ context.Context, want string) error {
	if want != "listing" {
		return hostnet.ErrChanged
	}
	return f.checkErr
}

// TestCheckIsolation: a missing or changed table is isolation lost (the agent then destroys every
// machine), and starts stay blocked even if the table comes back, until a restart re-applies it.
func TestCheckIsolation(t *testing.T) {
	d, _ := testDriver(t)
	ft := &fakeTable{}
	d.o.Nft = ft
	if err := d.CheckIsolation(context.Background()); !errors.Is(err, ErrIsolationLost) {
		t.Fatalf("never applied: %v", err)
	}
	d2, _ := testDriver(t)
	d2.o.Nft = ft
	d2.listing, _ = ft.Apply(context.Background(), hostnet.Table{})
	if err := d2.CheckIsolation(context.Background()); err != nil || d2.StartsBlocked() != "" {
		t.Fatalf("intact table: %v %q", err, d2.StartsBlocked())
	}
	for _, e := range []error{hostnet.ErrMissing, hostnet.ErrChanged} {
		ft.checkErr = e
		if err := d2.CheckIsolation(context.Background()); !errors.Is(err, ErrIsolationLost) || !errors.Is(err, e) {
			t.Fatalf("%v: got %v", e, err)
		}
		if d2.StartsBlocked() != contract.BlockedHostTable {
			t.Fatalf("starts not blocked: %q", d2.StartsBlocked())
		}
	}
	ft.checkErr = nil // the table is back, but nobody re-applied it: stay blocked
	d2.check(context.Background())
	if d2.StartsBlocked() != contract.BlockedHostTable {
		t.Fatalf("block cleared without a restart: %q", d2.StartsBlocked())
	}
	if err := d2.Start(context.Background(), driver.Spec{MachineID: vmID}); err == nil {
		t.Fatal("Start ran with isolation lost")
	}
}
