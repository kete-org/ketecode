package agent_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

// TestKillerRunsWhileReconcileFails: the deadline killer starts before reconcile and keeps
// working while the driver can't list its machines; reconcile retries, and polling starts only
// once it succeeds.
func TestKillerRunsWhileReconcileFails(t *testing.T) {
	h := newHarness(t)
	h.active()
	must(t, h.plat.Assign(h.hostID, h.run(m1, j1, 10*time.Minute), machineConfig(j1)))
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")

	h.drv.SetFailList(true)
	h.newAgent() // restart
	requests := len(h.plat.Requests())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.a.Run(ctx) }()
	h.clock.Advance(16 * time.Minute)
	if !eventually(t, 5*time.Second, func() bool {
		s, r, _ := h.machine(m1)
		return s == contract.StateDestroyed && r == contract.ReasonDeadline
	}) {
		t.Fatalf("killer didn't run while reconcile failed; logs:\n%s", h.logs.String())
	}
	if _, ok := h.drv.Get(m1); ok {
		t.Fatal("overdue machine still in the driver")
	}
	if len(h.plat.Requests()) != requests {
		t.Fatal("polled before reconcile succeeded")
	}
	h.drv.SetFailList(false)
	if !eventually(t, 5*time.Second, func() bool { return len(h.plat.Requests()) > requests }) {
		t.Fatalf("never polled after reconcile recovered; logs:\n%s", h.logs.String())
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("run: %v", err)
	}
}

// TestHangingDriver: a driver call that hangs on one machine is cut off by its timeout and holds
// up neither the deadline killer for the other machines nor the agent's state.
func TestHangingDriver(t *testing.T) {
	h := newHarness(t)
	h.active()
	must(t, h.plat.Assign(h.hostID, h.run(m1, j1, 10*time.Minute), machineConfig(j1)))
	must(t, h.plat.Assign(h.hostID, h.run(m2, j2, 10*time.Minute), machineConfig(j2)))
	h.poll(agent.OutcomeApplied)
	h.drv.SetHang(m1, true)
	h.clock.Advance(16 * time.Minute)

	start := time.Now()
	h.a.Supervise(context.Background())
	if d := time.Since(start); d > driverTimeout/3 {
		t.Fatalf("Supervise blocked for %v", d)
	}
	if !eventually(t, driverTimeout/2, func() bool { s, _, _ := h.machine(m2); return s == contract.StateDestroyed }) {
		t.Fatal("the hung machine held up the killer for the other one")
	}
	start = time.Now()
	_ = h.a.Snapshot() // the table lock isn't held across the hung call
	if d := time.Since(start); d > driverTimeout/3 {
		t.Fatalf("Snapshot blocked for %v", d)
	}
	h.wantMachine(m1, contract.StateStopping, "")
	h.a.Wait() // the hung Stop times out
	h.wantMachine(m1, contract.StateStopping, "")
	h.drv.SetHang(m1, false)
	h.supervise()
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonDeadline)
	h.wantMachine(m2, contract.StateDestroyed, contract.ReasonDeadline)
}

// TestHangingStart: a Start that never returns is cut off and fails the machine (driver_failed).
func TestHangingStart(t *testing.T) {
	h := newHarness(t)
	h.active()
	h.drv.SetHang(m1, true)
	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied) // waits for the timed-out Start and the (timed-out) cleanup Stop
	h.wantMachine(m1, contract.StateFailed, contract.ReasonDriverFailed)
	h.drv.SetHang(m1, false)
	h.supervise() // the cleanup Stop is retried
}

// TestHaltedAtStartupDestroysAll: a durable halt found at start destroys every machine, then the
// agent exits halted.
func TestHaltedAtStartupDestroysAll(t *testing.T) {
	h := newHarness(t)
	h.active()
	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")
	st, err := state.Load(state.Path(h.cfg.StateDir))
	if err != nil {
		t.Fatal(err)
	}
	st.Halted = state.HaltRevoked
	must(t, state.Save(state.Path(h.cfg.StateDir), st))
	h.newAgent()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := h.a.Run(ctx); !errors.Is(err, agent.ErrHalted) {
		t.Fatalf("run: %v", err)
	}
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonHostDisabled)
	if _, ok := h.drv.Get(m1); ok {
		t.Fatal("machine still in the driver")
	}
}
