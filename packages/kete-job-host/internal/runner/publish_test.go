//go:build kete_testdriver

package runner_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	kdriver "github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/kubernetes"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakegitlab"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/repo/gitlab"
)

const (
	minterToken = "glpat-minter000000000000000000000"
	runnerImage = "registry.corp.example/kete/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
	jobBranch   = "kete/job/0a1b2c3d"
)

// fakeGitLab starts a fake GitLab (TLS, any host name dials it) and returns it with a client for
// the runner's RepoHTTP seam. Skipped without git.
func fakeGitLab(t *testing.T) (*fakegitlab.Server, *http.Client) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required (git http-backend)")
	}
	gl, err := fakegitlab.New("example.com", t.TempDir())
	if err != nil {
		t.Skip(err)
	}
	if _, err := gl.AddProject("payments/api", map[string]string{"README.md": "# api\n"}, ""); err != nil {
		t.Fatal(err)
	}
	gl.SetMinter(minterToken)
	gl.AddDeployToken("deploy", "gldt-secret")
	srv := httptest.NewTLSServer(gl)
	t.Cleanup(srv.Close)
	tr := srv.Client().Transport.(*http.Transport).Clone()
	addr := srv.Listener.Addr().String()
	tr.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	}
	return gl, gitlab.NewHTTPClient(tr)
}

func publishConfig(t *testing.T, source string) config.Config {
	t.Helper()
	raw := fmt.Sprintf(`{"platform_url":"https://%s","driver":"kubernetes","slots":8,"reset":"none",
	  "image_allowlist":[%q],
	  "kubernetes":{"namespace":%q,"jobs_namespace":%q,"instance":"kete-runner","admission_policies":["kete-runner-jobs"],"enrollment_secret":"kete-runner-enrollment",
	    "runtime_class_names":["kete-test"],"repositories":["gitlab:payments/api"],
	    "boundary":{"summary":"none","denials":"actions","publish_refs":"send"},
	    "repository_sources":[%s],
	    "publisher":{"image":%q,"config_map":"kete-publisher"},
	    "pod_driver":"kubevm","job_pod":{"cpu":"1","memory":"2Gi","ephemeral_storage":"4Gi","outbox_size":"1Gi","outbox_hold_hours":1}}}`,
		authority, imageA, sysNS, jobsNS, source, runnerImage)
	c, err := config.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

const mintedSource = `{"name":"gitlab:payments/api","clone_url":"https://example.com/payments/api.git","clone_mode":"minted","minter_secret":"gitlab-minter","writer_secret":"gitlab-writer"}`

func publishEnv(t *testing.T, source string) (*env, *fakegitlab.Server, string, func() error) {
	t.Helper()
	gl, hc := fakeGitLab(t)
	e := newEnv(t)
	e.o.Config = publishConfig(t, source)
	e.o.RepoHTTP = hc
	e.p.AddToken(token)
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "kete-runner-enrollment"}, "data": map[string]any{"token": []byte(token)}})
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "gitlab-minter"}, "data": map[string]any{"token": []byte(minterToken)}})
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "payments-read"}, "data": map[string]any{"username": []byte("deploy"), "token": []byte("gldt-secret")}})
	stop := e.start()
	e.eventually("enrolled", func() bool { return len(e.p.Hosts()) == 1 })
	host := e.p.Hosts()[0]
	e.p.SetStatus(host, "active")
	return e, gl, host, stop
}

func (e *env) jobConfig(machine string) map[string]any {
	e.t.Helper()
	s := e.kube.Get("secrets", jobsNS, kdriver.PodName(machine))
	b, _ := base64.StdEncoding.DecodeString(s["data"].(map[string]any)["config.json"].(string))
	var c map[string]any
	if err := json.Unmarshal(b, &c); err != nil {
		e.t.Fatal(err)
	}
	return c
}

// The whole controller side of publishing: a minted clone token (revoked at clone_done), the job
// exits into `publishing`, its pod goes, nothing is published before the platform's go-ahead, then
// the publisher pod (its spec pinned), its outcome on the destroyed/exited tombstone, the outbox
// and publisher removed.
func TestRunnerPublishes(t *testing.T) {
	e, gl, host, stop := publishEnv(t, mintedSource)
	defer func() { _ = stop() }()
	pub := &contract.RunPublish{Branch: jobBranch, OpenMR: true}
	e.assign(host, mid(1), jid(1), imageA, repo, pub, time.Hour)
	e.eventually("the machine Secret", func() bool { return e.kube.Get("secrets", jobsNS, kdriver.PodName(mid(1))) != nil })
	r := e.jobConfig(mid(1))["local"].(map[string]any)["repository"].(map[string]any)
	if r["username"] != "kete-job" || !strings.HasPrefix(r["token"].(string), "glpat-") {
		t.Fatalf("clone credential %v", r)
	}
	toks := gl.State().Tokens
	if len(toks) != 1 || toks[0].Name != "kete-job-kete-runner-"+mid(1) || toks[0].Revoked || toks[0].Scopes[0] != "read_repository" || toks[0].Level != 20 {
		t.Fatalf("minted %+v", toks)
	}
	name := kdriver.PodName(mid(1))
	e.kube.SetLog(name, `{"ts":"2026-10-09T10:00:00.000Z","step":"clone","event":"ok"}`+"\n"+`{"ts":"2026-10-09T10:00:01.000Z","step":"clone_done","event":"start"}`+"\n")
	e.kube.SetPodPhase(jobsNS, name, kube.PodRunning, "")
	e.eventually("the clone token revoked at clone_done", func() bool { return gl.State().Tokens[0].Revoked })

	e.kube.SetPodPhase(jobsNS, name, kube.PodSucceeded, "")
	e.eventually("publishing, the job pod gone", func() bool {
		return e.machine(host, mid(1)).Observed == contract.StatePublishing && e.kube.Get("pods", jobsNS, name) == nil
	})
	time.Sleep(200 * time.Millisecond)
	if e.kube.Get("pods", jobsNS, kdriver.PublishPodName(mid(1))) != nil {
		t.Fatal("a publisher started before the platform's go-ahead")
	}
	if err := e.p.Authorize(host, mid(1)); err != nil {
		t.Fatal(err)
	}
	pname := kdriver.PublishPodName(mid(1))
	e.eventually("the publisher pod", func() bool { return e.kube.Get("pods", jobsNS, pname) != nil })
	var pod kube.Pod
	b, _ := json.Marshal(e.kube.Get("pods", jobsNS, pname))
	_ = json.Unmarshal(b, &pod)
	c := pod.Spec.Containers[0]
	args := strings.Join(c.Args, " ")
	if pod.Metadata.Labels[kdriver.LabelRole] != kdriver.RolePublish || c.Image != runnerImage || c.Command[0] != kdriver.PublisherCommand ||
		!strings.Contains(args, "publish --machine "+mid(1)+" --job "+jid(1)+" --repository gitlab:payments/api --base-ref main --branch "+jobBranch+" --base-sha ") || !strings.HasSuffix(args, " --open-mr=true") ||
		pod.Spec.RuntimeClassName != "kete-test" || *pod.Spec.AutomountServiceAccountToken || *pod.Spec.SecurityContext.RunAsUser != 65532 ||
		!*c.SecurityContext.ReadOnlyRootFilesystem || c.SecurityContext.Capabilities.Drop[0] != "ALL" || len(c.SecurityContext.Capabilities.Add) != 0 {
		t.Fatalf("publisher pod %s", b)
	}
	vols := map[string]kube.Volume{}
	for _, v := range pod.Spec.Volumes {
		vols[v.Name] = v
	}
	if v := vols["kete-outbox"]; v.PersistentVolumeClaim == nil || !v.PersistentVolumeClaim.ReadOnly || v.PersistentVolumeClaim.ClaimName != kdriver.OutboxName(mid(1)) ||
		vols["kete-publish-writer"].Secret.SecretName != "gitlab-writer" || vols["kete-publish-config"].ConfigMap.Name != "kete-publisher" {
		t.Fatalf("publisher volumes %+v", vols)
	}
	for _, m := range c.VolumeMounts {
		if !m.ReadOnly {
			t.Fatalf("a writable mount %+v", m)
		}
	}
	base, commit := strings.Repeat("a", 40), strings.Repeat("b", 40)
	outcome := fmt.Sprintf(`{"status":"created","base_sha":%q,"commit_sha":%q,"mr":{"iid":7,"url":"https://gitlab.corp.example/payments/api/-/merge_requests/7"}}`, base, commit)
	e.kube.SetPodStatus(jobsNS, pname, map[string]any{"phase": "Succeeded", "containerStatuses": []any{
		map[string]any{"name": "publish", "state": map[string]any{"terminated": map[string]any{"exitCode": 0, "reason": "Completed", "message": outcome}}}}})
	e.eventually("destroyed/exited with the outcome", func() bool {
		m := e.machine(host, mid(1))
		return m.Observed == contract.StateDestroyed && m.ObservedReason == contract.ReasonExited && m.Publish != nil
	})
	got := e.machine(host, mid(1)).Publish
	if got.Status != "created" || got.Branch != jobBranch || got.BaseSHA != base || got.CommitSHA != commit || got.MR == nil || got.MR.IID != 7 {
		t.Fatalf("outcome %+v", got)
	}
	e.eventually("the outbox and the publisher removed", func() bool {
		return e.kube.Get("persistentvolumeclaims", jobsNS, kdriver.OutboxName(mid(1))) == nil && e.kube.Get("pods", jobsNS, pname) == nil
	})
	if logs := e.log.String(); strings.Contains(logs, minterToken) || strings.Contains(logs, "glpat-") && strings.Contains(logs, r["token"].(string)) {
		t.Fatal("a token reached the controller's log")
	}
}

// No go-ahead within the hold time: failed/hold_expired and the outbox goes. A machine the
// platform drops while it waits is destroyed (desired) with its outbox, never published. A publish
// for a repository without a writer, or a publisher that ends without an outcome, fail closed.
func TestRunnerPublishRefusals(t *testing.T) {
	static := `{"name":"gitlab:payments/api","clone_url":"https://example.com/payments/api.git","clone_secret":"payments-read","writer_secret":"gitlab-writer"}`
	e, gl, host, stop := publishEnv(t, static)
	defer func() { _ = stop() }()
	pub := func() *contract.RunPublish { return &contract.RunPublish{Branch: jobBranch, OpenMR: false} }
	exit := func(m string) {
		e.eventually("the job pod of "+m, func() bool { return e.kube.Get("pods", jobsNS, kdriver.PodName(m)) != nil })
		e.eventually("its Secret", func() bool { return e.kube.Get("secrets", jobsNS, kdriver.PodName(m)) != nil })
		e.kube.SetPodPhase(jobsNS, kdriver.PodName(m), kube.PodSucceeded, "")
		e.eventually(m+" publishing", func() bool { return e.machine(host, m).Observed == contract.StatePublishing })
	}
	e.assign(host, mid(2), jid(2), imageA, repo, pub(), 3*time.Hour)
	e.assign(host, mid(3), jid(3), imageA, repo, pub(), 3*time.Hour)
	exit(mid(2))
	exit(mid(3))
	if len(gl.State().Tokens) != 0 {
		t.Fatal("a static source minted a token")
	}
	e.p.Withdraw(host, mid(3))
	e.eventually("dropped while waiting: destroyed, outbox gone", func() bool {
		m := e.machine(host, mid(3))
		return m.Observed == contract.StateDestroyed && m.ObservedReason == contract.ReasonDesired && m.Publish == nil &&
			e.kube.Get("persistentvolumeclaims", jobsNS, kdriver.OutboxName(mid(3))) == nil
	})
	// A publisher pod that ends without a valid outcome: failed/publisher_failed, outbox kept.
	e.assign(host, mid(4), jid(4), imageA, repo, pub(), 3*time.Hour)
	exit(mid(4))
	_ = e.p.Authorize(host, mid(4))
	e.eventually("publisher 4", func() bool { return e.kube.Get("pods", jobsNS, kdriver.PublishPodName(mid(4))) != nil })
	e.kube.SetPodStatus(jobsNS, kdriver.PublishPodName(mid(4)), map[string]any{"phase": "Failed", "containerStatuses": []any{
		map[string]any{"name": "publish", "state": map[string]any{"terminated": map[string]any{"exitCode": 2, "message": `{"status":"created","reason":"oops"}`}}}}})
	e.eventually("publisher_failed", func() bool {
		m := e.machine(host, mid(4))
		return m.Observed == contract.StateDestroyed && m.Publish != nil && m.Publish.Status == "failed" && m.Publish.Reason == "publisher_failed"
	})
	if e.kube.Get("persistentvolumeclaims", jobsNS, kdriver.OutboxName(mid(4))) == nil {
		t.Fatal("a failed publish's outbox wasn't kept for the operator")
	}

	e.clk.Advance(61 * time.Minute)
	e.eventually("hold_expired", func() bool {
		m := e.machine(host, mid(2))
		return m.Observed == contract.StateDestroyed && m.ObservedReason == contract.ReasonExited && m.Publish != nil && m.Publish.Reason == "hold_expired"
	})
	if e.kube.Get("persistentvolumeclaims", jobsNS, kdriver.OutboxName(mid(2))) != nil || e.kube.Get("pods", jobsNS, kdriver.PublishPodName(mid(2))) != nil {
		t.Fatal("hold_expired left the outbox or started a publisher")
	}

	// A repository without a writer can't publish: refused at assignment.
	other := &contract.RunRepository{Name: "gitlab:payments/other", BaseRef: "main"}
	e.assign(host, mid(5), jid(5), imageA, other, pub(), time.Hour)
	e.eventually("config_invalid or unknown", func() bool {
		m := e.machine(host, mid(5))
		return m.Observed == contract.StateFailed
	})
}

// A base ref the credential can't resolve fails the machine repository_unavailable before any pod
// runs, and the minted token is revoked.
func TestRunnerUnresolvableBaseRef(t *testing.T) {
	e, gl, host, stop := publishEnv(t, mintedSource)
	defer func() { _ = stop() }()
	e.assign(host, mid(6), jid(6), imageA, &contract.RunRepository{Name: "gitlab:payments/api", BaseRef: "nope"}, nil, time.Hour)
	e.eventually("repository_unavailable", func() bool {
		m := e.machine(host, mid(6))
		return m.Observed == contract.StateFailed && m.ObservedReason == contract.ReasonRepositoryUnavailable
	})
	e.eventually("its pod gone", func() bool { return e.kube.Get("pods", jobsNS, kdriver.PodName(mid(6))) == nil })
	e.eventually("the minted token revoked", func() bool {
		toks := gl.State().Tokens
		return len(toks) == 1 && toks[0].Revoked
	})
	_ = time.Second
}
