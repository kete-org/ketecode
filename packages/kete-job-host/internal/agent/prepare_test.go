package agent_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/fake"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
)

// prepDriver is the fake driver plus the optional Preparer and Blocker interfaces.
type prepDriver struct {
	*fake.Driver
	prepErr   error
	prepCalls atomic.Int32
	blocked   atomic.Value // string
}

func (p *prepDriver) Prepare(context.Context, string) error {
	p.prepCalls.Add(1)
	return p.prepErr
}

func (p *prepDriver) StartsBlocked() string {
	s, _ := p.blocked.Load().(string)
	return s
}

// gateVerifier blocks every Verify until released, then answers err.
type gateVerifier struct {
	mu      sync.Mutex
	release chan struct{}
	err     error
	calls   atomic.Int32
}

func newGate() *gateVerifier { return &gateVerifier{release: make(chan struct{})} }

func (g *gateVerifier) Verify(ctx context.Context, _ string) error {
	g.calls.Add(1)
	select {
	case <-g.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.err
}

type errVerifier struct{ err error }

func (e errVerifier) Verify(context.Context, string) error { return e.err }

// TestSlowVerifyOffTheLock (AC6): a signature check that hangs holds up neither the agent's polls
// nor other machines, and its machine starts once it returns.
func TestSlowVerifyOffTheLock(t *testing.T) {
	h := newHarness(t)
	g := newGate()
	h.verifier = g
	h.active()
	h.assign(m1, j1)
	done := make(chan agent.Result, 1)
	go func() { done <- h.a.PollOnce(context.Background()) }()
	select {
	case r := <-done:
		if r.Outcome != agent.OutcomeApplied {
			t.Fatalf("poll: %+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("PollOnce waited for the signature check")
	}
	if !eventually(t, 2*time.Second, func() bool { return g.calls.Load() == 1 }) {
		t.Fatal("Verify never called")
	}
	h.wantMachine(m1, contract.StatePreparing, "")
	// Reports keep flowing and Snapshot isn't blocked while Verify hangs.
	if r := h.a.PollOnce(context.Background()); r.Outcome != agent.OutcomeApplied {
		t.Fatalf("second poll: %+v", r)
	}
	if om, ok := reported(h.lastReport(), m1); !ok || om.State != contract.StatePreparing {
		t.Fatalf("report: %+v %v", om, ok)
	}
	close(g.release)
	if !eventually(t, 5*time.Second, func() bool { s, _, _ := h.machine(m1); return s == contract.StateRunning }) {
		h.wantMachine(m1, contract.StateRunning, "")
	}
}

// TestStopWhileVerifying: a machine withdrawn during its signature check is destroyed and never
// started.
func TestStopWhileVerifying(t *testing.T) {
	h := newHarness(t)
	g := newGate()
	h.verifier = g
	h.active()
	h.assign(m1, j1)
	h.a.PollOnce(context.Background())
	if !eventually(t, 2*time.Second, func() bool { return g.calls.Load() == 1 }) {
		t.Fatal("Verify never called")
	}
	h.plat.Withdraw(h.hostID, m1)
	h.a.PollOnce(context.Background())
	// The stop interrupts the hung check: no release needed.
	if !eventually(t, 5*time.Second, func() bool { s, _, _ := h.machine(m1); return s == contract.StateDestroyed }) {
		h.wantMachine(m1, contract.StateDestroyed, contract.ReasonDesired)
	}
	close(g.release)
	h.a.Wait()
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonDesired)
	if h.drv.Starts() != 0 {
		t.Fatal("a withdrawn machine was started")
	}
}

func TestImageUnavailableAndPrepare(t *testing.T) {
	t.Run("signature fetch unavailable", func(t *testing.T) {
		h := newHarness(t)
		h.verifier = errVerifier{err: image.ErrUnavailable}
		h.active()
		h.assign(m1, j1)
		h.poll(agent.OutcomeApplied)
		h.wantMachine(m1, contract.StateFailed, contract.ReasonImageUnavailable)
	})
	t.Run("signature invalid", func(t *testing.T) {
		h := newHarness(t)
		h.verifier = errVerifier{err: errors.Join(image.ErrSignature, errors.New("no"))}
		h.active()
		h.assign(m1, j1)
		h.poll(agent.OutcomeApplied)
		h.wantMachine(m1, contract.StateFailed, contract.ReasonImageSignatureInvalid)
	})
	t.Run("prepare fails", func(t *testing.T) {
		h := newHarness(t)
		pd := &prepDriver{Driver: h.drv, prepErr: errors.New("registry down")}
		h.wrap = pd
		h.active()
		h.assign(m1, j1)
		h.poll(agent.OutcomeApplied)
		h.wantMachine(m1, contract.StateFailed, contract.ReasonImageUnavailable)
		if h.drv.Starts() != 0 {
			t.Fatal("started without a prepared image")
		}
	})
	t.Run("config checked before prepare", func(t *testing.T) {
		h := newHarness(t)
		pd := &prepDriver{Driver: h.drv}
		h.wrap = pd
		h.active()
		c := machineConfig(j1)
		c.PlatformURL = "https://portal.evil.example"
		must(t, h.plat.Assign(h.hostID, h.run(m1, j1, time.Hour), c))
		h.poll(agent.OutcomeApplied)
		h.wantMachine(m1, contract.StateFailed, contract.ReasonPlatformMismatch)
		if pd.prepCalls.Load() != 0 {
			t.Fatal("prepared an image for an invalid configuration")
		}
	})
	t.Run("prepare then start", func(t *testing.T) {
		h := newHarness(t)
		pd := &prepDriver{Driver: h.drv}
		h.wrap = pd
		h.active()
		h.assign(m1, j1)
		h.poll(agent.OutcomeApplied)
		h.wantMachine(m1, contract.StateRunning, "")
		if pd.prepCalls.Load() != 1 {
			t.Fatalf("prepare calls %d", pd.prepCalls.Load())
		}
	})
}

// TestDriverBlocksStarts: a driver's block (the host table missing) is reported and fails new
// assignments with starts_blocked.
func TestDriverBlocksStarts(t *testing.T) {
	h := newHarness(t)
	pd := &prepDriver{Driver: h.drv}
	pd.blocked.Store(contract.BlockedHostTable)
	h.wrap = pd
	h.active()
	if r := h.lastReport(); r.StartsBlocked == nil || *r.StartsBlocked != contract.BlockedHostTable {
		t.Fatalf("report starts_blocked: %v", r.StartsBlocked)
	}
	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateFailed, contract.ReasonStartsBlocked)
	pd.blocked.Store("")
	h.assign(m2, j2)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m2, contract.StateRunning, "")
}

// isoDriver adds a host isolation check to the fake driver.
type isoDriver struct {
	*fake.Driver
	mu  sync.Mutex
	err error
	n   atomic.Int32
}

func (d *isoDriver) CheckIsolation(context.Context) error {
	d.n.Add(1)
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.err
}

func (d *isoDriver) set(err error) {
	d.mu.Lock()
	d.err = err
	d.mu.Unlock()
}

// TestIsolationLostDestroysAll: when the driver reports host isolation lost, every live machine
// is destroyed (host_isolation_lost, with an agent phase line), the report says starts are
// blocked (host_table), and new assignments fail until the agent restarts — even if the check
// passes again.
func TestIsolationLostDestroysAll(t *testing.T) {
	h := newHarness(t)
	iso := &isoDriver{Driver: h.drv}
	h.wrap = iso
	h.active()
	h.assign(m1, j1)
	h.assign(m2, j2)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")
	if err := h.a.CheckIsolation(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.wantMachine(m1, contract.StateRunning, "")

	iso.set(errors.New("host table changed"))
	if err := h.a.CheckIsolation(context.Background()); err == nil {
		t.Fatal("no error")
	}
	h.a.Wait()
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonHostIsolationLost)
	h.wantMachine(m2, contract.StateDestroyed, contract.ReasonHostIsolationLost)
	if len(h.drv.Stops()) < 2 {
		t.Fatalf("driver stops: %v", h.drv.Stops())
	}
	h.poll(agent.OutcomeApplied)
	r := h.lastReport()
	if r.StartsBlocked == nil || *r.StartsBlocked != contract.BlockedHostTable {
		t.Fatalf("starts_blocked %v", r.StartsBlocked)
	}
	om, ok := reported(r, m1)
	if !ok || om.Reason != contract.ReasonHostIsolationLost || len(om.PhaseLines) == 0 || om.PhaseLines[len(om.PhaseLines)-1].Step != "host_isolation" {
		t.Fatalf("report for m1: %+v", om)
	}
	iso.set(nil)
	_ = h.a.CheckIsolation(context.Background())
	h.assign(m3, j3)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m3, contract.StateFailed, contract.ReasonStartsBlocked)
}

// TestIsolationCheckedOffline: the check runs on its own schedule in Run, with the platform
// unreachable, and destroys the machines without it.
func TestIsolationCheckedOffline(t *testing.T) {
	h := newHarness(t)
	iso := &isoDriver{Driver: h.drv}
	h.wrap = iso
	h.active()
	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")
	h.plat.SetUnreachable(true)
	iso.set(errors.New("table missing"))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.a.Run(ctx) }()
	if !eventually(t, 5*time.Second, func() bool { s, _, _ := h.machine(m1); return s == contract.StateDestroyed }) {
		h.wantMachine(m1, contract.StateDestroyed, contract.ReasonHostIsolationLost)
	}
	cancel()
	<-done
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonHostIsolationLost)
}
