package state

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

func TestSaveLoad(t *testing.T) {
	dir := filepath.Join(testroot.Dir(t), "s")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p := Path(dir)
	s, err := Load(p)
	if err != nil || s.Enrolled() || s.Version != Version {
		t.Fatalf("missing file: %+v %v", s, err)
	}
	now := time.Now().UTC()
	rev := int64(3)
	s = State{
		Version: Version, HostID: "7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f", Fingerprint: "03f1356980aee51f136861f517a1567f238d6c8b35980c394e33b0e0caf4bf6a",
		Generation: "g-1", AppliedRevision: &rev, GenerationSpentBy: "3f6b9d2a-8c41-4e7f-b5a0-9d1c2e3f4a5b",
		Machines: []Machine{{MachineID: "3f6b9d2a-8c41-4e7f-b5a0-9d1c2e3f4a5b", JobID: "9b2e4f60-1a3c-4d5e-8f70-6b8c0d2e4f61", State: "stopping", StopReason: "desired", Since: now, AcceptedAt: now, Deadline: now}},
	}
	if err := Save(p, s); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
	l, err := Load(p)
	if err != nil || l.HostID != s.HostID || *l.AppliedRevision != 3 || l.Machines[0].StopReason != "desired" || l.GenerationSpentBy != s.GenerationSpentBy {
		t.Fatalf("%+v %v", l, err)
	}
}

func TestValidateRefusals(t *testing.T) {
	m := Machine{MachineID: "3f6b9d2a-8c41-4e7f-b5a0-9d1c2e3f4a5b", State: "running"}
	for name, s := range map[string]State{
		"version":          {Version: 2},
		"bad host":         {Version: 1, HostID: "x", Generation: "g", Fingerprint: "03f1356980aee51f136861f517a1567f238d6c8b35980c394e33b0e0caf4bf6a"},
		"halt":             {Version: 1, Halted: "maybe"},
		"spent unenrolled": {Version: 1, GenerationSpentBy: m.MachineID},
		"spent by junk": {Version: 1, HostID: "7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f", Generation: "g", GenerationSpentBy: "x",
			Fingerprint: "03f1356980aee51f136861f517a1567f238d6c8b35980c394e33b0e0caf4bf6a"},
		"duplicate":       {Version: 1, Machines: []Machine{m, m}},
		"failed reason":   {Version: 1, Machines: []Machine{{MachineID: m.MachineID, State: "failed", Reason: "exited"}}},
		"destroyed none":  {Version: 1, Machines: []Machine{{MachineID: m.MachineID, State: "destroyed"}}},
		"live reason":     {Version: 1, Machines: []Machine{{MachineID: m.MachineID, State: "running", Reason: "exited"}}},
		"stopping reason": {Version: 1, Machines: []Machine{{MachineID: m.MachineID, State: "stopping"}}},
		"unknown state":   {Version: 1, Machines: []Machine{{MachineID: m.MachineID, State: "paused"}}},
	} {
		if s.Validate() == nil {
			t.Errorf("%s: valid", name)
		}
	}
}

func TestLoadRefusesLoosePermissions(t *testing.T) {
	dir := filepath.Join(testroot.Dir(t), "s")
	_ = os.Mkdir(dir, 0o700)
	p := Path(dir)
	if err := Save(p, State{Version: Version}); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(p, 0o644)
	if _, err := Load(p); err == nil {
		t.Fatal("loaded a world-readable state file")
	}
	_ = os.Chmod(p, 0o600)
	_ = os.WriteFile(p, []byte(`{"version":1,"machines":[],"applied_revision":null,"extra":1}`), 0o600)
	if _, err := Load(p); err == nil {
		t.Fatal("loaded an unknown field")
	}
}
