package state

import (
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// The publishing state and its record (job-host-v2) round-trip, and inconsistent records are refused.
func TestPublishRecord(t *testing.T) {
	now := time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC)
	base := State{Version: Version, Machines: []Machine{}}
	m := Machine{MachineID: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", JobID: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", Deadline: now, AcceptedAt: now, Since: now,
		State: contract.StatePublishing, WantsPublish: true, PublishBranch: "kete/job/0a1b2c3d", PublishStarted: true}
	ok := func(mm Machine) error { s := base; s.Machines = []Machine{mm}; _, err := Encode(s); return err }
	if err := ok(m); err != nil {
		t.Fatal(err)
	}
	done := m
	done.State, done.Reason = contract.StateDestroyed, contract.ReasonExited
	done.Publish = &contract.PublishOutcome{Status: contract.PublishCreated, Branch: "kete/job/0a1b2c3d"}
	s := base
	s.Machines = []Machine{done}
	b, err := Encode(s)
	if err != nil {
		t.Fatal(err)
	}
	back, err := Decode(b)
	if err != nil || back.Machines[0].Publish == nil || back.Machines[0].Publish.Status != "created" || !back.Machines[0].WantsPublish {
		t.Fatalf("%+v %v", back, err)
	}
	bad := []Machine{}
	x := m
	x.WantsPublish = false // publishing without a publish request
	bad = append(bad, x)
	x = done
	x.Reason = contract.ReasonDesired // an outcome on a machine destroyed for another reason
	bad = append(bad, x)
	x = done
	x.Publish = &contract.PublishOutcome{Status: "refused"} // no reason
	bad = append(bad, x)
	x = m
	x.PublishBranch = "main"
	bad = append(bad, x)
	for i, mm := range bad {
		if ok(mm) == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}
