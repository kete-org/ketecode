//go:build kete_testdriver

package runner_test

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	kdriver "github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/kubernetes"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
)

func kubeVMConfig(t *testing.T) config.Config {
	t.Helper()
	raw := fmt.Sprintf(`{"platform_url":"https://%s","driver":"kubernetes","slots":8,"reset":"none",
	  "image_allowlist":[%q],
	  "kubernetes":{"namespace":%q,"jobs_namespace":%q,"instance":"kete-runner","admission_policies":["kete-runner-jobs"],"enrollment_secret":"kete-runner-enrollment",
	    "runtime_class_names":["kete-test"],"repositories":["gitlab:payments/api"],
	    "repository_sources":[{"name":"gitlab:payments/api","clone_url":"https://example.com/payments/api.git","clone_secret":"payments-read"}],
	    "pod_driver":"kubevm","job_pod":{"cpu":"1","memory":"2Gi","ephemeral_storage":"4Gi","outbox_size":"1Gi"}}}`,
		authority, imageA, sysNS, jobsNS)
	c, err := config.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// The kubevm pod driver end to end against the fake cluster: the pod, the per-job Secret with the
// runner's local section (the test build's shared-kernel mode for kete-test), phase lines from the
// pod's log, the exit, and the outbox kept after the pod.
func TestRunnerKubeVMMachine(t *testing.T) {
	_, hc := fakeGitLab(t)
	e := newEnv(t)
	e.o.Config = kubeVMConfig(t)
	e.o.RepoHTTP = hc
	e.o.PullGrace = time.Millisecond
	e.p.AddToken(token)
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "kete-runner-enrollment"}, "data": map[string]any{"token": []byte(token)}})
	e.kube.Put("secrets", sysNS, map[string]any{"metadata": map[string]any{"name": "payments-read"}, "data": map[string]any{"username": []byte("deploy"), "token": []byte("gldt-secret")}})
	stop := e.start()
	defer func() { _ = stop() }()
	e.eventually("enrolled", func() bool { return len(e.p.Hosts()) == 1 })
	host := e.p.Hosts()[0]
	e.p.SetStatus(host, "active")

	e.assign(host, mid(1), jid(1), imageA, repo, nil, time.Hour)
	name := kdriver.PodName(mid(1))
	e.eventually("the machine Secret", func() bool { return e.kube.Get("secrets", jobsNS, name) != nil })
	b, _ := base64.StdEncoding.DecodeString(e.kube.Get("secrets", jobsNS, name)["data"].(map[string]any)["config.json"].(string))
	var jc struct {
		HostProfile string `json:"host_profile"`
		Local       struct {
			Repository       map[string]string `json:"repository"`
			SharedKernelTest bool              `json:"shared_kernel_test"`
		} `json:"local"`
	}
	if err := json.Unmarshal(b, &jc); err != nil || jc.HostProfile != "kubevm" || !jc.Local.SharedKernelTest || jc.Local.Repository["token"] != "gldt-secret" {
		t.Fatalf("config.json %s", b)
	}
	if e.kube.Get("persistentvolumeclaims", jobsNS, kdriver.OutboxName(mid(1))) == nil {
		t.Fatal("no outbox")
	}
	e.kube.SetLog(name, `{"ts":"2026-10-08T10:00:00.000Z","step":"setup_host","event":"ok"}`+"\nnot a phase line\n")
	e.kube.SetPodPhase(jobsNS, name, kube.PodRunning, "")
	e.eventually("running with a phase line", func() bool {
		m := e.machine(host, mid(1))
		return m.Observed == contract.StateRunning && len(m.PhaseLines) == 1 && m.PhaseLines[0].Step == "setup_host"
	})
	e.kube.SetPodPhase(jobsNS, name, kube.PodSucceeded, "")
	e.eventually("exited", func() bool {
		m := e.machine(host, mid(1))
		return m.Observed == contract.StateDestroyed && m.ObservedReason == contract.ReasonExited
	})
	if e.kube.Get("persistentvolumeclaims", jobsNS, kdriver.OutboxName(mid(1))) == nil {
		t.Fatal("the outbox went with the pod")
	}
	// An image that can't be pulled fails the machine image_pull_failed, and its pod goes.
	e.assign(host, mid(2), jid(2), imageA, repo, nil, time.Hour)
	name2 := kdriver.PodName(mid(2))
	e.eventually("the second pod", func() bool { return e.kube.Get("pods", jobsNS, name2) != nil })
	e.kube.SetPodStatus(jobsNS, name2, map[string]any{"phase": "Pending", "containerStatuses": []any{
		map[string]any{"name": "job", "state": map[string]any{"waiting": map[string]any{"reason": "ImagePullBackOff"}}}}})
	e.clk.Advance(2 * time.Second) // the pod's age (creationTimestamp has second resolution) past PullGrace
	e.eventually("failed image_pull_failed", func() bool {
		m := e.machine(host, mid(2))
		return m.Observed == contract.StateFailed && m.ObservedReason == contract.ReasonImagePullFailed
	})
	e.eventually("the failed pod removed", func() bool { return e.kube.Get("pods", jobsNS, name2) == nil })
	if logs := e.log.String(); contains(logs, "gldt-secret") || contains(logs, "ababab") {
		t.Fatal("a credential reached the controller's log")
	}
}

// A configured RuntimeClass that doesn't exist blocks starts (runtime_class_missing).
func TestRunnerBlocksStartsWithoutRuntimeClass(t *testing.T) {
	e, host, stop := enrolledEnv(t)
	defer func() { _ = stop() }()
	e.kube.Delete("runtimeclasses", "", "kete-test")
	e.eventually("starts blocked", func() bool {
		r := e.p.HostSnapshot(host).ReportsV2
		sb := r[len(r)-1].StartsBlocked
		return sb != nil && *sb == contract.BlockedRuntimeClassMissing
	})
	e.kube.AddRuntimeClass("kete-test")
	e.eventually("unblocked", func() bool {
		r := e.p.HostSnapshot(host).ReportsV2
		return r[len(r)-1].StartsBlocked == nil
	})
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
