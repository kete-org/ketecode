package firecracker

import (
	"encoding/json"
	"flag"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostnet"
)

var update = flag.Bool("update", false, "rewrite golden files")

func sampleMachine(t *testing.T) machine {
	t.Helper()
	slot, err := hostnet.SlotNet(netip.MustParsePrefix("10.200.0.0/16"), 2)
	if err != nil {
		t.Fatal(err)
	}
	return machine{
		ID: "9b2f6a0e-3c1d-4e5f-8a7b-6c5d4e3f2a1b", UID: 900000002, ExecFile: "/usr/local/bin/firecracker",
		ChrootBase: "/var/lib/kete-job-host/jail", VCPUs: 4, MemoryMiB: 4096, OverheadMiB: 256, ScratchGiB: 20,
		Slot: slot, Resolvers: []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("8.8.8.8")},
		NetMbps: 1000, DiskMBps: 400, DiskIOPS: 10000,
	}
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatalf("%s differs (go test -update):\n%s", path, got)
	}
}

func TestRenderGolden(t *testing.T) {
	m := sampleMachine(t)
	golden(t, "jailer-args.txt", strings.Join(jailerArgs(m), "\n")+"\n")
	vmc, err := renderVMConfig(m)
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "vm-config.json", string(vmc)+"\n")
	golden(t, "boot-args.txt", bootArgs(m)+"\n")
}

// TestRenderedSafety pins the properties ADR 0023 rules 7 and 13 need from the rendered files.
func TestRenderedSafety(t *testing.T) {
	m := sampleMachine(t)
	vmc, _ := renderVMConfig(m)
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(vmc, &doc); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"mmds-config", "vsock", "metrics", "balloon", "entropy"} {
		if _, ok := doc[k]; ok {
			t.Errorf("vm config has %q", k)
		}
	}
	args := strings.Join(jailerArgs(m), " ")
	for _, want := range []string{"--new-pid-ns", "--no-api", "--cgroup-version 2", "--parent-cgroup " + ParentCgroup} {
		if !strings.Contains(args, want) {
			t.Errorf("jailer args lack %q", want)
		}
	}
	if strings.Contains(args, "--no-seccomp") || strings.Contains(args, "--seccomp-filter") || strings.Contains(args, "--daemonize") {
		t.Error("seccomp must stay on its default filters")
	}
	boot := bootArgs(m)
	for _, want := range []string{"panic=1", "init=/usr/local/libexec/kete/kete-job-init", "ip=10.200.0.10::10.200.0.9:255.255.255.252::eth0:off:1.1.1.1:8.8.8.8"} {
		if !strings.Contains(boot, want) {
			t.Errorf("boot args lack %q: %s", want, boot)
		}
	}
	var c vmConfig
	if err := json.Unmarshal(vmc, &c); err != nil {
		t.Fatal(err)
	}
	if !c.Drives[0].IsRootDevice || !c.Drives[0].IsReadOnly || c.Drives[1].IsReadOnly || !c.Drives[2].IsReadOnly {
		t.Errorf("drive modes: %+v", c.Drives)
	}
	if c.NetworkInterfaces[0].RxRateLimiter == nil || c.Drives[0].RateLimiter == nil {
		t.Error("rate limiters missing")
	}
}
