//go:build kete_testdriver

package runner_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/clock"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	kdriver "github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/kubernetes"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube/kubetest"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/runner"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
)

const (
	authority = "portal.kete.example"
	sysNS     = "kete-system"
	jobsNS    = "kete-jobs"
	imageA    = "docker.io/library/busybox@sha256:1111111111111111111111111111111111111111111111111111111111111111"
	imageExit = "docker.io/library/busybox@sha256:2222222222222222222222222222222222222222222222222222222222222222"
	user      = "system:serviceaccount:kete-system:kete-runner"
)

var token = "kete_jhe_SECRETenrollTOKEN" + strings.Repeat("x", 42-17) + "A"

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time          { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) Advance(d time.Duration) { c.mu.Lock(); defer c.mu.Unlock(); c.t = c.t.Add(d) }

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *syncBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func cfg(t *testing.T) config.Config {
	t.Helper()
	raw := fmt.Sprintf(`{"platform_url":"https://%s","driver":"kubernetes","slots":8,"reset":"none",
	  "image_allowlist":[%q,%q],
	  "kubernetes":{"namespace":%q,"jobs_namespace":%q,"instance":"kete-runner","admission_policies":["kete-runner-jobs"],"enrollment_secret":"kete-runner-enrollment",
	    "runtime_class_names":["kete-test"],"repositories":["gitlab:payments/api"],"advertise_repositories":true,
	    "boundary":{"summary":"none","denials":"count","publish_refs":"omit"},
	    "pod_driver":"placeholder","placeholder":{"exit_after":[{"image":%q,"seconds":5}]}}}`,
		authority, imageA, imageExit, sysNS, jobsNS, imageExit)
	c, err := config.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

type env struct {
	t    *testing.T
	kube *kubetest.Server
	p    *fakeplatform.Platform
	clk  *fakeClock
	o    runner.Options
	log  *syncBuffer
	addr string // the fake platform's listener
}

func newEnv(t *testing.T) *env {
	clk := &fakeClock{t: time.Now()}
	p := fakeplatform.New(authority, clk.Now)
	p.V2 = true
	srv, copts, err := fakeplatform.StartTLS(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	ks := kubetest.New()
	t.Cleanup(ks.Close)
	ks.AddAdmissionPolicy("kete-runner-jobs")
	ks.AddRuntimeClass("kete-test")
	log := &syncBuffer{}
	e := &env{t: t, kube: ks, p: p, clk: clk, log: log, addr: srv.Listener.Addr().String()}
	e.o = runner.Options{
		Config: cfg(t), Kube: ks.Client(user), Identity: "kete-runner-abc", AgentVersion: "0.9.0", HostKernel: "6.8.0",
		Arch: "arm64", Clock: clock.Fixed(true), Log: slog.New(slog.NewJSONHandler(log, &slog.HandlerOptions{Level: slog.LevelDebug})),
		ClientOptions: copts, Now: clk.Now,
		Interval:       func(s int) time.Duration { return time.Duration(s) * 5 * time.Millisecond },
		SuperviseEvery: 20 * time.Millisecond, EnrollRetry: 20 * time.Millisecond, DriverPoll: 5 * time.Millisecond, PolicyEvery: 20 * time.Millisecond,
		Lease: kube.Elector{Duration: 2 * time.Second, RenewDeadline: 1500 * time.Millisecond, Retry: 50 * time.Millisecond},
	}
	return e
}

func (e *env) start() (cancel func() error) {
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx, e.o) }()
	return func() error {
		stop()
		if err := <-done; !errors.Is(err, context.Canceled) {
			return err
		}
		return nil
	}
}

func (e *env) eventually(what string, f func() bool) {
	e.t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	e.t.Fatalf("timed out waiting for %s\nlog:\n%s", what, e.log.String())
}

func (e *env) machine(host, id string) fakeplatform.Machine {
	m := e.p.HostSnapshot(host).Machines[id]
	if m == nil {
		return fakeplatform.Machine{}
	}
	return *m
}

func (e *env) assign(host, mid, jid, img string, repo *contract.RunRepository, publish *contract.RunPublish, deadline time.Duration) {
	e.t.Helper()
	run := contract.RunMachineV2{MachineID: mid, JobID: jid, Image: img, Deadline: contract.FormatTime(e.clk.Now().Add(deadline)),
		Resources: contract.Resources{VCPUs: 1, MemoryMiB: 1024, ScratchGiB: 1}, Repository: repo, Publish: publish}
	c := seal.MachineConfig{JobID: jid, PlatformURL: "https://" + authority, ClaimToken: strings.Repeat("ab", 32), StorageHost: "storage.kete.example", HostProfile: seal.ProfileKubeVM}
	if err := e.p.AssignV2(host, run, c); err != nil {
		e.t.Fatal(err)
	}
}

func mid(n int) string { return fmt.Sprintf("2b3c4d5e-6f7a-4b8c-9d0e-%012d", n) }
func jid(n int) string { return fmt.Sprintf("5e6f7a8b-9c0d-4e1f-8a2b-%012d", n) }

var repo = &contract.RunRepository{Name: "gitlab:payments/api", BaseRef: "main"}

func TestRunnerLifecycle(t *testing.T) {
	e := newEnv(t)
	e.p.AddToken(token)
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "kete-runner-enrollment"}, "data": map[string]any{"token": []byte(token)}})
	stop := e.start()

	// Enrollment under v2: kubernetes facts, token Secret deleted, keys and state in Secrets.
	var host string
	e.eventually("enrollment", func() bool {
		h := e.p.Hosts()
		return len(h) == 1 && e.kube.Get("secrets", sysNS, "kete-runner-state") != nil && func() bool { host = h[0]; return true }()
	})
	f := e.p.HostSnapshot(host).FactsV2
	if f.Driver != contract.DriverKubernetes || f.Slots != 8 || f.KVM || f.Versions.Kubernetes != "v1.31.2" || len(f.RuntimeClasses) != 1 || !strings.HasPrefix(f.Generation, "k8s-") {
		t.Fatalf("facts %+v", f)
	}
	if e.kube.Get("secrets", sysNS, "kete-runner-enrollment") != nil {
		t.Fatal("the spent enrollment token Secret was kept")
	}
	keysSec := e.kube.Get("secrets", sysNS, "kete-runner-keys")
	if keysSec == nil || keysSec["metadata"].(map[string]any)["annotations"].(map[string]any)[kube.AnnKeys] != kube.KeysEnrolled {
		t.Fatalf("keys Secret %v", keysSec)
	}
	e.p.SetStatus(host, "active")
	e.eventually("a v2 report", func() bool { return len(e.p.HostSnapshot(host).ReportsV2) > 0 })
	r := e.p.HostSnapshot(host).ReportsV2[0]
	if r.Version != 2 || r.Repositories == nil || len(*r.Repositories) != 1 || len(r.Images) != 2 || r.Boundary.PublishRefs != "omit" || r.RuntimeClasses[0] != "kete-test" {
		t.Fatalf("report %+v", r)
	}

	// Refusals before anything starts.
	e.assign(host, mid(2), jid(2), imageA, &contract.RunRepository{Name: "gitlab:other/repo", BaseRef: "main"}, nil, time.Hour)
	e.assign(host, mid(3), jid(3), imageA, repo, &contract.RunPublish{Branch: "kete/job/abc", Authorized: false}, time.Hour)
	e.assign(host, mid(4), jid(4), imageA, nil, nil, time.Hour)
	for n, want := range map[int]string{2: contract.ReasonRepositoryUnknown, 3: contract.ReasonConfigInvalid, 4: contract.ReasonConfigInvalid} {
		e.eventually(fmt.Sprintf("machine %d failed %s", n, want), func() bool {
			m := e.machine(host, mid(n))
			return m.Observed == contract.StateFailed && m.ObservedReason == want
		})
	}

	// A machine: pod with labels and RuntimeClass, the boot-ID Secret owned by the pod, running,
	// Secret removed, then withdrawn → pod deleted.
	e.assign(host, mid(1), jid(1), imageA, repo, nil, time.Hour)
	pod := kdriver.PodName(mid(1))
	e.eventually("pod and Secret", func() bool { return e.kube.Get("secrets", jobsNS, pod) != nil })
	p := e.kube.Get("pods", jobsNS, pod)
	labels := p["metadata"].(map[string]any)["labels"].(map[string]any)
	spec := p["spec"].(map[string]any)
	if labels[kdriver.LabelMachineID] != mid(1) || labels[kdriver.LabelJobID] != jid(1) || labels[kdriver.LabelDeadline] == nil ||
		spec["runtimeClassName"] != "kete-test" || spec["automountServiceAccountToken"] != false || spec["enableServiceLinks"] != false {
		t.Fatalf("pod %v", p)
	}
	sec := e.kube.Get("secrets", jobsNS, pod)
	if string(mustB64(t, sec["data"].(map[string]any)[kdriver.SecretBootID])) != kubetest.BootID {
		t.Fatalf("secret %v", sec)
	}
	e.kube.SetPodPhase(jobsNS, pod, kube.PodRunning, "")
	e.eventually("running", func() bool { return e.machine(host, mid(1)).Observed == contract.StateRunning })
	e.eventually("machine Secret deleted", func() bool { return e.kube.Get("secrets", jobsNS, pod) == nil })
	e.p.Withdraw(host, mid(1))
	e.eventually("withdrawn", func() bool {
		m := e.machine(host, mid(1))
		return m.Observed == contract.StateDestroyed && m.ObservedReason == contract.ReasonDesired && e.kube.Get("pods", jobsNS, pod) == nil
	})

	// A pod that ends by itself → destroyed exited.
	e.assign(host, mid(5), jid(5), imageExit, repo, nil, time.Hour)
	e.eventually("pod 5", func() bool { return e.kube.Get("pods", jobsNS, kdriver.PodName(mid(5))) != nil })
	e.kube.SetPodPhase(jobsNS, kdriver.PodName(mid(5)), kube.PodRunning, "")
	e.eventually("running 5", func() bool { return e.machine(host, mid(5)).Observed == contract.StateRunning })
	e.kube.SetPodPhase(jobsNS, kdriver.PodName(mid(5)), kube.PodSucceeded, "")
	e.eventually("exited", func() bool {
		m := e.machine(host, mid(5))
		return m.Observed == contract.StateDestroyed && m.ObservedReason == contract.ReasonExited
	})

	// Deadline kill, by the controller's own clock.
	e.assign(host, mid(6), jid(6), imageA, repo, nil, time.Minute)
	e.eventually("pod 6", func() bool { return e.kube.Get("pods", jobsNS, kdriver.PodName(mid(6))) != nil })
	e.kube.SetPodPhase(jobsNS, kdriver.PodName(mid(6)), kube.PodRunning, "")
	e.eventually("running 6", func() bool { return e.machine(host, mid(6)).Observed == contract.StateRunning })
	e.clk.Advance(time.Minute + contract.DeadlineGrace + time.Second)
	e.eventually("deadline kill", func() bool {
		m := e.machine(host, mid(6))
		return m.Observed == contract.StateDestroyed && m.ObservedReason == contract.ReasonDeadline && e.kube.Get("pods", jobsNS, kdriver.PodName(mid(6))) == nil
	})

	if err := stop(); err != nil {
		t.Fatalf("runner stop: %v", err)
	}
	if h := e.kube.Get("leases", sysNS, "kete-runner")["spec"].(map[string]any)["holderIdentity"]; h != "" {
		t.Fatalf("lease not released: %v", h)
	}
	if w := e.kube.WritesBy(user); w[len(w)-1] != user+" PUT leases/kete-runner" {
		t.Fatalf("the lease was not released last: %v", w[len(w)-3:])
	}

	// Restart with an orphan job pod (labelled, unknown to the state): reconcile deletes it and
	// reports it unattributed; the state Secret carries the enrollment over.
	orphan := mid(9)
	e.kube.Put("pods", jobsNS, map[string]any{
		"metadata": map[string]any{"name": kdriver.PodName(orphan), "labels": map[string]any{
			kube.LabelManaged: kube.ManagedBy, kdriver.LabelRole: kdriver.RoleJob, kdriver.LabelInstance: "kete-runner", kdriver.LabelMachineID: orphan}},
		"spec": map[string]any{"containers": []any{}}, "status": map[string]any{"phase": "Running"},
	})
	e.kube.Put("pods", jobsNS, map[string]any{
		"metadata": map[string]any{"name": "not-a-machine", "labels": map[string]any{kube.LabelManaged: kube.ManagedBy, kdriver.LabelRole: kdriver.RoleJob, kdriver.LabelInstance: "kete-runner"}},
		"spec":     map[string]any{"containers": []any{}},
	})
	e.kube.Put("pods", jobsNS, map[string]any{
		"metadata": map[string]any{"name": kdriver.PodName(mid(10)), "labels": map[string]any{
			kube.LabelManaged: kube.ManagedBy, kdriver.LabelRole: kdriver.RoleJob, kdriver.LabelInstance: "other-runner", kdriver.LabelMachineID: mid(10)}},
		"spec": map[string]any{"containers": []any{}},
	})
	e.o.Identity = "kete-runner-def"
	stop = e.start()
	e.eventually("orphan destroyed", func() bool {
		_, reported := e.p.HostSnapshot(host).Unknown[orphan]
		return reported && e.kube.Get("pods", jobsNS, kdriver.PodName(orphan)) == nil && e.kube.Get("pods", jobsNS, "not-a-machine") == nil
	})
	if len(e.p.Hosts()) != 1 {
		t.Fatal("the restarted runner enrolled again")
	}
	if e.kube.Get("pods", jobsNS, kdriver.PodName(mid(10))) == nil {
		t.Fatal("another runner instance's pod was deleted")
	}
	if err := stop(); err != nil {
		t.Fatal(err)
	}

	// No secret in the logs; every cluster write is the controller's own identity.
	if l := e.log.String(); strings.Contains(l, "SECRETenroll") || strings.Contains(l, strings.Repeat("ab", 32)) {
		t.Fatal("a token reached the log")
	}
	for _, w := range e.kube.Writes {
		if !strings.HasPrefix(w, user+" ") {
			t.Fatalf("write by another identity: %s", w)
		}
	}
}

func TestRunnerWaitsForToken(t *testing.T) {
	e := newEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	err := runner.Run(ctx, e.o)
	if err == nil || !strings.Contains(err.Error(), "not enrolled") {
		t.Fatalf("Run = %v", err)
	}
	if !strings.Contains(e.log.String(), "enroll_waiting") {
		t.Fatal("no waiting log")
	}
}

func TestRunnerRefusedTokenIsDeleted(t *testing.T) {
	e := newEnv(t) // the platform knows no token
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "kete-runner-enrollment"}, "data": map[string]any{"token": []byte(token)}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := runner.Run(ctx, e.o)
	if err == nil || !strings.Contains(err.Error(), contract.ErrEnrollmentTokenInvalid) {
		t.Fatalf("Run = %v", err)
	}
	if e.kube.Get("secrets", sysNS, "kete-runner-enrollment") != nil {
		t.Fatal("a refused (spent) token Secret was kept")
	}
	if a := e.kube.Get("secrets", sysNS, "kete-runner-keys")["metadata"].(map[string]any)["annotations"].(map[string]any)[kube.AnnKeys]; a != kube.KeysStaged {
		t.Fatalf("keys %v after a refused enrollment", a)
	}
}

func TestRunnerProxyCarriesPlatformTraffic(t *testing.T) {
	e := newEnv(t)
	var mu sync.Mutex
	var seen []string
	px := newConnectProxy(t, e.addr, func(host string) { mu.Lock(); seen = append(seen, host); mu.Unlock() })
	e.o.Config.Kube.Proxy = px
	e.o.ClientOptions.DialContext = nil // the proxy dials; the client must not bypass it
	e.p.AddToken(token)
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "kete-runner-enrollment"}, "data": map[string]any{"token": []byte(token)}})
	stop := e.start()
	e.eventually("enrollment through the proxy", func() bool { return len(e.p.Hosts()) == 1 })
	_ = stop()
	mu.Lock()
	defer mu.Unlock()
	if len(seen) == 0 || seen[0] != authority+":443" {
		t.Fatalf("proxy saw %v", seen)
	}
}

func mustB64(t *testing.T, v any) []byte {
	t.Helper()
	var b []byte
	raw, _ := json.Marshal(v)
	if err := json.Unmarshal(raw, &b); err != nil {
		t.Fatal(err)
	}
	return b
}

func enrolledEnv(t *testing.T) (*env, string, func() error) {
	e := newEnv(t)
	e.p.AddToken(token)
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "kete-runner-enrollment"}, "data": map[string]any{"token": []byte(token)}})
	stop := e.start()
	e.eventually("enrolled", func() bool { return len(e.p.Hosts()) == 1 })
	host := e.p.Hosts()[0]
	e.p.SetStatus(host, "active")
	e.eventually("a report", func() bool { return len(e.p.HostSnapshot(host).ReportsV2) > 0 })
	return e, host, stop
}

// Without the jobs namespace's admission policy (or with a binding that only warns) nothing starts
// (cluster_unhealthy); once restored, machines start again.
func TestRunnerBlocksStartsWithoutAdmissionPolicy(t *testing.T) {
	e, host, stop := enrolledEnv(t)
	defer func() { _ = stop() }()
	e.kube.Put("validatingadmissionpolicybindings", "", map[string]any{"metadata": map[string]any{"name": "kete-runner-jobs"},
		"spec": map[string]any{"policyName": "kete-runner-jobs", "validationActions": []any{"Warn"}}})
	e.eventually("starts blocked", func() bool {
		r := e.p.HostSnapshot(host).ReportsV2
		sb := r[len(r)-1].StartsBlocked
		return sb != nil && *sb == contract.BlockedClusterUnhealthy
	})
	e.assign(host, mid(1), jid(1), imageA, repo, nil, time.Hour)
	e.eventually("refused", func() bool {
		m := e.machine(host, mid(1))
		return m.Observed == contract.StateFailed && m.ObservedReason == contract.ReasonStartsBlocked
	})
	if e.kube.Get("pods", jobsNS, kdriver.PodName(mid(1))) != nil {
		t.Fatal("a pod was created without the admission policy")
	}
	e.kube.Delete("validatingadmissionpolicies", "", "kete-runner-jobs")
	e.kube.AddAdmissionPolicy("kete-runner-jobs")
	e.kube.AddRuntimeClass("kete-test")
	e.assign(host, mid(2), jid(2), imageA, repo, nil, time.Hour)
	e.eventually("started again", func() bool { return e.kube.Get("pods", jobsNS, kdriver.PodName(mid(2))) != nil })
}

// Someone else writing the state Secret is fatal: the runner stops (Kubernetes restarts it).
func TestRunnerStopsOnStateConflict(t *testing.T) {
	e, host, stop := enrolledEnv(t)
	sec := e.kube.Get("secrets", sysNS, "kete-runner-state")
	e.kube.Put("secrets", sysNS, sec)                            // a foreign write: new resourceVersion
	e.assign(host, mid(1), jid(1), imageA, repo, nil, time.Hour) // forces a state write
	e.eventually("conflict logged", func() bool { return strings.Contains(e.log.String(), "state_conflict") })
	err := stop()
	if err == nil || !strings.Contains(err.Error(), "changed under this controller") {
		t.Fatalf("Run = %v", err)
	}
}

// A squatted machine Secret: the pod is deleted at once and the machine fails.
func TestRunnerSecretSquat(t *testing.T) {
	e, host, stop := enrolledEnv(t)
	defer func() { _ = stop() }()
	e.kube.Put("secrets", jobsNS, map[string]any{"metadata": map[string]any{"name": kdriver.PodName(mid(1))}, "data": map[string]any{"node_boot_id": []byte("x")}})
	e.assign(host, mid(1), jid(1), imageA, repo, nil, time.Hour)
	e.eventually("failed driver_failed", func() bool {
		m := e.machine(host, mid(1))
		return m.Observed == contract.StateFailed && m.ObservedReason == contract.ReasonDriverFailed
	})
	if e.kube.Get("pods", jobsNS, kdriver.PodName(mid(1))) != nil {
		t.Fatal("the pod survived a squatted Secret")
	}
}
