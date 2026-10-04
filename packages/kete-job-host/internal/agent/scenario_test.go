package agent_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

const phaseOK = `{"ts":"2026-10-03T01:59:40.125Z","step":"claim","event":"ok"}`

// TestLifecycle (AC2): enroll → pending → approved → poll → assignment → image allowed →
// config opened → fake machine started → reported running with phase lines → withdrawn →
// stopped → reported destroyed → tombstone acknowledged and forgotten.
func TestLifecycle(t *testing.T) {
	h := newHarness(t)
	h.enroll()
	h.newAgent()
	if fp := h.a.Snapshot().Fingerprint; !strings.Contains(h.out.String(), sig.GroupFingerprint(fp)) {
		t.Fatalf("fingerprint not printed: %q", h.out.String())
	}
	r := h.poll(agent.OutcomeRefused)
	if r.Reason != contract.ErrHostPending || r.Delay < 30*time.Millisecond || r.Delay > 60*time.Millisecond {
		t.Fatalf("pending: %+v", r)
	}
	h.plat.SetStatus(h.hostID, "active")
	h.poll(agent.OutcomeApplied)

	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")
	fm, ok := h.drv.Get(m1)
	want, _ := machineConfig(j1).Canonical()
	if !ok || !bytes.Equal(fm.Config, want) || fm.Spec.JobID != j1 || fm.Spec.Image != imageRef {
		t.Fatalf("driver got %+v / %s", fm.Spec, fm.Config)
	}

	h.drv.Emit(m1, phaseOK, "not json", `{"ts":"2026-10-03T01:59:41Z","step":"claim","event":"ok","message":"free text"}`, strings.Repeat("x", 600))
	h.supervise()
	h.poll(agent.OutcomeApplied)
	om, _ := reported(h.lastReport(), m1)
	if om.State != contract.StateRunning || len(om.PhaseLines) != 1 || om.PhaseLines[0].Step != "claim" || om.PhaseLinesDropped != 3 {
		t.Fatalf("report %+v", om)
	}
	pm := h.plat.HostSnapshot(h.hostID).Machines[m1]
	if pm.Config != nil {
		t.Fatal("platform still holds the ciphertext after running was reported")
	}
	h.poll(agent.OutcomeApplied) // run entry without config: a no-op
	om, _ = reported(h.lastReport(), m1)
	if h.drv.Starts() != 1 || len(om.PhaseLines) != 0 || om.PhaseLinesDropped != 0 {
		t.Fatalf("starts %d, re-sent lines %+v", h.drv.Starts(), om)
	}

	h.plat.Withdraw(h.hostID, m1)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonDesired)
	if _, ok := h.drv.Get(m1); ok {
		t.Fatal("machine still in the driver")
	}
	h.poll(agent.OutcomeApplied) // reports the tombstone; the answer names it nowhere
	om, _ = reported(h.lastReport(), m1)
	if om.State != contract.StateDestroyed || om.Reason != contract.ReasonDesired {
		t.Fatalf("tombstone report %+v", om)
	}
	if _, _, held := h.machine(m1); held {
		t.Fatal("tombstone not forgotten after the platform recorded it")
	}
	pm = h.plat.HostSnapshot(h.hostID).Machines[m1]
	if !pm.Terminal || pm.ObservedReason != contract.ReasonDesired {
		t.Fatalf("platform row %+v", pm)
	}
	if rev := h.a.Snapshot().AppliedRevision; rev == nil || *rev != h.plat.HostSnapshot(h.hostID).Revision {
		t.Fatalf("applied revision %v", rev)
	}
}

// TestMachineExits: a guest that powers off by itself is reported destroyed/exited.
func TestMachineExits(t *testing.T) {
	h := newHarness(t)
	h.active()
	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.drv.Emit(m1, `{"ts":"2026-10-03T01:58:01.500Z","step":"job","event":"exit","exit_code":0}`)
	h.drv.SetStatus(m1, driver.StatusExited)
	h.supervise()
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonExited)
	h.poll(agent.OutcomeApplied)
	om, _ := reported(h.lastReport(), m1)
	if om.Reason != contract.ReasonExited || len(om.PhaseLines) != 1 || *om.PhaseLines[0].ExitCode != 0 {
		t.Fatalf("report %+v", om)
	}
}

// TestMachineCrashes: a VMM that dies is reported destroyed/crashed.
func TestMachineCrashes(t *testing.T) {
	h := newHarness(t)
	h.active()
	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.drv.SetStatus(m1, driver.StatusCrashed)
	h.supervise()
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonCrashed)
}

// TestAssignmentRefusals (AC3): each check fails its machine with its reason, the driver never
// sees the machine, and the next report carries the failure.
func TestAssignmentRefusals(t *testing.T) {
	type tc struct {
		name   string
		opts   []cfgOpt
		setup  func(h *harness)
		reason string
	}
	other := machineConfig(j1)
	cases := []tc{
		{name: "image not allowlisted", reason: contract.ReasonImageNotAllowed, setup: func(h *harness) {
			rm := h.run(m1, j1, time.Hour)
			rm.Image = strings.Replace(imageRef, "4f9c", "0000", 1)
			must(t, h.plat.Assign(h.hostID, rm, machineConfig(j1)))
		}},
		{name: "image by tag", reason: contract.ReasonImageNotAllowed, setup: func(h *harness) {
			rm := h.run(m1, j1, time.Hour)
			rm.Image = "ghcr.io/kete-org/kete-job:latest"
			must(t, h.plat.Assign(h.hostID, rm, machineConfig(j1)))
		}},
		{name: "signature verifier refuses", reason: contract.ReasonImageSignatureInvalid, setup: func(h *harness) {
			h.assign(m1, j1)
		}},
		{name: "platform url mismatch", reason: contract.ReasonPlatformMismatch, setup: func(h *harness) {
			c := other
			c.PlatformURL = "https://portal.evil.example"
			must(t, h.plat.Assign(h.hostID, h.run(m1, j1, time.Hour), c))
		}},
		{name: "tampered ciphertext", reason: contract.ReasonConfigUndecryptable, setup: func(h *harness) {
			rm := h.run(m1, j1, time.Hour)
			js, _ := machineConfig(j1).Canonical()
			must(t, h.plat.AssignPlaintext(h.hostID, rm, js))
			snap := h.plat.HostSnapshot(h.hostID).Machines[m1]
			sc := *snap.Config
			ct, _ := base64.RawURLEncoding.DecodeString(sc.Ciphertext)
			ct[0] ^= 1
			sc.Ciphertext = base64.RawURLEncoding.EncodeToString(ct)
			rm.Config = &sc
			must(t, h.plat.AssignRaw(h.hostID, rm))
		}},
		{name: "sealed for another machine", reason: contract.ReasonConfigUndecryptable, setup: func(h *harness) {
			// Sealed under m2's binding, delivered as m1.
			js, _ := machineConfig(j1).Canonical()
			must(t, h.plat.AssignPlaintext(h.hostID, h.run(m2, j1, time.Hour), js))
			sc := h.plat.HostSnapshot(h.hostID).Machines[m2].Config
			h.plat.Withdraw(h.hostID, m2)
			rm := h.run(m1, j1, time.Hour)
			rm.Config = sc
			must(t, h.plat.AssignRaw(h.hostID, rm))
		}},
		{name: "other job id in the config", reason: contract.ReasonConfigInvalid, setup: func(h *harness) {
			must(t, h.plat.Assign(h.hostID, h.run(m1, j1, time.Hour), machineConfig(j2)))
		}},
		{name: "dedicated config on a firecracker host", reason: contract.ReasonConfigInvalid, setup: func(h *harness) {
			c := other
			c.HostProfile, c.HostGeneration = seal.ProfileDedicated, "g-1"
			must(t, h.plat.Assign(h.hostID, h.run(m1, j1, time.Hour), c))
		}},
		{name: "non-canonical plaintext", reason: contract.ReasonConfigInvalid, setup: func(h *harness) {
			js, _ := machineConfig(j1).Canonical()
			must(t, h.plat.AssignPlaintext(h.hostID, h.run(m1, j1, time.Hour), append([]byte(" "), js...)))
		}},
		{name: "unknown field", reason: contract.ReasonConfigInvalid, setup: func(h *harness) {
			js, _ := machineConfig(j1).Canonical()
			js = append(js[:len(js)-1], []byte(`,"network":"10.0.0.2/30"}`)...)
			must(t, h.plat.AssignPlaintext(h.hostID, h.run(m1, j1, time.Hour), js))
		}},
		{name: "no config", reason: contract.ReasonConfigInvalid, setup: func(h *harness) {
			must(t, h.plat.AssignRaw(h.hostID, h.run(m1, j1, time.Hour)))
		}},
		{name: "deadline passed", reason: contract.ReasonDeadlinePassed, setup: func(h *harness) {
			must(t, h.plat.Assign(h.hostID, h.run(m1, j1, -time.Second), machineConfig(j1)))
		}},
		{name: "starts blocked by the operator", reason: contract.ReasonStartsBlocked, opts: []cfgOpt{func(f *configFile) { f.StartsBlocked = "operator" }}, setup: func(h *harness) {
			h.assign(m1, j1)
		}},
		{name: "driver fails", reason: contract.ReasonDriverFailed, setup: func(h *harness) {
			h.drv.SetFailStart(m1, true)
			h.assign(m1, j1)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, c.opts...)
			if c.reason == contract.ReasonImageSignatureInvalid {
				h.verifier = image.Unconfigured{} // the production verifier of P2: refuses every image
			}
			h.active()
			c.setup(h)
			h.poll(agent.OutcomeApplied)
			h.wantMachine(m1, contract.StateFailed, c.reason)
			if _, ok := h.drv.Get(m1); ok {
				t.Fatal("refused machine is in the driver")
			}
			h.poll(agent.OutcomeApplied)
			om, ok := reported(h.lastReport(), m1)
			if !ok || om.State != contract.StateFailed || om.Reason != c.reason {
				t.Fatalf("report %+v", om)
			}
			if c.reason == contract.ReasonStartsBlocked {
				if sb := h.lastReport().StartsBlocked; sb == nil || *sb != contract.BlockedOperator {
					t.Fatalf("starts_blocked %v", sb)
				}
			}
		})
	}
}

func TestNoFreeSlot(t *testing.T) {
	h := newHarness(t, func(f *configFile) { f.Slots = 1 })
	h.active()
	h.assign(m1, j1)
	h.assign(m2, j2)
	h.poll(agent.OutcomeApplied)
	s1, _, _ := h.machine(m1)
	s2, _, _ := h.machine(m2)
	if !((s1 == contract.StateRunning && s2 == contract.StateFailed) || (s2 == contract.StateRunning && s1 == contract.StateFailed)) {
		t.Fatalf("states %s %s", s1, s2)
	}
	failed := m2
	if s1 == contract.StateFailed {
		failed = m1
	}
	h.wantMachine(failed, contract.StateFailed, contract.ReasonNoFreeSlot)
	if r := h.lastReport(); r.Slots.Total != 1 {
		t.Fatalf("slots %+v", r.Slots)
	}
	h.poll(agent.OutcomeApplied)
	if r := h.lastReport(); r.Slots.Free != 0 {
		t.Fatalf("free %d with a running machine", r.Slots.Free)
	}
}

// TestDedicatedGenerationMismatch (AC3): a dedicated configuration whose host_generation isn't
// the host's fails generation_mismatch; the matching one starts.
func TestDedicatedGenerationMismatch(t *testing.T) {
	h := newHarness(t, func(f *configFile) {
		f.Driver, f.Reset, f.Slots, f.Generation = contract.DriverDedicated, contract.ResetProviderRebuild, 1, "g-ded-1"
		f.Versions.Firecracker, f.Versions.GuestKernel = "", ""
	})
	h.active()
	c := machineConfig(j1)
	c.HostProfile, c.HostGeneration = seal.ProfileDedicated, "g-ded-0"
	must(t, h.plat.Assign(h.hostID, h.run(m1, j1, time.Hour), c))
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateFailed, contract.ReasonGenerationMismatch)
	c = machineConfig(j2)
	c.HostProfile, c.HostGeneration = seal.ProfileDedicated, "g-ded-1"
	must(t, h.plat.Assign(h.hostID, h.run(m2, j2, time.Hour), c))
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m2, contract.StateRunning, "")
}

// TestReplayAndStale (AC4): a response for another nonce or host, or with a lower revision,
// changes nothing.
func TestReplayAndStale(t *testing.T) {
	h := newHarness(t)
	h.active()
	before := h.a.Snapshot().AppliedRevision
	h.assign(m1, j1)
	for _, c := range []struct {
		why    string
		tamper func(*contract.PollResponse)
	}{
		{"in_reply_to", func(p *contract.PollResponse) { p.InReplyTo = "00000000000000000000000000000000" }},
		{"host_id", func(p *contract.PollResponse) { p.HostID = "00000000-0000-4000-8000-000000000000" }},
		{"invalid", func(p *contract.PollResponse) { p.Desired.Run = nil }},
	} {
		h.plat.SetTamper(c.tamper)
		r := h.poll(agent.OutcomeDiscarded)
		if r.Reason != c.why {
			t.Fatalf("discard reason %s, want %s", r.Reason, c.why)
		}
		if _, _, held := h.machine(m1); held || h.drv.Starts() != 0 {
			t.Fatalf("%s: a discarded response was applied", c.why)
		}
		if rev := h.a.Snapshot().AppliedRevision; *rev != *before {
			t.Fatalf("%s: revision moved", c.why)
		}
	}
	h.plat.SetTamper(nil)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m1, contract.StateRunning, "")
	applied := *h.a.Snapshot().AppliedRevision
	h.plat.SetTamper(func(p *contract.PollResponse) {
		old := applied - 1
		p.Desired.Revision = &old
		empty := []contract.RunMachine{}
		p.Desired.Run = &empty // a replayed older state would destroy m1
	})
	if r := h.poll(agent.OutcomeDiscarded); r.Reason != "stale_revision" {
		t.Fatalf("stale: %+v", r)
	}
	h.wantMachine(m1, contract.StateRunning, "")
}

// TestPhaseLinesResentAfterLostResponse: lines in a report whose response was discarded are
// sent again; the per-report cap is 200 with the rest counted.
func TestPhaseLinesResentAfterLostResponse(t *testing.T) {
	h := newHarness(t)
	h.active()
	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied)
	h.drv.Emit(m1, phaseOK)
	h.supervise()
	h.plat.SetTamper(func(p *contract.PollResponse) { p.InReplyTo = "00000000000000000000000000000000" })
	h.poll(agent.OutcomeDiscarded)
	h.plat.SetTamper(nil)
	h.poll(agent.OutcomeApplied)
	om, _ := reported(h.lastReport(), m1)
	if len(om.PhaseLines) != 1 {
		t.Fatalf("line not resent: %+v", om)
	}
	h.poll(agent.OutcomeApplied)
	om, _ = reported(h.lastReport(), m1)
	if len(om.PhaseLines) != 0 {
		t.Fatalf("acknowledged line resent: %+v", om)
	}
	lines := make([]string, 250)
	for i := range lines {
		lines[i] = phaseOK
	}
	h.drv.Emit(m1, lines...)
	h.supervise()
	h.poll(agent.OutcomeApplied)
	om, _ = reported(h.lastReport(), m1)
	if len(om.PhaseLines) != 200 || om.PhaseLinesDropped != 50 {
		t.Fatalf("cap: %d lines, %d dropped", len(om.PhaseLines), om.PhaseLinesDropped)
	}
}

// TestClockAndNonce (AC4): no request while the clock is unsynchronised; a skewed clock is
// refused (clock_skew) and a replayed nonce (nonce_replayed) is retried with a fresh one.
func TestClockAndNonce(t *testing.T) {
	h := newHarness(t)
	h.active()
	n := len(h.plat.Requests())
	h.synced.v.Store(false)
	h.poll(agent.OutcomeClockUnsynced)
	if len(h.plat.Requests()) != n {
		t.Fatal("a request was sent with the clock unsynchronised")
	}
	h.synced.v.Store(true)

	h.plat.SetSkew(61 * time.Second)
	if r := h.poll(agent.OutcomeRefused); r.Reason != contract.ErrClockSkew {
		t.Fatalf("skew: %+v", r)
	}
	h.plat.SetSkew(0)

	h.plat.SetForceError(contract.ErrNonceReplayed)
	if r := h.poll(agent.OutcomeRefused); r.Reason != contract.ErrNonceReplayed || r.Delay != time.Millisecond {
		t.Fatalf("nonce: %+v", r)
	}
	h.plat.SetForceError("")
	h.poll(agent.OutcomeApplied)

	// The fake platform's nonce store: the same signed request twice.
	k, _ := keys.Load(keys.Dir(h.cfg.StateDir))
	body := []byte(`{}`)
	p := sig.Params{Created: h.clock.Now().Unix(), Expires: h.clock.Now().Unix() + 60, Nonce: "0123456789abcdef0123456789abcdef", KeyID: h.hostID}
	hd, _, _ := sig.Sign(k.Signing, authority, contract.PollPath, body, p)
	tr := &http.Transport{DialContext: h.copts.DialContext}
	tr.TLSClientConfig = tlsConfig(h)
	hc := &http.Client{Transport: tr}
	var reasons []int
	for range 2 {
		req, _ := http.NewRequest(http.MethodPost, origin+contract.PollPath, bytes.NewReader(body))
		req.Header.Set("Content-Type", hd.ContentType)
		req.Header.Set("Content-Digest", hd.ContentDigest)
		req.Header.Set("Signature-Input", hd.SignatureInput)
		req.Header.Set("Signature", hd.Signature)
		resp, err := hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		reasons = append(reasons, resp.StatusCode)
	}
	recs := h.plat.Requests()
	if reasons[0] != 400 || reasons[1] != 401 || recs[len(recs)-2].Reason != contract.ErrMalformedRequest || recs[len(recs)-1].Reason != contract.ErrNonceReplayed {
		t.Fatalf("replay statuses %v, last reasons %s %s", reasons, recs[len(recs)-2].Reason, recs[len(recs)-1].Reason)
	}
}

// TestHostStates (AC5).
func TestHostStates(t *testing.T) {
	t.Run("disabled destroys everything, then reports it", func(t *testing.T) {
		h := newHarness(t)
		h.active()
		h.assign(m1, j1)
		h.poll(agent.OutcomeApplied)
		h.plat.SetStatus(h.hostID, "disabled")
		if r := h.poll(agent.OutcomeRefused); r.Reason != contract.ErrHostDisabled || r.Delay != 60*time.Millisecond {
			t.Fatalf("%+v", r)
		}
		h.wantMachine(m1, contract.StateDestroyed, contract.ReasonHostDisabled)
		h.plat.SetStatus(h.hostID, "active")
		h.poll(agent.OutcomeApplied)
		if om, _ := reported(h.lastReport(), m1); om.Reason != contract.ReasonHostDisabled {
			t.Fatalf("report %+v", om)
		}
	})
	for _, c := range []struct{ name, halt string }{{"revoked", state.HaltRevoked}, {"generation mismatch", state.HaltGenerationMismatch}} {
		t.Run(c.name+" destroys everything and halts durably", func(t *testing.T) {
			h := newHarness(t)
			h.active()
			h.assign(m1, j1)
			h.poll(agent.OutcomeApplied)
			if c.halt == state.HaltRevoked {
				h.plat.SetStatus(h.hostID, "revoked")
			} else {
				h.plat.SetGeneration(h.hostID, "g-other")
			}
			h.poll(agent.OutcomeHalted)
			h.wantMachine(m1, contract.StateDestroyed, contract.ReasonHostDisabled)
			n := len(h.plat.Requests())
			h.poll(agent.OutcomeHalted)
			if len(h.plat.Requests()) != n {
				t.Fatal("polled after halting")
			}
			h.newAgent()
			err := h.a.Run(context.Background())
			if !errors.Is(err, agent.ErrHalted) || !strings.Contains(err.Error(), c.halt) {
				t.Fatalf("restart: %v", err)
			}
		})
	}
	t.Run("signature_invalid halts polling but keeps the deadline killer", func(t *testing.T) {
		h := newHarness(t)
		h.active()
		h.assign(m1, j1)
		h.poll(agent.OutcomeApplied)
		h.plat.SetSigningKey(h.hostID, "6uUZMRZSj4h6k98L6aaz-MNmdvBQAOt2HCxcCGPyT5I")
		h.poll(agent.OutcomeHalted)
		h.wantMachine(m1, contract.StateRunning, "")
		h.clock.Advance(time.Hour + contract.DeadlineGrace + time.Second)
		h.supervise()
		h.wantMachine(m1, contract.StateDestroyed, contract.ReasonDeadline)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := h.a.Run(ctx); !errors.Is(err, agent.ErrHalted) {
			t.Fatalf("run: %v", err)
		}
	})
}

// TestRestartReconcile (AC7).
func TestRestartReconcile(t *testing.T) {
	h := newHarness(t, func(f *configFile) { f.Slots = 3 })
	h.active()
	h.assign(m1, j1)
	h.assign(m2, j2)
	h.assign(m3, j3)
	h.poll(agent.OutcomeApplied)
	h.drv.SetFailStop(m3, true)
	h.plat.Withdraw(h.hostID, m3)
	h.poll(agent.OutcomeApplied)
	h.wantMachine(m3, contract.StateStopping, "")

	// The agent "restarts": m2 vanished meanwhile, an unknown machine and a junk id appeared.
	const unknown = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f"
	h.drv.Remove(m2)
	h.drv.Adopt(unknown)
	h.drv.Adopt("not-a-machine-id")
	h.drv.SetFailStop(m3, false)
	stopsBefore := len(h.drv.Stops())
	h.newAgent()
	if err := h.a.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
	h.wantMachine(m1, contract.StateRunning, "")
	h.wantMachine(m2, contract.StateDestroyed, contract.ReasonCrashed)
	h.wantMachine(m3, contract.StateDestroyed, contract.ReasonDesired)
	h.wantMachine(unknown, contract.StateDestroyed, contract.ReasonDesired)
	if _, _, ok := h.machine("not-a-machine-id"); ok {
		t.Fatal("junk id recorded")
	}
	ids, _ := h.drv.List(context.Background())
	if len(ids) != 1 || ids[0] != m1 {
		t.Fatalf("driver holds %v", ids)
	}
	for _, id := range h.drv.Stops()[stopsBefore:] {
		if id == m1 {
			t.Fatal("the running machine was stopped")
		}
	}
	h.poll(agent.OutcomeApplied)
	r := h.lastReport()
	if om, _ := reported(r, unknown); om.JobID != nil || om.State != contract.StateDestroyed {
		t.Fatalf("unknown machine report %+v", om)
	}
	if om, _ := reported(r, m2); om.Reason != contract.ReasonCrashed {
		t.Fatalf("vanished machine report %+v", om)
	}
	if _, ok := h.plat.HostSnapshot(h.hostID).Unknown[unknown]; !ok {
		t.Fatal("platform did not see the unknown machine")
	}
}

// TestDeadlineKiller (AC7): with the platform unreachable, a machine past deadline + 5 min and
// one older than 135 min are destroyed; on reconnect the report shows both.
func TestDeadlineKiller(t *testing.T) {
	h := newHarness(t)
	h.active()
	must(t, h.plat.Assign(h.hostID, h.run(m1, j1, 10*time.Minute), machineConfig(j1)))
	must(t, h.plat.Assign(h.hostID, h.run(m2, j2, 3*time.Hour), machineConfig(j2)))
	h.poll(agent.OutcomeApplied)
	h.plat.SetUnreachable(true)
	h.poll(agent.OutcomeNetwork)

	h.clock.Advance(15 * time.Minute)
	h.supervise()
	h.wantMachine(m1, contract.StateRunning, "")
	h.clock.Advance(time.Second)
	h.supervise()
	h.wantMachine(m1, contract.StateDestroyed, contract.ReasonDeadline)
	h.wantMachine(m2, contract.StateRunning, "")

	h.clock.Advance(contract.MachineMaxAge - 15*time.Minute - time.Second)
	h.supervise()
	h.wantMachine(m2, contract.StateRunning, "")
	h.clock.Advance(2 * time.Second)
	h.supervise()
	h.wantMachine(m2, contract.StateDestroyed, contract.ReasonMaxAge)
	if ids, _ := h.drv.List(context.Background()); len(ids) != 0 {
		t.Fatalf("driver still holds %v", ids)
	}

	h.plat.SetUnreachable(false)
	h.poll(agent.OutcomeApplied)
	r := h.lastReport()
	if a, _ := reported(r, m1); a.Reason != contract.ReasonDeadline {
		t.Fatalf("m1 %+v", a)
	}
	if b, _ := reported(r, m2); b.Reason != contract.ReasonMaxAge {
		t.Fatalf("m2 %+v", b)
	}
}

// TestRunLoop: the real loop polls, starts, supervises and stops on cancel.
func TestRunLoop(t *testing.T) {
	h := newHarness(t)
	h.enroll()
	h.plat.SetStatus(h.hostID, "active")
	h.newAgent()
	h.assign(m1, j1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.a.Run(ctx) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if pm := h.plat.HostSnapshot(h.hostID).Machines[m1]; pm.Observed == contract.StateRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("machine never reported running; logs:\n%s", h.logs.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("run: %v", err)
	}
}

// TestNoSecretsLeak (AC8): over a whole run, no log line, state file or report carries the claim
// token, the enrollment token, a private key or the plaintext configuration; key and state files
// are private.
func TestNoSecretsLeak(t *testing.T) {
	h := newHarness(t)
	h.active()
	h.assign(m1, j1)
	h.poll(agent.OutcomeApplied)
	if fm, _ := h.drv.Get(m1); !strings.Contains(string(fm.Config), claimToken) {
		t.Fatal("control: the driver should have received the claim token")
	}
	h.drv.Emit(m1, phaseOK, `{"claim_token":"`+claimToken+`"}`, claimToken)
	h.supervise()
	h.poll(agent.OutcomeApplied)
	h.plat.Withdraw(h.hostID, m1)
	h.poll(agent.OutcomeApplied)
	h.poll(agent.OutcomeApplied)
	// A failed assignment too (its config is opened, then refused).
	c := machineConfig(j2)
	c.PlatformURL = "https://portal.evil.example"
	must(t, h.plat.Assign(h.hostID, h.run(m2, j2, time.Hour), c))
	h.poll(agent.OutcomeApplied)

	k, _ := keys.Load(keys.Dir(h.cfg.StateDir))
	plain, _ := machineConfig(j1).Canonical()
	secrets := map[string]string{
		"claim token":            claimToken,
		"enrollment token":       enrollToken,
		"enrollment token body":  strings.TrimPrefix(enrollToken, "kete_jhe_"),
		"signing seed hex":       hex.EncodeToString(k.Signing.Seed()),
		"signing seed base64url": base64.RawURLEncoding.EncodeToString(k.Signing.Seed()),
		"signing seed base64":    base64.StdEncoding.EncodeToString(k.Signing.Seed()),
		"sealing key hex":        hex.EncodeToString(k.SealingPrivate()),
		"sealing key base64url":  base64.RawURLEncoding.EncodeToString(k.SealingPrivate()),
		"plaintext config":       string(plain),
	}
	st, err := os.ReadFile(state.Path(h.cfg.StateDir))
	if err != nil {
		t.Fatal(err)
	}
	type output struct {
		name, text string
		enroll     bool
	}
	outputs := []output{{"logs", h.logs.String(), false}, {"state file", string(st), false}, {"enroll output", h.out.String(), false}}
	for _, r := range h.plat.Requests() {
		outputs = append(outputs, output{"request body " + r.Path, string(r.Body), r.Path == contract.EnrollPath})
	}
	if !strings.Contains(h.logs.String(), `"msg":"machine"`) {
		t.Fatal("no logs captured")
	}
	// Positive controls: the secrets were really in play (the grep can find them where they belong).
	sawToken := false
	for _, o := range outputs {
		sawToken = sawToken || (o.enroll && strings.Contains(o.text, enrollToken))
	}
	if !sawToken {
		t.Fatal("control: the enrollment request should carry the token")
	}
	if fm, ok := h.drv.Get(m2); ok || fm.Config != nil {
		t.Fatal("control: the refused machine reached the driver")
	}
	for _, o := range outputs {
		for sname, s := range secrets {
			if o.enroll && strings.HasPrefix(sname, "enrollment token") {
				continue // the enrollment request carries the token by design (the only place it goes)
			}
			if strings.Contains(o.text, s) {
				t.Errorf("%s contains the %s", o.name, sname)
			}
		}
	}
	for path, want := range map[string]os.FileMode{
		h.cfg.StateDir: 0o700, keys.Dir(h.cfg.StateDir): 0o700, state.Path(h.cfg.StateDir): 0o600,
		filepath.Join(keys.Dir(h.cfg.StateDir), "signing.key"): 0o600, filepath.Join(keys.Dir(h.cfg.StateDir), "sealing.key"): 0o600,
	} {
		fi, err := os.Stat(path)
		if err != nil || fi.Mode().Perm() != want {
			t.Errorf("%s: mode %v (%v), want %04o", path, fi.Mode().Perm(), err, want)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
