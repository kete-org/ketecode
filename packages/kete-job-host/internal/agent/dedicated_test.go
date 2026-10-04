package agent_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/fake"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/enroll"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

func dedicated(generation string) cfgOpt {
	return func(f *configFile) {
		f.Driver, f.Reset, f.Slots, f.Generation = contract.DriverDedicated, contract.ResetProviderRebuild, 1, generation
		f.Versions.Firecracker, f.Versions.GuestKernel = "", ""
	}
}

func (h *harness) assignDedicated(machineID, jobID string) {
	h.t.Helper()
	c := machineConfig(jobID)
	c.HostProfile, c.HostGeneration = seal.ProfileDedicated, h.cfg.Generation
	must(h.t, h.plat.Assign(h.hostID, h.run(machineID, jobID, time.Hour), c))
}

func (h *harness) wantSpentReport(free int) {
	h.t.Helper()
	r := h.lastReport()
	if r.StartsBlocked == nil || *r.StartsBlocked != contract.BlockedGenerationSpent || r.Slots.Free != free {
		h.t.Fatalf("report starts_blocked %v free %d, want generation_spent free %d", r.StartsBlocked, r.Slots.Free, free)
	}
}

// TestDedicatedOneJobPerGeneration (ADR 0023 rule 8): the first start spends the generation; any
// other machine is refused `starts_blocked`, the report says `generation_spent` with no free slot,
// and that survives the job's end and an agent restart.
func TestDedicatedOneJobPerGeneration(t *testing.T) {
	h := newHarness(t, dedicated("g-ded-1"))
	h.active()
	if r := h.lastReport(); r.StartsBlocked != nil || r.Slots.Free != 1 {
		t.Fatalf("fresh host: %+v", r)
	}
	h.assignDedicated(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")
	if got := h.a.Snapshot().GenerationSpentBy; got != m1 {
		t.Fatalf("generation_spent_by %q", got)
	}
	h.poll(agent.OutcomeApplied)
	h.wantSpentReport(0)

	// A second assignment in the same generation (a platform that ignores rule 8).
	h.assignDedicated(m2, j2)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m2, contract.StateFailed, contract.ReasonStartsBlocked)
	h.wantMachine(m1, contract.StateRunning, "")
	if h.drv.Starts() != 1 {
		t.Fatalf("driver starts %d", h.drv.Starts())
	}

	// The job ends: still no free slot.
	h.drv.SetStatus(m1, driver.StatusExited)
	h.supervise()
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonExited)
	h.poll(agent.OutcomeApplied)
	h.wantSpentReport(0)

	// A restart keeps it (the state file).
	h.newAgent()
	if err := h.a.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.poll(agent.OutcomeApplied)
	h.wantSpentReport(0)
	h.assignDedicated(m3, j3)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m3, contract.StateFailed, contract.ReasonStartsBlocked)
	if h.drv.Starts() != 1 {
		t.Fatalf("driver starts %d after restart", h.drv.Starts())
	}
}

type failVerify struct{}

func (f failVerify) Verify(context.Context, string) error { return errors.New("no signature") }

// TestDedicatedSpentOnlyByAStart: an assignment refused before anything of it ran (signature,
// generation mismatch) doesn't spend the generation; once spent, nothing starts (persisted).
func TestDedicatedSpentOnlyByAStart(t *testing.T) {
	h := newHarness(t, dedicated("g-ded-1"))
	h.verifier = failVerify{}
	h.active()
	h.assignDedicated(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateFailed, contract.ReasonImageSignatureInvalid)
	if got := h.a.Snapshot().GenerationSpentBy; got != "" {
		t.Fatalf("spent by a refused assignment: %q", got)
	}
	h.poll(agent.OutcomeApplied)
	if r := h.lastReport(); r.StartsBlocked != nil {
		t.Fatalf("blocked after a refusal: %v", *r.StartsBlocked)
	}

	// A state that says m2 spent the generation: even m2 delivered again doesn't start.
	h.verifier = allowAll{}
	st := h.a.Snapshot()
	st.GenerationSpentBy = m2
	saveState(t, h.cfg, st)
	h.newAgent()
	if err := h.a.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.assignDedicated(m2, j2)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m2, contract.StateFailed, contract.ReasonStartsBlocked)
	if h.drv.Starts() != 0 {
		t.Fatalf("driver starts %d", h.drv.Starts())
	}
}

// TestDedicatedReplayedSpender: the spending machine, finished and forgotten (tombstone pruned),
// named again by the platform never runs a second time.
func TestDedicatedReplayedSpender(t *testing.T) {
	h := newHarness(t, dedicated("g-ded-1"))
	h.active()
	h.assignDedicated(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")
	h.drv.SetStatus(m1, driver.StatusExited)
	h.supervise()
	h.poll(agent.OutcomeApplied) // reports the tombstone
	h.poll(agent.OutcomeApplied) // the platform recorded it: forgotten
	if _, _, ok := h.machine(m1); ok {
		t.Fatal("tombstone not pruned")
	}
	h.drv.Remove(m1)
	h.assignDedicated(m1, j1) // replayed
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateFailed, contract.ReasonStartsBlocked)
	if h.drv.Starts() != 1 {
		t.Fatalf("driver starts %d", h.drv.Starts())
	}
}

func saveState(t *testing.T, cfg config.Config, st any) {
	t.Helper()
	b, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.StateDir, "state.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

// fakeProvider stands in for a cloud provider's rebuild API under the platform's R1 orchestrator
// (ADR 0023 rule 8): each rebuild is a fresh disk (a new state directory: no keys, no state) with
// user data that writes the agent's configuration (the rebuild's generation) and a fresh
// single-use enrollment token, which the platform registered as the token of a rebuild it started.
type fakeProvider struct {
	t        *testing.T
	h        *harness
	root     string
	rebuilds int
}

type server struct {
	cfg       config.Config
	tokenFile string
}

// rebuild re-creates the server; declared is the generation its user data writes ("" = the one
// the platform started the rebuild for).
func (p *fakeProvider) rebuild(declared string) server {
	p.t.Helper()
	p.rebuilds++
	gen := fmt.Sprintf("g-r1-%d", p.rebuilds)
	token := fmt.Sprintf("kete_jhe_rebuild%d", p.rebuilds) + strings.Repeat("r", 42-len(fmt.Sprintf("rebuild%d", p.rebuilds))) + "A"
	p.h.plat.AddRebuildToken(token, gen)
	if declared == "" {
		declared = gen
	}
	disk := filepath.Join(p.root, fmt.Sprintf("disk-%d", p.rebuilds))
	etc := filepath.Join(disk, "etc")
	must(p.t, os.MkdirAll(etc, 0o700))
	f := config.File{
		PlatformURL: origin, Driver: contract.DriverDedicated, Slots: 1, Reset: contract.ResetProviderRebuild, Generation: declared,
		StateDir: filepath.Join(disk, "state"), ImageAllowlist: []string{imageRef},
	}
	raw, _ := json.Marshal(f)
	cfg, err := config.Parse(raw)
	must(p.t, err)
	tf := filepath.Join(etc, "enroll.token")
	must(p.t, os.WriteFile(tf, []byte(token+"\n"), 0o600))
	return server{cfg: cfg, tokenFile: tf}
}

// boot is the rebuilt server's first boot: kete-job-host-enroll.service (enroll --token-file),
// then the agent with a fresh driver (nothing survives a rebuild).
func (h *harness) boot(s server) (status string) {
	h.t.Helper()
	h.cfg = s.cfg
	h.drv = fake.New()
	st, err := enroll.Run(context.Background(), enroll.Options{
		Config: h.cfg, Client: h.client(), Facts: h.facts(), TokenFile: s.tokenFile, Out: h.out, Log: h.logger(), Now: h.clock.Now,
	})
	must(h.t, err)
	if _, err := os.Lstat(s.tokenFile); !errors.Is(err, os.ErrNotExist) {
		h.t.Fatalf("token file left after enrollment: %v", err)
	}
	h.hostID = st.HostID
	return st.EnrolledStatus
}

// TestDedicatedR1Cycle: two jobs in sequence on one dedicated server, each after a verified
// provider rebuild (R1), the first identity refused after its job; the agent's half of the
// plan-overview P5 acceptance, against the fake platform and a fake provider.
func TestDedicatedR1Cycle(t *testing.T) {
	h := newHarness(t, dedicated("g-unused"))
	p := &fakeProvider{t: t, h: h, root: testroot.Dir(t)}

	// Provisioning is itself a rebuild: the platform auto-approves the matching enrollment.
	if st := h.boot(p.rebuild("")); st != "active" {
		t.Fatalf("first boot enrolled %s, want active (auto-approved rebuild)", st)
	}
	first := h.hostID
	firstCfg := h.cfg
	if h.cfg.Generation != "g-r1-1" || h.plat.HostSnapshot(first).Status != "active" {
		t.Fatalf("generation %s, platform status %s", h.cfg.Generation, h.plat.HostSnapshot(first).Status)
	}
	h.newAgent()
	h.poll(agent.OutcomeApplied)
	h.assignDedicated(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")
	h.drv.SetStatus(m1, driver.StatusExited)
	h.supervise()
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonExited)
	h.poll(agent.OutcomeApplied)
	h.wantSpentReport(0)
	h.assignDedicated(m2, j2) // refused by the agent even if the platform tried
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m2, contract.StateFailed, contract.ReasonStartsBlocked)

	// The platform revokes the spent identity at the job's end; the agent halts.
	h.plat.SetStatus(first, "revoked")
	if r := h.a.PollOnce(context.Background()); r.Outcome != agent.OutcomeHalted || h.a.Halted() != contract.ErrHostRevoked {
		t.Fatalf("after revocation: %+v %s", r, h.a.Halted())
	}
	oldKeys, err := keys.Load(keys.Dir(firstCfg.StateDir))
	must(t, err)

	// R1 again: a fresh disk, a new generation and identity; the next job runs.
	if st := h.boot(p.rebuild("")); st != "active" {
		t.Fatalf("second boot enrolled %s", st)
	}
	if h.hostID == first || h.cfg.Generation != "g-r1-2" {
		t.Fatalf("second identity %s generation %s", h.hostID, h.cfg.Generation)
	}
	h.newAgent()
	h.poll(agent.OutcomeApplied)
	if r := h.lastReport(); r.StartsBlocked != nil || r.Slots.Free != 1 || r.Generation != "g-r1-2" {
		t.Fatalf("rebuilt host report %+v", r)
	}
	h.assignDedicated(m3, j3)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m3, contract.StateRunning, "")

	// The first identity stays refused.
	body, _ := json.Marshal(contract.Report{Generation: "g-r1-1", Versions: h.facts().Versions, Slots: contract.Slots{Total: 1, Free: 1}, Machines: []contract.ObservedMachine{}})
	_, err = client.New(origin, authority, h.clock.Now, h.copts).Post(context.Background(), contract.PollPath, first, oldKeys.Signing, body, 200)
	var ae *client.APIError
	if !errors.As(err, &ae) || ae.Reason != contract.ErrHostRevoked {
		t.Fatalf("old identity poll: %v", err)
	}

	// Auto-approval is only for the rebuild the platform started: user data declaring another
	// generation leaves the host pending.
	if st := h.boot(p.rebuild("g-forged")); st != "pending" {
		t.Fatalf("mismatched rebuild enrolled %s, want pending", st)
	}
}
