//go:build integration && linux

// Package itest runs the entrypoint for real (module README "How to test"): as root, with the real
// users, cgroups, nftables, /proc remount, the real kete-root-helper and kete-egress binaries,
// against the in-process fake platform, with a fake `kete` (internal/itest/fakekete) installed at
// /usr/local/bin/kete. scripts/integration.sh builds and installs the binaries, creates the users,
// and runs this binary inside a fresh network namespace (the firewall never touches the host's or
// the CI runner's network). It never runs in `go test ./...`.
//
// The test binary also serves as the launcher's stage 2 (`__launch`), since in-process runs
// re-execute /proc/self/exe.
package itest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/cgroup"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/entry"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
)

func init() {
	if len(os.Args) >= 2 && os.Args[1] == launch.Arg {
		launch.RunStage2()
	}
	if len(os.Args) == 2 && os.Args[1] == isolation.ProbeArg {
		isolation.RunProbe()
	}
}

const (
	fakeAddr = "198.51.100.10"
	dnsAddr  = "198.51.100.53:53"
	stateDir = "/tmp/kete-entry-it"
)

var (
	FP          *fakeplatform.Server
	cgroupRoot  string // R: this process's cgroup at start
	entrypoint  = "/usr/local/libexec/kete/kete-job-entrypoint"
	removePaths = []string{"/srv/kete-job", "/var/lib/kete-root", "/var/lib/kete-job", "/run/kete-job", "/run/kete-egress", "/run/kete-helper", "/var/log/kete-job"}
)

func TestMain(m *testing.M) {
	if os.Getuid() != 0 {
		fmt.Fprintln(os.Stderr, "the integration suite must run as root (scripts/integration.sh)")
		os.Exit(2)
	}
	var err error
	if cgroupRoot, err = cgroup.Own(); err != nil {
		fmt.Fprintln(os.Stderr, "cgroup:", err)
		os.Exit(2)
	}
	_ = os.RemoveAll(stateDir)
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := writeKernelTree(); err != nil {
		fmt.Fprintln(os.Stderr, "kernel tree:", err)
		os.Exit(2)
	}
	FP, err = fakeplatform.Start(fakeplatform.Config{Addr: fakeAddr, DNSAddr: dnsAddr, StateDir: stateDir, GitHTTPBackend: "/usr/lib/git-core/git-http-backend"})
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake platform:", err)
		os.Exit(2)
	}
	// The fake's test CA goes into the system store before any proxy starts: the proxy verifies
	// upstreams against the system roots, unmodified. (Only test containers ever do this.)
	if err := os.WriteFile("/usr/local/share/ca-certificates/kete-e2e-test.crt", FP.CAPEM, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if out, err := exec.Command("update-ca-certificates").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "update-ca-certificates: %v: %s\n", err, out)
		os.Exit(2)
	}
	code := m.Run()
	FP.Close()
	os.Exit(code)
}

// testConfig is the production layout with test timings.
func testConfig() layout.Config {
	c := layout.Default()
	c.CgroupParent = cgroupRoot
	c.Minute = time.Second
	c.FinalizeReserve = 2 * time.Second
	c.BackstopExtra = time.Second
	c.KillWait = time.Second
	c.ReapTimeout = 3 * time.Second
	c.Heartbeat = time.Second
	c.StopWait = 5 * time.Second
	c.HTTPTimeout = 10 * time.Second
	c.RetryBackoff = 100 * time.Millisecond
	c.ClaimWindow = 5 * time.Second
	// The shared-kernel guard's facts: this suite runs in a privileged container, a shared kernel the
	// guard refuses (TestBinaryBootSharedKernel runs the binary on the real ones). In-process runs
	// present the dedicated reaper's set-up instead; guestTree.apply presents a VM's.
	c.Proc1Cmdline = filepath.Join(kernelTreeDir, "cmdline")
	c.MountInfo = filepath.Join(kernelTreeDir, "mountinfo")
	c.MarkerFiles = []string{filepath.Join(kernelTreeDir, ".dockerenv"), filepath.Join(kernelTreeDir, "run", ".containerenv")}
	c.NSInode = func(name string) (uint64, error) {
		if name == "user" {
			return hostprofile.InitUserNSIno, nil
		}
		return 0xF0000001, nil // a PID namespace of the reaper's
	}
	return c
}

var kernelTreeDir = filepath.Join(stateDir, "kernel")

// writeKernelTree writes the dedicated reaper's PID 1 argv and job mount table (kete-job-host
// internal/driver/dedicated) for testConfig.
func writeKernelTree() error {
	if err := os.MkdirAll(kernelTreeDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(kernelTreeDir, "cmdline"), []byte("/proc/self/exe\x00"+hostprofile.DedicatedInitArg+"\x00"), 0o644); err != nil {
		return err
	}
	mi := "801 640 0:64 / / rw,relatime - overlay overlay rw\n802 801 0:66 / /proc rw,nosuid,nodev,noexec - proc proc rw\n" +
		"807 801 0:71 / /run rw,nosuid,nodev - tmpfs tmpfs rw\n808 801 0:30 / /sys/fs/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup2 rw\n"
	return os.WriteFile(filepath.Join(kernelTreeDir, "mountinfo"), []byte(mi), 0o644)
}

// cleanup removes everything a run leaves: the nft table, the job cgroups (after moving this
// process back out), the directories and any stray job-user process.
func cleanup(t *testing.T) {
	t.Helper()
	_ = exec.Command("nft", "delete", "table", "inet", "kete_egress").Run()
	initDir := filepath.Join(cgroupRoot, "kete-job-init")
	_ = os.MkdirAll(initDir, 0o755)
	if err := cgroup.Join(initDir, os.Getpid()); err != nil {
		t.Errorf("cleanup: move back: %v", err)
	}
	for _, base := range []string{cgroupRoot, filepath.Join(cgroupRoot, "bin-boot")} {
		removeTree(t, filepath.Join(base, "kete-job"))
	}
	removeTree(t, filepath.Join(cgroupRoot, "bin-boot"))
	for _, p := range removePaths {
		_ = os.RemoveAll(p)
	}
}

// removeTree kills every process under dir and removes the cgroups depth-first.
func removeTree(t *testing.T, dir string) {
	if _, err := os.Stat(dir); err != nil {
		return
	}
	_ = cgroup.Kill(dir)
	deadline := time.Now().Add(5 * time.Second)
	for {
		pop, err := cgroup.Populated(dir)
		if err != nil || !pop || time.Now().After(deadline) {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	var dirs []string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			dirs = append(dirs, p)
		}
		return nil
	})
	sort.Sort(sort.Reverse(sort.StringSlice(dirs)))
	for _, d := range dirs {
		if err := os.Remove(d); err != nil {
			t.Errorf("cleanup: rmdir %s: %v", d, err)
		}
	}
}

type run struct {
	job    *fakeplatform.Job
	code   int
	stdout string
	took   time.Duration
}

// runJob runs the entrypoint in-process against a fresh fake job.
func runJob(t *testing.T, k fakeplatform.Knobs, mod func(*layout.Config)) run {
	t.Helper()
	t.Cleanup(func() { cleanup(t) })
	j := FP.NewJob(k)
	if newJobHook != nil {
		newJobHook(j)
	}
	cfg := testConfig()
	if mod != nil {
		mod(&cfg)
	}
	boot := bootenv.Values{JobID: j.ID, PlatformURL: "https://" + fakeplatform.PlatformHost, ClaimToken: j.ClaimToken, StorageHost: fakeplatform.StorageHost}
	if bootHook != nil {
		bootHook(&boot)
	}
	defaultProfile(&boot, cfg)
	var out bytes.Buffer
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	code := entry.Main(ctx, cfg, boot, &out)
	r := run{job: j, code: code, stdout: out.String(), took: time.Since(start)}
	t.Logf("exit %d in %v; calls %v", code, r.took, FP.Kinds())
	if errs := FP.ContractErrors(); len(errs) > 0 {
		t.Errorf("contract violations: %v", errs)
	}
	if leaks := FP.Leaks(); len(leaks) > 0 {
		t.Errorf("tokens in URLs: %v", leaks)
	}
	checkPhaseLines(t, r.stdout, j)
	return r
}

// defaultProfile gives the in-process run the host profile the boot stage would resolve (module
// README "Host profiles"), unless the test chose one: fly with a Fly signal (OnFly or the Fly
// directory present), as the unset-profile rule says; otherwise dedicated with its values from a
// pipe, the profile this suite's netns stands in for (no Fly, no host route: the host-boundary
// probe reaches nothing).
func defaultProfile(boot *bootenv.Values, cfg layout.Config) {
	if boot.Profile != "" {
		return
	}
	_, err := os.Lstat(cfg.FlyDir)
	if boot.OnFly || err == nil {
		boot.Profile, boot.Source = "fly", "env"
		return
	}
	boot.Profile, boot.Source, boot.Generation = "dedicated", "pipe", "itest-1"
}

// checkPhaseLines: stdout holds only phase lines, and none carries a token.
func checkPhaseLines(t *testing.T, stdout string, j *fakeplatform.Job) {
	t.Helper()
	for _, line := range strings.Split(strings.TrimSpace(stdout), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Errorf("stdout line is not a phase line: %q", line)
			continue
		}
		for k := range m {
			switch k {
			case "ts", "step", "event", "code", "class", "errno", "exit_code":
			default:
				t.Errorf("phase line field %q: %q", k, line)
			}
		}
	}
	for _, tok := range []string{j.ClaimToken, j.CallbackToken, j.CloneToken, j.GatewayKey} {
		if strings.Contains(stdout, tok) {
			t.Error("a token on stdout")
		}
	}
}

func lastCall(kind string) *fakeplatform.Call {
	calls := FP.Calls()
	for i := len(calls) - 1; i >= 0; i-- {
		if calls[i].Kind == kind {
			return &calls[i]
		}
	}
	return nil
}

func countCalls(kind string) int {
	n := 0
	for _, c := range FP.Calls() {
		if c.Kind == kind {
			n++
		}
	}
	return n
}

func resultOf(t *testing.T) map[string]any {
	t.Helper()
	c := lastCall("result")
	if c == nil {
		t.Fatalf("no result call; calls %v", FP.Kinds())
	}
	var m map[string]any
	if err := json.Unmarshal(c.Body, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func finishPushError(t *testing.T) string {
	t.Helper()
	c := lastCall("finish")
	if c == nil {
		t.Fatalf("no finish call; calls %v", FP.Kinds())
	}
	var m map[string]string
	_ = json.Unmarshal(c.Body, &m)
	return m["push_error"]
}

func uploadsAsked(t *testing.T) bool {
	t.Helper()
	c := lastCall("uploads")
	if c == nil {
		t.Fatalf("no uploads call; calls %v", FP.Kinds())
	}
	var m map[string]bool
	_ = json.Unmarshal(c.Body, &m)
	return m["bundle"]
}

// jobCgroupsEmpty checks both job cgroups are empty (before cleanup).
func jobCgroupsEmpty(t *testing.T) {
	t.Helper()
	l := cgroup.For(cgroupRoot)
	for _, d := range []string{l.Kete, l.Tool} {
		if pop, err := cgroup.Populated(d); err == nil && pop {
			t.Errorf("%s still populated", d)
		}
	}
}

// pidsOf returns the pids whose cmdline starts with argv0 and contains arg.
func pidsOf(argv0, arg string) []int {
	var out []int
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		var pid int
		if _, err := fmt.Sscanf(e.Name(), "%d", &pid); err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if err != nil {
			continue
		}
		parts := strings.Split(string(b), "\x00")
		if len(parts) > 1 && parts[0] == argv0 && (arg == "" || parts[1] == arg) {
			out = append(out, pid)
		}
	}
	return out
}

func waitFor(t *testing.T, d time.Duration, what string, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !fn() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s; calls %v", what, FP.Kinds())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// prepareRoot moves every process out of R and enables the controllers there, so a child cgroup
// of R can delegate them (what the entrypoint's own setup does when R is its cgroup).
func prepareRoot(t *testing.T) {
	t.Helper()
	initDir := filepath.Join(cgroupRoot, "kete-job-init")
	if err := os.MkdirAll(initDir, 0o755); err != nil {
		t.Fatal(err)
	}
	pids, err := cgroup.Procs(cgroupRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, pid := range pids {
		_ = cgroup.Join(initDir, pid)
	}
	if err := os.WriteFile(filepath.Join(cgroupRoot, "cgroup.subtree_control"), []byte("+pids +memory"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = syscall.Getpid()
}
