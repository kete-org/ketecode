package agent_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/fake"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/enroll"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

// enrollToken is a valid-shaped enrollment token with a distinctive marker.
var enrollToken = "kete_jhe_SECRETenrollTOKEN" + strings.Repeat("x", 42-17) + "A"

// Distinctive secrets the no-leak test greps for.
const (
	authority  = "portal.kete.example"
	origin     = "https://" + authority
	claimToken = "c1a1d00dc1a1d00dc1a1d00dc1a1d00dc1a1d00dc1a1d00dc1a1d00dc1a1d00d"
	imageRef   = "ghcr.io/kete-org/kete-job@sha256:4f9c2b7a1e8d3c6f5a0b9e2d7c4f1a8b3e6d9c2f5a8b1e4d7c0f3a6b9e2d5c8f"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type syncedFlag struct{ v atomic.Bool }

func (f *syncedFlag) Synced() (bool, error) { return f.v.Load(), nil }

type allowAll struct{}

func (allowAll) Verify(context.Context, string) error { return nil }

type harness struct {
	t        *testing.T
	clock    *fakeClock
	plat     *fakeplatform.Platform
	copts    client.Options
	drv      *fake.Driver
	logs     *syncBuffer
	out      *syncBuffer
	cfg      config.Config
	synced   *syncedFlag
	verifier image.Verifier
	// wrap, when set, is the driver the agent gets instead of drv (tests of optional interfaces).
	wrap   driver.Driver
	hostID string
	a      *agent.Agent
}

type cfgOpt func(*config.File)

func newHarness(t *testing.T, opts ...cfgOpt) *harness {
	t.Helper()
	f := config.File{
		PlatformURL: origin, Driver: contract.DriverFirecracker, Slots: 2, Reset: contract.ResetNone,
		StateDir: filepath.Join(testroot.Dir(t), "state"), ImageAllowlist: []string{imageRef},
	}
	f.Versions.Firecracker, f.Versions.GuestKernel = "1.13.1", "6.1.141-kete.1"
	for _, o := range opts {
		o(&f)
	}
	raw, _ := json.Marshal(f)
	cfg, err := config.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	clk := &fakeClock{t: time.Now().UTC().Truncate(time.Second)}
	plat := fakeplatform.New(authority, clk.Now)
	srv, copts, err := fakeplatform.StartTLS(plat)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	h := &harness{
		t: t, clock: clk, plat: plat, copts: copts, drv: fake.New(), logs: &syncBuffer{}, out: &syncBuffer{},
		cfg: cfg, synced: &syncedFlag{}, verifier: allowAll{},
	}
	h.synced.v.Store(true)
	return h
}

func (h *harness) logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func (h *harness) client() *client.Client {
	return client.New(h.cfg.Origin, h.cfg.Authority, h.clock.Now, h.copts)
}

func (h *harness) facts() contract.Facts {
	f := contract.Facts{
		Arch: "amd64", Driver: h.cfg.Driver, Slots: h.cfg.Slots, KVM: h.cfg.Driver == contract.DriverFirecracker, Reset: h.cfg.Reset,
		Versions: contract.Versions{Agent: "0.1.0", HostKernel: "6.8.0-45-generic", Firecracker: h.cfg.Firecracker, GuestKernel: h.cfg.GuestKernel},
	}
	return f
}

func (h *harness) enroll() {
	h.t.Helper()
	h.plat.AddToken(enrollToken)
	st, err := enroll.Run(context.Background(), enroll.Options{
		Config: h.cfg, Client: h.client(), Facts: h.facts(), Token: strings.NewReader(enrollToken + "\n"),
		Out: h.out, Log: h.logger(), Now: h.clock.Now,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.hostID = st.HostID
}

func (h *harness) newAgent() *agent.Agent {
	h.t.Helper()
	k, err := keys.Load(keys.Dir(h.cfg.StateDir))
	if err != nil {
		h.t.Fatal(err)
	}
	var drv driver.Driver = h.drv
	if h.wrap != nil {
		drv = h.wrap
	}
	a, err := agent.New(agent.Options{
		Config: h.cfg, Keys: k, Driver: drv, Verifier: h.verifier, Client: h.client(), Clock: h.synced,
		Versions: h.facts().Versions, Log: h.logger(), Now: h.clock.Now,
		Interval: func(s int) time.Duration { return time.Duration(s) * time.Millisecond }, SuperviseEvery: 5 * time.Millisecond, IsolationEvery: 5 * time.Millisecond,
		DriverTimeouts: agent.DriverTimeouts{Start: driverTimeout, Stop: driverTimeout, Status: driverTimeout, Logs: driverTimeout, List: driverTimeout},
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.a = a
	return a
}

// active enrolls, approves and builds the agent, with one applied poll.
func (h *harness) active() *agent.Agent {
	h.t.Helper()
	h.enroll()
	h.plat.SetStatus(h.hostID, "active")
	a := h.newAgent()
	h.poll(agent.OutcomeApplied)
	return a
}

func (h *harness) poll(want agent.Outcome) agent.Result {
	h.t.Helper()
	r := h.a.PollOnce(context.Background())
	h.a.Wait() // signature checks and preparation run in the background
	if r.Outcome != want {
		h.t.Fatalf("poll outcome %s (%s), want %s; logs:\n%s", r.Outcome, r.Reason, want, h.logs.String())
	}
	return r
}

func machineConfig(jobID string) seal.MachineConfig {
	return seal.MachineConfig{
		JobID: jobID, PlatformURL: origin, ClaimToken: claimToken, StorageHost: "storage.kete.example", HostProfile: seal.ProfileMicroVM,
	}
}

func (h *harness) run(machineID, jobID string, deadline time.Duration) contract.RunMachine {
	return contract.RunMachine{
		MachineID: machineID, JobID: jobID, Image: imageRef, Deadline: contract.FormatTime(h.clock.Now().Add(deadline)),
		Resources: contract.Resources{VCPUs: 4, MemoryMiB: 4096, ScratchGiB: 20},
	}
}

func (h *harness) assign(machineID, jobID string) contract.RunMachine {
	h.t.Helper()
	rm := h.run(machineID, jobID, time.Hour)
	if err := h.plat.Assign(h.hostID, rm, machineConfig(jobID)); err != nil {
		h.t.Fatal(err)
	}
	return rm
}

func (h *harness) machine(id string) (state string, reason string, ok bool) {
	for _, m := range h.a.Snapshot().Machines {
		if m.MachineID == id {
			return m.State, m.Reason, true
		}
	}
	return "", "", false
}

func (h *harness) wantMachine(id, state, reason string) {
	h.t.Helper()
	s, r, ok := h.machine(id)
	if !ok || s != state || r != reason {
		h.t.Fatalf("machine %s: %q/%q (held %v), want %s/%s; logs:\n%s", id, s, r, ok, state, reason, h.logs.String())
	}
}

func (h *harness) lastReport() contract.Report {
	h.t.Helper()
	reps := h.plat.HostSnapshot(h.hostID).Reports
	if len(reps) == 0 {
		h.t.Fatal("no report")
	}
	return reps[len(reps)-1]
}

func reported(r contract.Report, id string) (contract.ObservedMachine, bool) {
	for _, m := range r.Machines {
		if m.MachineID == id {
			return m, true
		}
	}
	return contract.ObservedMachine{}, false
}

const (
	m1 = "3f6b9d2a-8c41-4e7f-b5a0-9d1c2e3f4a5b"
	j1 = "9b2e4f60-1a3c-4d5e-8f70-6b8c0d2e4f61"
	m2 = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
	j2 = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f"
	m3 = "c4d5e6f7-0a1b-4c2d-8e3f-405162738495"
	j3 = "e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7"
)

type configFile = config.File

func tlsConfig(h *harness) *tls.Config {
	return &tls.Config{RootCAs: h.copts.RootCAs, MinVersion: tls.VersionTLS12}
}

// driverTimeout bounds each fake driver call in tests (the hanging-driver tests rely on it).
const driverTimeout = 300 * time.Millisecond

// supervise runs one supervise pass and waits for its driver work.
func (h *harness) supervise() {
	h.a.Supervise(context.Background())
	h.a.Wait()
}

// eventually polls cond until it holds or the deadline passes.
func eventually(t *testing.T, within time.Duration, cond func() bool) bool {
	t.Helper()
	end := time.Now().Add(within)
	for time.Now().Before(end) {
		if cond() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return cond()
}
