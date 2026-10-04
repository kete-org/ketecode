package dedicated

import (
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

func TestCgroupLimits(t *testing.T) {
	got, err := CgroupLimits(contract.Resources{VCPUs: 4, MemoryMiB: 4096, ScratchGiB: 20}, 32768)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"cpu.max": "400000 100000", "memory.max": "4294967296", "memory.swap.max": "0", "pids.max": "32768"}
	if len(got) != len(want) {
		t.Fatalf("%+v", got)
	}
	for _, f := range got {
		if want[f.Name] != f.Value {
			t.Errorf("%s = %q, want %q", f.Name, f.Value, want[f.Name])
		}
	}
	for name, r := range map[string]contract.Resources{
		"no cpu":     {VCPUs: 0, MemoryMiB: 4096, ScratchGiB: 1},
		"tiny mem":   {VCPUs: 1, MemoryMiB: 64, ScratchGiB: 1},
		"no scratch": {VCPUs: 1, MemoryMiB: 512, ScratchGiB: 0},
	} {
		if _, err := CgroupLimits(r, 32768); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := CgroupLimits(contract.Resources{VCPUs: 1, MemoryMiB: 512, ScratchGiB: 1}, 10); err == nil {
		t.Error("tiny pids_max accepted")
	}
}

func TestInitSpecValidate(t *testing.T) {
	ok := InitSpec{Root: "/var/lib/kete-job-host/dedicated/x/root", IPBin: "/usr/sbin/ip", Address: "10.200.0.2/30", Gateway: "10.200.0.1", Resolvers: []string{"1.1.1.1"}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, edit := range map[string]func(*InitSpec){
		"relative root":   func(s *InitSpec) { s.Root = "root" },
		"slash root":      func(s *InitSpec) { s.Root = "/" },
		"unclean root":    func(s *InitSpec) { s.Root = "/a/../b" },
		"not ip":          func(s *InitSpec) { s.IPBin = "/bin/sh" },
		"wide address":    func(s *InitSpec) { s.Address = "10.200.0.2/24" },
		"v6 address":      func(s *InitSpec) { s.Address = "fd00::2/126" },
		"gateway outside": func(s *InitSpec) { s.Gateway = "10.200.0.9" },
		"gateway is us":   func(s *InitSpec) { s.Gateway = "10.200.0.2" },
		"no resolver":     func(s *InitSpec) { s.Resolvers = nil },
		"bad resolver":    func(s *InitSpec) { s.Resolvers = []string{"one.one"} },
		"three resolvers": func(s *InitSpec) { s.Resolvers = []string{"1.1.1.1", "8.8.8.8", "9.9.9.9"} },
	} {
		s := ok
		s.Resolvers = append([]string(nil), ok.Resolvers...)
		edit(&s)
		if err := s.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if !strings.HasPrefix(ProfileEnv, "KETE_JOB_HOST_PROFILE=") {
		t.Fatal(ProfileEnv)
	}
}
