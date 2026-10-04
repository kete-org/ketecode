//go:build kvm && linux

// Package kvmtest holds the firecracker driver's acceptance tests on a real KVM host (ADR 0023
// rule 7; plan-overview P4 "On the KVM staging host"). They need root, /dev/kvm, Firecracker and
// its jailer, Kete's guest kernel, the job image (`docker save`), the entrypoint's fake platform
// and the probe (internal/kvmtest/probe), named by environment variables, and they change the
// host: an nftables table, taps, a network namespace `kjhtest` with a veth pair (the "uplink"),
// cgroups. scripts/kvm-test.sh builds everything and runs them; see the module README.
//
//	KVM_FIRECRACKER, KVM_JAILER, KVM_KERNEL, KVM_IMAGE_TAR, KVM_FAKE_PLATFORM, KVM_PROBE
package kvmtest

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/agent"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/firecracker"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/enroll"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostnet"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

const (
	authority = "platform.kete.test" // the entrypoint fake's host: the sealed platform_url equals the agent's origin
	origin    = "https://" + authority
	fakeIP    = "198.51.100.10" // the netns "internet": fake platform, DNS, listeners
	uplinkIP  = "198.51.100.1"
	netns     = "kjhtest"
	pool      = "10.200.0.0/24"
)

// Addresses inside the netns, routed from the host through the uplink: only the host table keeps
// a guest from them.
var forbidden = []string{"10.99.0.10", "100.64.0.10", "169.254.169.254", "192.168.99.10", "172.16.99.10"}

type env struct {
	fc, jailer, kernel, imageTar, fakePlatform, probe string
	kernelSHA                                         string
}

func loadEnv(t *testing.T) env {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("the KVM tests run as root")
	}
	e := env{
		fc: os.Getenv("KVM_FIRECRACKER"), jailer: os.Getenv("KVM_JAILER"), kernel: os.Getenv("KVM_KERNEL"),
		imageTar: os.Getenv("KVM_IMAGE_TAR"), fakePlatform: os.Getenv("KVM_FAKE_PLATFORM"), probe: os.Getenv("KVM_PROBE"),
	}
	for k, v := range map[string]string{"KVM_FIRECRACKER": e.fc, "KVM_JAILER": e.jailer, "KVM_KERNEL": e.kernel, "KVM_IMAGE_TAR": e.imageTar, "KVM_FAKE_PLATFORM": e.fakePlatform, "KVM_PROBE": e.probe} {
		if v == "" {
			t.Fatalf("%s is not set (scripts/kvm-test.sh sets every KVM_* variable)", k)
		}
	}
	sum, err := firecracker.FileSHA256(e.kernel)
	if err != nil {
		t.Fatal(err)
	}
	e.kernelSHA = sum
	return e
}

func sh(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command(args[0], args[1:]...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s: %v: %s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func shQuiet(args ...string) { _ = exec.Command(args[0], args[1:]...).Run() }

// ---------------------------------------------------------------- the netns "internet"

func setupNetns(t *testing.T) {
	t.Helper()
	shQuiet("ip", "netns", "del", netns)
	shQuiet("ip", "link", "del", "ktv0")
	sh(t, "ip", "netns", "add", netns)
	sh(t, "ip", "link", "add", "ktv0", "type", "veth", "peer", "name", "ktv1")
	sh(t, "ip", "link", "set", "ktv1", "netns", netns)
	sh(t, "ip", "addr", "add", uplinkIP+"/24", "dev", "ktv0")
	sh(t, "ip", "link", "set", "ktv0", "up")
	sh(t, "ip", "-n", netns, "addr", "add", fakeIP+"/24", "dev", "ktv1")
	for _, a := range forbidden {
		sh(t, "ip", "-n", netns, "addr", "add", a+"/32", "dev", "ktv1")
		sh(t, "ip", "route", "replace", a+"/32", "via", fakeIP, "dev", "ktv0")
	}
	sh(t, "ip", "-n", netns, "link", "set", "ktv1", "up")
	sh(t, "ip", "-n", netns, "link", "set", "lo", "up")
	sh(t, "ip", "-n", netns, "route", "add", "default", "via", uplinkIP)
	t.Cleanup(func() {
		for _, a := range forbidden {
			shQuiet("ip", "route", "del", a+"/32")
		}
		shQuiet("ip", "netns", "del", netns)
		shQuiet("ip", "link", "del", "ktv0")
	})
}

// inNetns runs f on an OS thread switched into the netns (sockets made there stay there).
func inNetns(t *testing.T, f func() error) {
	t.Helper()
	errc := make(chan error, 1)
	go func() {
		runtime.LockOSThread() // never unlocked: the thread dies with the goroutine
		fd, err := unix.Open("/run/netns/"+netns, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			errc <- err
			return
		}
		defer unix.Close(fd)
		if err := unix.Setns(fd, unix.CLONE_NEWNET); err != nil {
			errc <- err
			return
		}
		errc <- f()
	}()
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
}

// listenEverything opens TCP listeners (443, 80) on every netns address and UDP echoes on
// fakeIP:53 and :5353, plus host-side TCP 443 on all addresses: targets that answer if anything lets a
// guest through.
func listenEverything(t *testing.T) {
	t.Helper()
	var closers []io.Closer
	accept := func(l net.Listener) {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}
	inNetns(t, func() error {
		for _, a := range append([]string{fakeIP}, forbidden...) {
			for _, p := range []string{"443", "80"} {
				l, err := net.Listen("tcp4", net.JoinHostPort(a, p))
				if err != nil {
					return err
				}
				closers = append(closers, l)
				go accept(l)
			}
		}
		for _, port := range []string{"53", "5353"} { // UDP echo: an answer proves the path is open
			u, err := net.ListenPacket("udp4", net.JoinHostPort(fakeIP, port))
			if err != nil {
				return err
			}
			closers = append(closers, u)
			go func() {
				buf := make([]byte, 512)
				for {
					n, from, err := u.ReadFrom(buf)
					if err != nil {
						return
					}
					_, _ = u.WriteTo(buf[:n], from)
				}
			}()
		}
		return nil
	})
	hl, err := net.Listen("tcp4", "0.0.0.0:443")
	if err != nil {
		t.Fatalf("host listener: %v", err)
	}
	closers = append(closers, hl)
	go accept(hl)
	t.Cleanup(func() {
		for _, c := range closers {
			c.Close()
		}
	})
}

// ---------------------------------------------------------------- images

type images struct {
	host string
	base v1.Image
}

func startRegistry(t *testing.T, e env) *images {
	t.Helper()
	srv := httptest.NewServer(registry.New(registry.Logger(log.New(io.Discard, "", 0))))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	base, err := tarball.ImageFromPath(e.imageTar, nil)
	if err != nil {
		t.Fatal(err)
	}
	return &images{host: u.Host, base: base}
}

// push wraps img (the base plus extra files) in an index for this architecture and returns the
// index reference.
func (im *images) push(t *testing.T, repo string, files map[string]fileSpec) string {
	t.Helper()
	img := im.base
	if len(files) > 0 {
		l, err := tarLayer(files)
		if err != nil {
			t.Fatal(err)
		}
		if img, err = mutate.AppendLayers(img, l); err != nil {
			t.Fatal(err)
		}
	}
	idx := mutate.AppendManifests(empty.Index, mutate.IndexAddendum{Add: img, Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: runtime.GOARCH}}})
	ref, err := name.ParseReference(im.host+"/kete-org/"+repo+":test", name.Insecure)
	if err != nil {
		t.Fatal(err)
	}
	if err := remote.WriteIndex(ref, idx); err != nil {
		t.Fatal(err)
	}
	d, _ := idx.Digest()
	return im.host + "/kete-org/" + repo + "@" + d.String()
}

type fileSpec struct {
	data []byte
	mode int64
}

func tarLayer(files map[string]fileSpec) (v1.Layer, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for n, f := range files {
		if err := tw.WriteHeader(&tar.Header{Name: n, Typeflag: tar.TypeReg, Mode: f.mode, Size: int64(len(f.data))}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(f.data); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	b := buf.Bytes()
	return tarball.LayerFromOpener(func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil })
}

// baseFile reads one file of the flattened base image.
func (im *images) baseFile(t *testing.T, path string) []byte {
	t.Helper()
	rc := mutate.Extract(im.base)
	defer rc.Close()
	tr := tar.NewReader(rc)
	for {
		h, err := tr.Next()
		if err != nil {
			t.Fatalf("%s not in the image: %v", path, err)
		}
		if strings.TrimPrefix(h.Name, "/") == path {
			b, err := io.ReadAll(tr)
			if err != nil {
				t.Fatal(err)
			}
			return b
		}
	}
}

type probeCfg struct {
	Listen      []string      `json:"listen"`
	WaitSecs    int           `json:"wait_secs"`
	ListenSecs  int           `json:"listen_secs"`
	SleepAfter  bool          `json:"sleep_after"`
	Targets     []probeTarget `json:"targets"`
	TimeoutSecs int           `json:"timeout_secs"`
}

type probeTarget struct {
	Name  string `json:"name"`
	Net   string `json:"net"`
	Addr  string `json:"addr"`
	Query string `json:"query,omitempty"`
}

func (im *images) probeImage(t *testing.T, e env, c probeCfg) string {
	t.Helper()
	bin, err := os.ReadFile(e.probe)
	if err != nil {
		t.Fatal(err)
	}
	cj, _ := json.Marshal(c)
	return im.push(t, "kete-probe", map[string]fileSpec{
		"usr/local/libexec/kete/kete-job-entrypoint": {bin, 0o755},
		"etc/kete-probe.json":                        {cj, 0o644},
	})
}

// ---------------------------------------------------------------- agent and driver

type host struct {
	t      *testing.T
	e      env
	cfg    config.Config
	plat   *fakeplatform.Platform
	copts  client.Options
	hostID string
	drv    *firecracker.Driver
	clock  *offsetClock
	logs   *syncBuffer
	cancel context.CancelFunc
	done   chan error
	a      *agent.Agent
}

type offsetClock struct{ off atomic.Int64 }

func (c *offsetClock) Now() time.Time        { return time.Now().Add(time.Duration(c.off.Load())) }
func (c *offsetClock) Skip(d time.Duration)  { c.off.Add(int64(d)) }
func (c *offsetClock) Synced() (bool, error) { return true, nil }

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

type allowAll struct{}

// The KVM tests' images are built locally and carry no release signature; the sigstore verifier
// is covered by internal/image's tests against a real cosign bundle.
func (allowAll) Verify(context.Context, string) error { return nil }

func newHost(t *testing.T, e env, im *images, allow []string) *host {
	t.Helper()
	state := filepath.Join(testroot.Dir(t), "state")
	f := config.File{
		PlatformURL: origin, Driver: contract.DriverFirecracker, Slots: 2, Reset: contract.ResetNone, StateDir: state,
		Resolvers: []string{fakeIP}, ImageAllowlist: allow, KernelAllowlist: []string{e.kernelSHA},
		Firecracker: &config.FirecrackerFile{
			FirecrackerBin: e.fc, JailerBin: e.jailer, Kernel: e.kernel, GuestNetwork: pool, Uplink: "ktv0", MinFreeGiB: 1,
		},
	}
	f.Versions.Firecracker, f.Versions.GuestKernel = "1.17.0", "6.18.55-kete.1"
	raw, _ := json.Marshal(f)
	cfg, err := config.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	h := &host{t: t, e: e, cfg: cfg, clock: &offsetClock{}, logs: &syncBuffer{}}
	h.plat = fakeplatform.New(authority, h.clock.Now)
	srv, copts, err := fakeplatform.StartTLS(h.plat)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	h.copts = copts
	token := "kete_jhe_" + strings.Repeat("k", 42) + "A"
	h.plat.AddToken(token)
	st, err := enroll.Run(context.Background(), enroll.Options{
		Config: cfg, Client: h.client(), Token: strings.NewReader(token + "\n"), Out: io.Discard, Log: h.log(),
		Facts: contract.Facts{Arch: runtime.GOARCH, Driver: cfg.Driver, Slots: cfg.Slots, KVM: true, Reset: cfg.Reset, Versions: h.versions()},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.hostID = st.HostID
	h.plat.SetStatus(h.hostID, "active")
	return h
}

func (h *host) log() *slog.Logger {
	return slog.New(slog.NewJSONHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func (h *host) client() *client.Client { return client.New(origin, authority, h.clock.Now, h.copts) }

func (h *host) versions() contract.Versions {
	return contract.Versions{Agent: "0.0.0-kvmtest", HostKernel: "6.8.0-kvmtest", Firecracker: "1.17.0", GuestKernel: "6.18.55-kete.1"}
}

func (h *host) newDriver(t *testing.T) *firecracker.Driver {
	t.Helper()
	store := &image.Store{Dir: filepath.Join(h.cfg.StateDir, "images"), Arch: runtime.GOARCH, Name: []name.Option{name.Insecure}}
	d, err := firecracker.New(firecracker.Options{Config: h.cfg, Images: store, Log: h.log(), CheckEvery: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// start runs a fresh driver and agent (as the service would after a restart).
func (h *host) start() {
	h.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h.drv = h.newDriver(h.t)
	if err := h.drv.Init(ctx); err != nil {
		h.t.Fatal(err)
	}
	k, err := keys.Load(keys.Dir(h.cfg.StateDir))
	if err != nil {
		h.t.Fatal(err)
	}
	h.a, err = agent.New(agent.Options{
		Config: h.cfg, Keys: k, Driver: h.drv, Verifier: allowAll{}, Client: h.client(), Clock: h.clock,
		Versions: h.versions(), Log: h.log(), Now: h.clock.Now,
		Interval:       func(s int) time.Duration { return time.Duration(s) * 100 * time.Millisecond },
		SuperviseEvery: 500 * time.Millisecond, IsolationEvery: time.Second,
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.cancel, h.done = cancel, make(chan error, 1)
	go func() { h.done <- h.a.Run(ctx) }()
}

// stopAgent ends the agent the way systemd does (its VMs keep running).
func (h *host) stopAgent() {
	h.t.Helper()
	h.cancel()
	select {
	case <-h.done:
	case <-time.After(2 * time.Minute):
		h.t.Fatal("agent didn't stop")
	}
}

func (h *host) assign(machineID, ref string, deadline time.Duration, cfg seal.MachineConfig, res contract.Resources) {
	h.t.Helper()
	err := h.plat.Assign(h.hostID, contract.RunMachine{
		MachineID: machineID, JobID: cfg.JobID, Image: ref, Deadline: contract.FormatTime(h.clock.Now().Add(deadline)), Resources: res,
	}, cfg)
	if err != nil {
		h.t.Fatal(err)
	}
}

func (h *host) machine(id string) fakeplatform.Machine {
	snap := h.plat.HostSnapshot(h.hostID)
	if m := snap.Machines[id]; m != nil {
		return *m
	}
	return fakeplatform.Machine{}
}

// waitRunning waits for a machine to be reported running and fails at once if it ends instead.
func (h *host) waitRunning(id string) {
	h.t.Helper()
	h.waitFor("running "+id, 5*time.Minute, func() bool {
		m := h.machine(id)
		if m.Terminal {
			h.t.Fatalf("machine %s ended: %s %s", id, m.Observed, m.ObservedReason)
		}
		return m.Observed == contract.StateRunning
	})
}

func (h *host) waitFor(what string, within time.Duration, cond func() bool) {
	h.t.Helper()
	end := time.Now().Add(within)
	for time.Now().Before(end) {
		if cond() {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	var keep []string
	for _, l := range strings.Split(h.logs.String(), "\n") {
		if !strings.Contains(l, "poll_applied") {
			keep = append(keep, l)
		}
	}
	h.t.Fatalf("timed out waiting for %s; agent log tail:\n%s", what, tail(strings.Join(keep, "\n"), 8000))
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

func hasPhase(m fakeplatform.Machine, step, event string) bool {
	for _, l := range m.PhaseLines {
		if l.Step == step && l.Event == event {
			return true
		}
	}
	return false
}

func phaseSummary(m fakeplatform.Machine) string {
	var b strings.Builder
	for _, l := range m.PhaseLines {
		fmt.Fprintf(&b, "%s %s %s %s\n", l.Step, l.Event, l.Code, l.Class)
	}
	return b.String()
}

func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func probeConfig(jobID string) seal.MachineConfig {
	return seal.MachineConfig{
		JobID: jobID, PlatformURL: origin, ClaimToken: strings.Repeat("c0ffee", 10) + "c0ff",
		StorageHost: "storage.kete.test", HostProfile: seal.ProfileMicroVM,
	}
}

// assertClean checks nothing of any VM is left: no tap, jail, record, cgroup or VMM process.
func assertClean(t *testing.T, cfg config.Config) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var left []string
		if taps, _ := hostnet.Taps(); len(taps) > 0 {
			left = append(left, "taps "+strings.Join(taps, ","))
		}
		for _, dir := range []string{filepath.Join(cfg.StateDir, "vms"), filepath.Join(cfg.StateDir, "jail", "firecracker"), filepath.Join("/sys/fs/cgroup", firecracker.ParentCgroup)} {
			ents, _ := os.ReadDir(dir)
			for _, e := range ents {
				if e.IsDir() {
					left = append(left, filepath.Join(dir, e.Name()))
				}
			}
		}
		if out, _ := exec.Command("pgrep", "-x", "firecracker").Output(); len(bytes.TrimSpace(out)) > 0 {
			left = append(left, "firecracker processes "+strings.Fields(string(out))[0])
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

var small = contract.Resources{VCPUs: 1, MemoryMiB: 512, ScratchGiB: 1}

// ---------------------------------------------------------------- tests

// TestGuestIsolation (AC8): two concurrent guests, each guest root with no in-guest firewall,
// probe the host, each other, private/special ranges, metadata and IPv6, plus the allowed paths.
func TestGuestIsolation(t *testing.T) {
	e := loadEnv(t)
	setupNetns(t)
	listenEverything(t)
	im := startRegistry(t, e)
	targets := []probeTarget{
		{Name: "diag storm", Net: "storm", Addr: "GATEWAY"},
		{Name: "allowed tcp 443", Net: "tcp", Addr: fakeIP + ":443"},
		{Name: "allowed loopback (control)", Net: "tcp", Addr: "127.0.0.1:443"},
		{Name: "allowed udp 53 to the resolver", Net: "udp", Addr: fakeIP + ":53"},
		{Name: "tcp 80 out", Net: "tcp", Addr: fakeIP + ":80"},
		{Name: "udp 5353 to resolver", Net: "udp", Addr: fakeIP + ":5353"},
		{Name: "host gateway tcp 443", Net: "tcp", Addr: "GATEWAY:443"},
		{Name: "host gateway tcp 22", Net: "tcp", Addr: "GATEWAY:22"},
		{Name: "host gateway icmp", Net: "icmp", Addr: "GATEWAY"},
		{Name: "host uplink address tcp 443", Net: "tcp", Addr: uplinkIP + ":443"},
		{Name: "other guest tcp 443 (slot 0)", Net: "tcp", Addr: "10.200.0.2:443"},
		{Name: "other guest tcp 443 (slot 1)", Net: "tcp", Addr: "10.200.0.6:443"},
		{Name: "ipv6 global", Net: "tcp6", Addr: "[2606:4700:4700::1111]:443"},
		{Name: "ipv6 link-local gateway", Net: "tcp6", Addr: "[fe80::1%eth0]:443"},
	}
	for _, a := range forbidden {
		port := "443"
		if a == "169.254.169.254" {
			port = "80"
		}
		targets = append(targets, probeTarget{Name: "forbidden " + a, Net: "tcp", Addr: net.JoinHostPort(a, port)})
	}
	ref := im.probeImage(t, e, probeCfg{Listen: []string{":443"}, WaitSecs: 20, ListenSecs: 15, Targets: targets, TimeoutSecs: 3})
	h := newHost(t, e, im, []string{ref})
	d := h.newDriver(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := d.Init(ctx); err != nil {
		t.Fatal(err)
	}
	if b := d.StartsBlocked(); b != "" {
		t.Fatalf("starts blocked: %s; log:\n%s", b, h.logs.String())
	}
	if err := d.Prepare(ctx, ref); err != nil {
		t.Fatal(err)
	}
	ids := []string{uuid(), uuid()}
	for _, id := range ids {
		cfg, _ := probeConfig(uuid()).Canonical()
		if err := d.Start(ctx, driver.Spec{MachineID: id, JobID: uuid(), Image: ref, Deadline: time.Now().Add(time.Hour), Resources: small, Config: cfg}); err != nil {
			_ = d.Stop(ctx, id)
			t.Fatalf("start: %v", err)
		}
		// The config disk is gone from the host once the VM holds it, and its tmpfs is unmounted.
		cfgDir := filepath.Join(h.cfg.StateDir, "jail", "firecracker", id, "root", "cfg")
		if _, err := os.Stat(filepath.Join(cfgDir, "config.img")); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("config disk still on the host: %v", err)
		}
		if mounts, _ := os.ReadFile("/proc/self/mountinfo"); strings.Contains(string(mounts), cfgDir) {
			t.Error("the config tmpfs is still mounted on the host")
		}
	}
	results := map[string]map[string]string{}
	end := time.Now().Add(3 * time.Minute)
	var raw strings.Builder
	for time.Now().Before(end) && (len(results[ids[0]]) == 0 || results[ids[0]]["done"] == "" || results[ids[1]]["done"] == "") {
		for _, id := range ids {
			lines, err := d.Logs(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			for _, l := range lines {
				fmt.Fprintf(&raw, "%s: %s\n", id[:8], l)
				s, ok := strings.CutPrefix(string(l), "KPROBE ")
				if !ok {
					continue
				}
				var r map[string]string
				if json.Unmarshal([]byte(s), &r) == nil {
					if results[id] == nil {
						results[id] = map[string]string{}
					}
					results[id][r["name"]] = r["result"]
				}
			}
		}
		time.Sleep(time.Second)
	}
	t.Logf("console:\n%s", tail(raw.String(), 12000))
	for _, id := range ids {
		r := results[id]
		if r["done"] != "ok" {
			t.Fatalf("probe in %s didn't finish: %v", id, r)
		}
		if r["self"] == "" {
			t.Errorf("%s: no self line", id)
		}
		for name, got := range r {
			switch {
			case name == "self" || name == "done" || name == "accepted" || strings.HasPrefix(name, "diag "):
				t.Logf("%s: %s = %s", id[:8], name, got)
			case strings.HasPrefix(name, "allowed "):
				if got != "open" {
					t.Errorf("%s: %s = %s, want open", id[:8], name, got)
				}
			default:
				if got != "blocked" {
					t.Errorf("%s: %s = %s, want blocked", id[:8], name, got)
				}
			}
		}
		if r["accepted"] != "" && !strings.HasPrefix(r["accepted"], "127.0.0.1:") {
			t.Errorf("%s accepted a connection from %s (guest to guest)", id[:8], r["accepted"])
		}
	}
	// The guests power off by themselves: exited.
	for _, id := range ids {
		h.waitFor("exit of "+id, 2*time.Minute, func() bool { s, _ := d.Status(ctx, id); return s == driver.StatusExited })
		if err := d.Stop(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	assertClean(t, h.cfg)
}

// TestRealJob (AC7): the real job image (plus the fake's test CA) under the agent and the driver
// reaches setup_host, host_boundary, isolation and claim against the entrypoint's fake platform.
func TestRealJob(t *testing.T) {
	e := loadEnv(t)
	setupNetns(t)
	im := startRegistry(t, e)
	state := t.TempDir()
	fake := exec.Command("ip", "netns", "exec", netns, e.fakePlatform, "-addr", fakeIP, "-state", state, "-scenario", "lifecycle")
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
		b, err := os.ReadFile(filepath.Join(state, "config.json"))
		if err == nil && json.Unmarshal(b, &jc) == nil {
			break
		}
		if time.Now().After(end) {
			t.Fatalf("fake platform didn't start: %s", fakeOut.String())
		}
		time.Sleep(200 * time.Millisecond)
	}
	ca, err := os.ReadFile(filepath.Join(state, "ca.pem"))
	if err != nil {
		t.Fatal(err)
	}
	bundle := append(im.baseFile(t, "etc/ssl/certs/ca-certificates.crt"), ca...)
	files := map[string]fileSpec{"etc/ssl/certs/ca-certificates.crt": {bundle, 0o644}}
	// KVM_ENTRYPOINT: run this checkout's entrypoint instead of the image's (no image rebuild).
	if ep := os.Getenv("KVM_ENTRYPOINT"); ep != "" {
		b, err := os.ReadFile(ep)
		if err != nil {
			t.Fatal(err)
		}
		files["usr/local/libexec/kete/kete-job-entrypoint"] = fileSpec{b, 0o755}
	}
	ref := im.push(t, "kete-job", files)

	h := newHost(t, e, im, []string{ref})
	h.start()
	defer h.stopAgent()
	id := uuid()
	h.assign(id, ref, 30*time.Minute, seal.MachineConfig{
		JobID: jc.JobID, PlatformURL: jc.PlatformURL, ClaimToken: jc.ClaimToken, StorageHost: jc.StorageHost, HostProfile: seal.ProfileMicroVM,
	}, contract.Resources{VCPUs: 4, MemoryMiB: 3072, ScratchGiB: 4})
	var console []byte // the raw serial console, kept for a failure report (the driver deletes it on stop)
	h.waitFor("claim ok", 8*time.Minute, func() bool {
		if b, err := os.ReadFile(filepath.Join(h.cfg.StateDir, "vms", id, "console.log")); err == nil && len(b) > 0 {
			console = b
		}
		m := h.machine(id)
		if m.Terminal {
			t.Fatalf("machine ended early (%s %s); phases:\n%s\nconsole:\n%s", m.Observed, m.ObservedReason, phaseSummary(m), tail(string(console), 6000))
		}
		return hasPhase(m, "claim", "ok")
	})
	m := h.machine(id)
	for _, step := range []string{"init_root", "init_network", "init_config", "setup_host", "host_boundary", "isolation", "claim"} {
		if !hasPhase(m, step, "ok") {
			t.Errorf("no %s ok; phases:\n%s", step, phaseSummary(m))
		}
	}
	t.Logf("phases:\n%s", phaseSummary(m))
	// Let the job run on for a while (it may finish against the fake), then withdraw it.
	h.waitFor("job end or 6 min", 7*time.Minute, func() bool {
		m := h.machine(id)
		return m.Terminal || hasPhase(m, "finish", "ok") || time.Since(end) > 6*time.Minute
	})
	t.Logf("phases at the end:\n%s\nfake platform:\n%s", phaseSummary(h.machine(id)), tail(fakeOut.String(), 2000))
	h.plat.Withdraw(h.hostID, id)
	h.waitFor("destroyed", 3*time.Minute, func() bool { return h.machine(id).Terminal })
	assertClean(t, h.cfg)
}

// TestLifecycle (AC9): deadline killer, agent restart re-adoption, stop cleanup, and a deleted
// host table blocking starts.
func TestLifecycle(t *testing.T) {
	e := loadEnv(t)
	setupNetns(t)
	im := startRegistry(t, e)
	ref := im.probeImage(t, e, probeCfg{WaitSecs: 1, SleepAfter: true, TimeoutSecs: 1})
	h := newHost(t, e, im, []string{ref})
	h.start()

	// A guest that never exits, re-adopted across an agent restart.
	a := uuid()
	h.assign(a, ref, 20*time.Minute, probeConfig(uuid()), small)
	h.waitRunning(a)
	pidBefore := vmPID(t, h.cfg, a)
	checkJail(t, h.cfg, a, pidBefore)
	h.stopAgent()
	if !alive(pidBefore) {
		t.Fatal("stopping the agent killed the VM")
	}
	h.start()
	time.Sleep(5 * time.Second)
	if got := h.a.Snapshot(); len(got.Machines) == 0 || got.Machines[0].State != contract.StateRunning {
		t.Fatalf("not re-adopted: %+v", got.Machines)
	}
	if vmPID(t, h.cfg, a) != pidBefore || !alive(pidBefore) {
		t.Fatal("restart replaced or killed the VM")
	}
	// Deadline killer: past deadline + 5 min, without the platform.
	h.plat.SetUnreachable(true)
	h.clock.Skip(26 * time.Minute)
	h.waitFor("deadline kill", 2*time.Minute, func() bool { return !alive(pidBefore) })
	h.plat.SetUnreachable(false)
	h.waitFor("reported destroyed", 2*time.Minute, func() bool {
		m := h.machine(a)
		return m.Terminal && m.ObservedReason == contract.ReasonDeadline
	})
	assertClean(t, h.cfg)

	// A desired-state destroy (kill) cleans up too.
	b := uuid()
	h.assign(b, ref, 60*time.Minute, probeConfig(uuid()), small)
	h.waitRunning(b)
	h.plat.Withdraw(h.hostID, b)
	h.waitFor("destroyed", 2*time.Minute, func() bool { return h.machine(b).Terminal })
	assertClean(t, h.cfg)

	// The host table deleted by hand while a VM runs: fail closed — the VM is destroyed
	// (host_isolation_lost) without the platform, starts block (host_table) and nothing is left.
	c := uuid()
	h.assign(c, ref, 60*time.Minute, probeConfig(uuid()), small)
	h.waitRunning(c)
	pidC := vmPID(t, h.cfg, c)
	h.plat.SetUnreachable(true)
	sh(t, "nft", "delete", "table", "inet", hostnet.TableName)
	h.waitFor("VM destroyed after the table vanished", 30*time.Second, func() bool { return !alive(pidC) })
	assertClean(t, h.cfg)
	h.plat.SetUnreachable(false)
	h.waitFor("reported host_isolation_lost and starts_blocked host_table", time.Minute, func() bool {
		m := h.machine(c)
		r := h.plat.HostSnapshot(h.hostID).Reports
		return m.Terminal && m.ObservedReason == contract.ReasonHostIsolationLost && hasPhase(m, "host_isolation", "failed") &&
			len(r) > 0 && r[len(r)-1].StartsBlocked != nil && *r[len(r)-1].StartsBlocked == contract.BlockedHostTable
	})
	d := uuid()
	h.assign(d, ref, 60*time.Minute, probeConfig(uuid()), small)
	h.waitFor("starts_blocked failure", time.Minute, func() bool {
		m := h.machine(d)
		return m.Terminal && m.ObservedReason == contract.ReasonStartsBlocked
	})
	h.stopAgent()
	assertClean(t, h.cfg)
}

func vmPID(t *testing.T, cfg config.Config, id string) int {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(cfg.StateDir, "vms", id, "vm.json"))
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		PID int `json:"pid"`
	}
	if err := json.Unmarshal(b, &s); err != nil || s.PID < 2 {
		t.Fatalf("vm.json pid: %v %d", err, s.PID)
	}
	return s.PID
}

func alive(pid int) bool { return unix.Kill(pid, 0) == nil }

// checkJail confirms the jailer's confinement of a running VMM: its own uid and gid (not root),
// seccomp in filter mode, no capabilities, its own PID namespace, and the cgroup limits of the
// job size (small: 1 vCPU, 512 MiB + the 256 MiB VMM overhead).
func checkJail(t *testing.T, cfg config.Config, id string, pid int) {
	t.Helper()
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		t.Fatal(err)
	}
	fields := map[string]string{}
	for _, l := range strings.Split(string(status), "\n") {
		if k, v, ok := strings.Cut(l, ":"); ok {
			fields[k] = strings.TrimSpace(v)
		}
	}
	uid := fmt.Sprint(cfg.FC.UIDBase) // slot 0
	if f := strings.Fields(fields["Uid"]); len(f) < 4 || f[0] != uid || f[1] != uid || f[2] != uid || f[3] != uid {
		t.Errorf("VMM uids %q, want %s", fields["Uid"], uid)
	}
	if f := strings.Fields(fields["Gid"]); len(f) < 1 || f[0] != uid {
		t.Errorf("VMM gids %q", fields["Gid"])
	}
	if fields["Seccomp"] != "2" {
		t.Errorf("VMM seccomp mode %q, want 2 (filter)", fields["Seccomp"])
	}
	if fields["CapEff"] != "0000000000000000" {
		t.Errorf("VMM effective capabilities %s", fields["CapEff"])
	}
	if f := strings.Fields(fields["NSpid"]); len(f) != 2 || f[1] != "1" {
		t.Errorf("VMM NSpid %q, want its own PID namespace", fields["NSpid"])
	}
	cg := filepath.Join("/sys/fs/cgroup", firecracker.ParentCgroup, id)
	for file, want := range map[string]string{"memory.max": fmt.Sprint(int64(512+256) << 20), "cpu.max": "100000 100000", "pids.max": "256"} {
		b, err := os.ReadFile(filepath.Join(cg, file))
		if err != nil || strings.TrimSpace(string(b)) != want {
			t.Errorf("%s = %q (%v), want %s", file, strings.TrimSpace(string(b)), err, want)
		}
	}
}
