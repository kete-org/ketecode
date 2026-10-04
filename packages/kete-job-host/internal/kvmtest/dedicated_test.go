//go:build kvm && linux

package kvmtest

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/dedicated"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/enroll"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostnet"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

// TestMain lets this test binary serve as the dedicated driver's reaper (the agent re-executes
// its own binary with dedicated.InitArg; here that binary is kvm.test).
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == dedicated.InitArg {
		os.Exit(dedicated.RunInit())
	}
	os.Exit(m.Run())
}

const dedicatedGeneration = "g-kvmtest-ded-1"

// newDedicatedHost enrolls a dedicated host (R1 declared; the test approves it by hand) whose job
// network leaves through the netns "uplink".
func newDedicatedHost(t *testing.T, allow []string) *host {
	t.Helper()
	state := filepath.Join(testroot.Dir(t), "state")
	f := config.File{
		PlatformURL: origin, Driver: contract.DriverDedicated, Slots: 1, Reset: contract.ResetProviderRebuild, Generation: dedicatedGeneration,
		StateDir: state, Resolvers: []string{fakeIP}, ImageAllowlist: allow,
		Dedicated: &config.DedicatedFile{GuestNetwork: "10.200.0.0/30", Uplink: "ktv0", MinFreeGiB: 1},
	}
	raw, _ := json.Marshal(f)
	cfg, err := config.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	h := &host{t: t, cfg: cfg, clock: &offsetClock{}, logs: &syncBuffer{}}
	h.plat = fakeplatform.New(authority, h.clock.Now)
	srv, copts, err := fakeplatform.StartTLS(h.plat)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	h.copts = copts
	token := "kete_jhe_" + strings.Repeat("d", 42) + "A"
	h.plat.AddToken(token)
	st, err := enroll.Run(context.Background(), enroll.Options{
		Config: cfg, Client: h.client(), Token: strings.NewReader(token + "\n"), Out: io.Discard, Log: h.log(),
		Facts: contract.Facts{Arch: runtime.GOARCH, Driver: cfg.Driver, Slots: 1, KVM: false, Reset: cfg.Reset, Versions: dedicatedVersions()},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.hostID = st.HostID
	h.plat.SetStatus(h.hostID, "active")
	return h
}

func dedicatedVersions() contract.Versions {
	return contract.Versions{Agent: "0.0.0-kvmtest", HostKernel: "6.8.0-kvmtest"}
}

// startDedicated runs the dedicated driver and the agent.
func (h *host) startDedicated() *dedicated.Driver {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	self, err := os.Executable()
	if err != nil {
		h.t.Fatal(err)
	}
	store := &image.Store{Dir: filepath.Join(h.cfg.StateDir, "images"), Arch: runtime.GOARCH, Name: []name.Option{name.Insecure}}
	drv, err := dedicated.New(dedicated.Options{Config: h.cfg, Images: store, Log: h.log(), Self: self, CheckEvery: time.Second})
	if err != nil {
		h.t.Fatal(err)
	}
	if err := drv.Init(ctx); err != nil {
		h.t.Fatal(err)
	}
	k, err := keys.Load(keys.Dir(h.cfg.StateDir))
	if err != nil {
		h.t.Fatal(err)
	}
	h.a, err = agent.New(agent.Options{
		Config: h.cfg, Keys: k, Driver: drv, Verifier: allowAll{}, Client: h.client(), Clock: h.clock,
		Versions: dedicatedVersions(), Log: h.log(), Now: h.clock.Now,
		Interval:       func(s int) time.Duration { return time.Duration(s) * 100 * time.Millisecond },
		SuperviseEvery: 500 * time.Millisecond, IsolationEvery: time.Second,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.cancel, h.done = cancel, make(chan error, 1)
	go func() { h.done <- h.a.Run(ctx) }()
	return drv
}

// assertDedicatedClean: no machine directory, cgroup, veth, mount, loop device or reaper left.
func assertDedicatedClean(t *testing.T, cfg config.Config) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var left []string
		if taps, _ := hostnet.Taps(); len(taps) > 0 {
			left = append(left, "veths "+strings.Join(taps, ","))
		}
		for _, dir := range []string{filepath.Join(cfg.StateDir, "dedicated"), filepath.Join("/sys/fs/cgroup", dedicated.ParentCgroup)} {
			ents, _ := os.ReadDir(dir)
			for _, e := range ents {
				if e.IsDir() {
					left = append(left, filepath.Join(dir, e.Name()))
				}
			}
		}
		if mi, _ := os.ReadFile("/proc/self/mountinfo"); strings.Contains(string(mi), filepath.Join(cfg.StateDir, "dedicated")+"/") {
			left = append(left, "mounts under the machines directory")
		}
		if out, _ := exec.Command("losetup", "-a").Output(); strings.Contains(string(out), cfg.StateDir) {
			left = append(left, "loop devices "+strings.TrimSpace(string(out)))
		}
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("residue after stop: %s", strings.Join(left, "; "))
		}
		time.Sleep(time.Second)
	}
}

// TestDedicatedRealJob (P5 AC7): the real job image under the dedicated driver, from the agent,
// reaches setup_host, host_boundary (the host table holds for the veth: the gateway, metadata and
// private ranges don't answer), isolation and claim against the entrypoint's fake platform. The
// generation is then spent: a second assignment is refused `starts_blocked` and the report says
// `generation_spent`. Withdrawing the job leaves nothing behind.
func TestDedicatedRealJob(t *testing.T) {
	imageTar, fakePlatform := os.Getenv("KVM_IMAGE_TAR"), os.Getenv("KVM_FAKE_PLATFORM")
	if os.Geteuid() != 0 || imageTar == "" || fakePlatform == "" {
		t.Fatal("run as root with KVM_IMAGE_TAR and KVM_FAKE_PLATFORM (scripts/kvm-test.sh)")
	}
	setupNetns(t)
	im := startRegistry(t, env{imageTar: imageTar})
	fstate := t.TempDir()
	fake := exec.Command("ip", "netns", "exec", netns, fakePlatform, "-addr", fakeIP, "-state", fstate, "-scenario", "lifecycle")
	fakeOut := &syncBuffer{}
	fake.Stdout, fake.Stderr = fakeOut, fakeOut
	if err := fake.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fake.Process.Signal(unix.SIGTERM); _ = fake.Wait() })
	var jc struct {
		JobID       string `json:"job_id"`
		PlatformURL string `json:"platform_url"`
		ClaimToken  string `json:"claim_token"`
		StorageHost string `json:"storage_host"`
	}
	end := time.Now().Add(30 * time.Second)
	for {
		b, err := os.ReadFile(filepath.Join(fstate, "config.json"))
		if err == nil && json.Unmarshal(b, &jc) == nil {
			break
		}
		if time.Now().After(end) {
			t.Fatalf("fake platform didn't start: %s", fakeOut.String())
		}
		time.Sleep(200 * time.Millisecond)
	}
	ca, err := os.ReadFile(filepath.Join(fstate, "ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	bundle := append(im.baseFile(t, "etc/ssl/certs/ca-certificates.crt"), ca...)
	files := map[string]fileSpec{"etc/ssl/certs/ca-certificates.crt": {bundle, 0o644}}
	if ep := os.Getenv("KVM_ENTRYPOINT"); ep != "" {
		b, err := os.ReadFile(ep)
		if err != nil {
			t.Fatal(err)
		}
		files["usr/local/libexec/kete/kete-job-entrypoint"] = fileSpec{b, 0o755}
	}
	ref := im.push(t, "kete-job", files)

	h := newDedicatedHost(t, []string{ref})
	h.startDedicated()
	defer h.stopAgent()
	id := uuid()
	h.assign(id, ref, 30*time.Minute, seal.MachineConfig{
		JobID: jc.JobID, PlatformURL: jc.PlatformURL, ClaimToken: jc.ClaimToken, StorageHost: jc.StorageHost,
		HostProfile: seal.ProfileDedicated, HostGeneration: dedicatedGeneration,
	}, contract.Resources{VCPUs: 2, MemoryMiB: 3072, ScratchGiB: 4})
	var console []byte
	h.waitFor("claim ok", 8*time.Minute, func() bool {
		if b, err := os.ReadFile(filepath.Join(h.cfg.StateDir, "dedicated", id, "console.log")); err == nil && len(b) > 0 {
			console = b
		}
		m := h.machine(id)
		if m.Terminal {
			t.Fatalf("machine ended early (%s %s); phases:\n%s\nconsole:\n%s", m.Observed, m.ObservedReason, phaseSummary(m), tail(string(console), 6000))
		}
		return hasPhase(m, "claim", "ok")
	})
	m := h.machine(id)
	for _, step := range []string{"setup_host", "host_boundary", "isolation", "claim"} {
		if !hasPhase(m, step, "ok") {
			t.Errorf("no %s ok; phases:\n%s", step, phaseSummary(m))
		}
	}
	t.Logf("phases:\n%s", phaseSummary(m))

	// One job per generation: the platform's second assignment is refused by the agent.
	snap := h.plat.HostSnapshot(h.hostID)
	last := snap.Reports[len(snap.Reports)-1]
	if last.StartsBlocked == nil || *last.StartsBlocked != contract.BlockedGenerationSpent || last.Slots.Free != 0 {
		t.Errorf("report while the job runs: starts_blocked %v free %d", last.StartsBlocked, last.Slots.Free)
	}
	second := uuid()
	h.assign(second, ref, 30*time.Minute, seal.MachineConfig{
		JobID: uuid(), PlatformURL: jc.PlatformURL, ClaimToken: strings.Repeat("ab", 32), StorageHost: jc.StorageHost,
		HostProfile: seal.ProfileDedicated, HostGeneration: dedicatedGeneration,
	}, small)
	h.waitFor("second assignment refused", time.Minute, func() bool {
		m := h.machine(second)
		return m.Terminal && m.ObservedReason == contract.ReasonStartsBlocked
	})

	// Let the job run on for a while (it may finish against the fake), then withdraw it.
	h.waitFor("job end or 4 min", 5*time.Minute, func() bool {
		m := h.machine(id)
		return m.Terminal || hasPhase(m, "finish", "ok") || time.Since(end) > 4*time.Minute
	})
	t.Logf("phases at the end:\n%s\nfake platform:\n%s", phaseSummary(h.machine(id)), tail(fakeOut.String(), 2000))
	h.plat.Withdraw(h.hostID, id)
	h.waitFor("destroyed", 3*time.Minute, func() bool { return h.machine(id).Terminal })
	assertDedicatedClean(t, h.cfg)
	if got := h.a.Snapshot().GenerationSpentBy; got != id {
		t.Errorf("generation_spent_by %q, want %s", got, id)
	}
}

func reaperPID(t *testing.T, cfg config.Config, id string) int {
	t.Helper()
	var r struct {
		PID int `json:"pid"`
	}
	b, err := os.ReadFile(filepath.Join(cfg.StateDir, "dedicated", id, "job.json"))
	if err != nil || json.Unmarshal(b, &r) != nil || r.PID <= 1 {
		t.Fatalf("job.json of %s: %v %s", id, err, b)
	}
	return r.PID
}

// probeResults reads the probe's KPROBE lines from the machine's console file.
func probeResults(cfg config.Config, id string) map[string]string {
	out := map[string]string{}
	b, _ := os.ReadFile(filepath.Join(cfg.StateDir, "dedicated", id, "console.log"))
	for _, l := range strings.Split(string(b), "\n") {
		s, ok := strings.CutPrefix(l, "KPROBE ")
		if !ok {
			continue
		}
		var r map[string]string
		if json.Unmarshal([]byte(s), &r) == nil {
			out[r["name"]] = r["result"]
		}
	}
	return out
}

// TestDedicatedLifecycle (P5): job root with no firewall at all (the probe replaces the
// entrypoint) reaches only TCP 443 and DNS to the resolver, never the host, private or special
// ranges, metadata or IPv6; the job survives an agent restart and is re-adopted; the deadline
// killer destroys it without the platform; a deleted host table destroys a job
// (host_isolation_lost) and blocks starts. Each job needs a fresh host identity (one job per
// generation), so the second part enrolls a second host.
func TestDedicatedLifecycle(t *testing.T) {
	probe, imageTar := os.Getenv("KVM_PROBE"), os.Getenv("KVM_IMAGE_TAR")
	if os.Geteuid() != 0 || probe == "" || imageTar == "" {
		t.Fatal("run as root with KVM_PROBE and KVM_IMAGE_TAR (scripts/kvm-test.sh)")
	}
	setupNetns(t)
	listenEverything(t)
	im := startRegistry(t, env{imageTar: imageTar})
	targets := []probeTarget{
		{Name: "allowed tcp 443", Net: "tcp", Addr: fakeIP + ":443"},
		{Name: "allowed loopback (control)", Net: "tcp", Addr: "127.0.0.1:443"},
		{Name: "allowed udp 53 to the resolver", Net: "udp", Addr: fakeIP + ":53"},
		{Name: "tcp 80 out", Net: "tcp", Addr: fakeIP + ":80"},
		{Name: "udp 5353 to resolver", Net: "udp", Addr: fakeIP + ":5353"},
		{Name: "host gateway tcp 443", Net: "tcp", Addr: "GATEWAY:443"},
		{Name: "host gateway tcp 22", Net: "tcp", Addr: "GATEWAY:22"},
		{Name: "host gateway icmp", Net: "icmp", Addr: "GATEWAY"},
		{Name: "host uplink address tcp 443", Net: "tcp", Addr: uplinkIP + ":443"},
		{Name: "ipv6 global", Net: "tcp6", Addr: "[2606:4700:4700::1111]:443"},
	}
	for _, a := range forbidden {
		port := "443"
		if a == "169.254.169.254" {
			port = "80"
		}
		targets = append(targets, probeTarget{Name: "forbidden " + a, Net: "tcp", Addr: a + ":" + port})
	}
	ref := im.probeImage(t, env{probe: probe}, probeCfg{Listen: []string{":443"}, WaitSecs: 1, SleepAfter: true, Targets: targets, TimeoutSecs: 3})
	cfgFor := func(jobID string) seal.MachineConfig {
		c := probeConfig(jobID)
		c.HostProfile, c.HostGeneration = seal.ProfileDedicated, dedicatedGeneration
		return c
	}

	h := newDedicatedHost(t, []string{ref})
	h.startDedicated()
	a := uuid()
	h.assign(a, ref, 20*time.Minute, cfgFor(uuid()), small)
	h.waitRunning(a)
	var results map[string]string
	h.waitFor("probe done", 2*time.Minute, func() bool { results = probeResults(h.cfg, a); return results["done"] == "ok" })
	for name, got := range results {
		switch {
		case name == "self" || name == "done" || name == "accepted" || strings.HasPrefix(name, "diag "):
			t.Logf("%s = %s", name, got)
		case strings.HasPrefix(name, "allowed "):
			if got != "open" {
				t.Errorf("%s = %s, want open", name, got)
			}
		default:
			if got != "blocked" {
				t.Errorf("%s = %s, want blocked", name, got)
			}
		}
	}
	pid := reaperPID(t, h.cfg, a)
	h.stopAgent()
	if !alive(pid) {
		t.Fatal("stopping the agent killed the job")
	}
	h.startDedicated()
	time.Sleep(5 * time.Second)
	if got := h.a.Snapshot(); len(got.Machines) == 0 || got.Machines[0].State != contract.StateRunning || got.GenerationSpentBy != a {
		t.Fatalf("not re-adopted: %+v", got)
	}
	if reaperPID(t, h.cfg, a) != pid || !alive(pid) {
		t.Fatal("restart replaced or killed the job")
	}
	h.plat.SetUnreachable(true)
	h.clock.Skip(26 * time.Minute)
	h.waitFor("deadline kill", 2*time.Minute, func() bool { return !alive(pid) })
	h.plat.SetUnreachable(false)
	h.waitFor("reported destroyed (deadline)", 2*time.Minute, func() bool {
		m := h.machine(a)
		return m.Terminal && m.ObservedReason == contract.ReasonDeadline
	})
	assertDedicatedClean(t, h.cfg)
	h.stopAgent()

	// A second host (a new identity, as after a reset): the host table deleted by hand while the
	// job runs destroys it without the platform and blocks starts.
	h2 := newDedicatedHost(t, []string{ref})
	h2.startDedicated()
	defer h2.stopAgent()
	b := uuid()
	h2.assign(b, ref, 60*time.Minute, cfgFor(uuid()), small)
	h2.waitRunning(b)
	pidB := reaperPID(t, h2.cfg, b)
	h2.plat.SetUnreachable(true)
	sh(t, "nft", "delete", "table", "inet", hostnet.TableName)
	h2.waitFor("job destroyed after the table vanished", 30*time.Second, func() bool { return !alive(pidB) })
	assertDedicatedClean(t, h2.cfg)
	h2.plat.SetUnreachable(false)
	h2.waitFor("reported host_isolation_lost and starts_blocked host_table", time.Minute, func() bool {
		m := h2.machine(b)
		r := h2.plat.HostSnapshot(h2.hostID).Reports
		return m.Terminal && m.ObservedReason == contract.ReasonHostIsolationLost &&
			len(r) > 0 && r[len(r)-1].StartsBlocked != nil && *r[len(r)-1].StartsBlocked == contract.BlockedHostTable
	})
}
