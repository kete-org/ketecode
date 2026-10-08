package kubernetes_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	kd "github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/kubernetes"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube/kubetest"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
)

const img = "registry.corp.example/kete/job@sha256:2222222222222222222222222222222222222222222222222222222222222222"

func kubeVMOptions(secrets map[string]map[string][]byte) kd.KubeVMOptions {
	proxy, _ := url.Parse("http://10.20.0.5:3128")
	return kd.KubeVMOptions{
		RuntimeClass: "kata",
		JobPod:       config.JobPod{CPU: "2", Memory: "4Gi", EphemeralStorage: "20Gi", OutboxSize: "1Gi", Internal: []config.InternalRangeFile{{CIDR: "10.20.0.0/16", Ports: []int{443, 3128}}}},
		Boundary:     contract.DataBoundary{Summary: "none", Denials: "actions", PublishRefs: "send"},
		Sources:      map[string]config.RepositorySourceFile{"gitlab:payments/api": {Name: "gitlab:payments/api", CloneURL: "https://gitlab.corp.example/payments/api.git", CloneSecret: "read"}},
		ReadSecret: func(_ context.Context, name string) (map[string][]byte, error) {
			if d, ok := secrets[name]; ok {
				return d, nil
			}
			return nil, errors.New("not found")
		},
		Proxy:         proxy,
		ReadProxyAuth: func() (string, error) { return "svc:pw", nil },
	}
}

func kubeVMDriver(t *testing.T, srv *kubetest.Server, o kd.KubeVMOptions) *kd.Driver {
	t.Helper()
	d, err := kd.New(kd.Options{Client: srv.Client("runner"), Namespace: ns, Instance: "kete-runner", StartTimeout: time.Hour, PollEvery: 5 * time.Millisecond,
		Pod: kd.KubeVMPod(o), Secret: kd.KubeVMSecret(o), ReadLogs: true, ImagePullGrace: time.Millisecond,
		Outbox: &kd.OutboxOptions{Size: "1Gi", MountPath: kd.OutboxPath, Hold: time.Hour}})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func spec() driver.Spec {
	cfg, _ := json.Marshal(seal.MachineConfig{JobID: jid, PlatformURL: "https://portal.kete.example", ClaimToken: strings.Repeat("ab", 32), StorageHost: "storage.kete.example", HostProfile: seal.ProfileKubeVM})
	return driver.Spec{MachineID: mid, JobID: jid, Image: img, Deadline: time.Now().Add(time.Hour), Config: cfg,
		Repository: &contract.RunRepository{Name: "gitlab:payments/api", BaseRef: "main"}}
}

func TestKubeVMPodAndSecret(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	d := kubeVMDriver(t, srv, kubeVMOptions(map[string]map[string][]byte{"read": {"username": []byte("deploy"), "token": []byte("gldt-x")}}))
	if err := d.Start(context.Background(), spec()); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(srv.Get("pods", ns, kd.PodName(mid)))
	var pod struct {
		Spec struct {
			RuntimeClassName             string
			AutomountServiceAccountToken *bool
			Volumes                      []map[string]any
			Containers                   []struct {
				Command         []string
				Env             []map[string]string
				Resources       struct{ Requests, Limits map[string]string }
				SecurityContext struct {
					Privileged, AllowPrivilegeEscalation *bool
					Capabilities                         struct{ Add, Drop []string }
				}
				VolumeMounts []map[string]any
			}
		}
	}
	_ = json.Unmarshal(raw, &pod)
	c := pod.Spec.Containers[0]
	if pod.Spec.RuntimeClassName != "kata" || *pod.Spec.AutomountServiceAccountToken || *c.SecurityContext.Privileged || *c.SecurityContext.AllowPrivilegeEscalation ||
		!slices.Equal(c.SecurityContext.Capabilities.Drop, []string{"ALL"}) || len(c.SecurityContext.Capabilities.Add) != 11 ||
		c.Resources.Requests["memory"] != "4Gi" || c.Resources.Limits["cpu"] != "2" ||
		strings.Join(c.Command, " ") != "/usr/local/libexec/kete/kete-job-entrypoint --config-file /run/kete-config/config.json" ||
		c.Env[0]["value"] != "kubevm" || len(pod.Spec.Volumes) != 2 || len(c.VolumeMounts) != 2 {
		t.Fatalf("pod %s", raw)
	}
	if srv.Get("persistentvolumeclaims", ns, kd.OutboxName(mid)) == nil {
		t.Error("no outbox PVC")
	}
	sec := srv.Get("secrets", ns, kd.PodName(mid))
	data := sec["data"].(map[string]any)
	b, _ := base64.StdEncoding.DecodeString(data["config.json"].(string))
	var jc map[string]any
	if err := json.Unmarshal(b, &jc); err != nil {
		t.Fatal(err)
	}
	local := jc["local"].(map[string]any)
	repo := local["repository"].(map[string]any)
	egress := local["egress"].(map[string]any)
	if jc["node_boot_id"] != kubetest.BootID || jc["host_profile"] != "kubevm" || repo["token"] != "gldt-x" || repo["ref"] != "main" ||
		egress["proxy"] != "http://10.20.0.5:3128" || egress["proxy_auth"] != "svc:pw" || local["shared_kernel_test"] != nil ||
		local["node_addresses"].([]any)[0] != kubetest.NodeAddress {
		t.Errorf("config.json %s", b)
	}
}

func TestKubeVMMissingCloneCredential(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	d := kubeVMDriver(t, srv, kubeVMOptions(nil))
	err := d.Start(context.Background(), spec())
	var fe *driver.FailedError
	if !errors.As(err, &fe) || fe.Reason != contract.ReasonRepositoryUnavailable {
		t.Fatalf("Start = %v", err)
	}
	if srv.Get("secrets", ns, kd.PodName(mid)) != nil {
		t.Error("a Secret was written without a credential")
	}
}

func TestPendingFailureReasons(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	d := kubeVMDriver(t, srv, kubeVMOptions(map[string]map[string][]byte{"read": {"username": []byte("u"), "token": []byte("t")}}))
	ctx := context.Background()
	if err := d.Start(ctx, spec()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond) // past ImagePullGrace
	srv.SetPodStatus(ns, kd.PodName(mid), map[string]any{"phase": "Pending", "containerStatuses": []any{map[string]any{"name": "job", "state": map[string]any{"waiting": map[string]any{"reason": "ImagePullBackOff"}}}}})
	_, err := d.Status(ctx, mid)
	var fe *driver.FailedError
	if !errors.As(err, &fe) || fe.Reason != contract.ReasonImagePullFailed {
		t.Errorf("image pull: %v", err)
	}
}

func TestLogsAreIncremental(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	d := kubeVMDriver(t, srv, kubeVMOptions(map[string]map[string][]byte{"read": {"username": []byte("u"), "token": []byte("t")}}))
	ctx := context.Background()
	if err := d.Start(ctx, spec()); err != nil {
		t.Fatal(err)
	}
	srv.SetLog(kd.PodName(mid), "a\nb\npart")
	l, err := d.Logs(ctx, mid)
	if err != nil || len(l) != 2 || string(l[1]) != "b" {
		t.Fatalf("%q %v", l, err)
	}
	srv.SetLog(kd.PodName(mid), "a\nb\npartial\nc\n")
	l, _ = d.Logs(ctx, mid)
	if len(l) != 2 || string(l[0]) != "partial" || string(l[1]) != "c" {
		t.Fatalf("%q", l)
	}
}

func TestOutboxKeptThenCollected(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	o := kubeVMOptions(map[string]map[string][]byte{"read": {"username": []byte("u"), "token": []byte("t")}})
	now := time.Now()
	clock := func() time.Time { return now }
	d, err := kd.New(kd.Options{Client: srv.Client("runner"), Namespace: ns, Instance: "kete-runner", StartTimeout: time.Hour, PollEvery: 5 * time.Millisecond,
		Pod: kd.KubeVMPod(o), Secret: kd.KubeVMSecret(o), Now: clock, Outbox: &kd.OutboxOptions{Size: "1Gi", MountPath: kd.OutboxPath, Hold: time.Hour}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	s := spec()
	s.Deadline = now.Add(time.Minute)
	if err := d.Start(ctx, s); err != nil {
		t.Fatal(err)
	}
	if err := d.Stop(ctx, mid); err != nil {
		t.Fatal(err)
	}
	if n, _ := d.CollectOutboxes(ctx); n != 0 || srv.Get("persistentvolumeclaims", ns, kd.OutboxName(mid)) == nil {
		t.Fatal("the outbox was removed with its pod")
	}
	now = now.Add(time.Minute + contract.DeadlineGrace + time.Minute + time.Hour + time.Second)
	if n, err := d.CollectOutboxes(ctx); n != 1 || err != nil || srv.Get("persistentvolumeclaims", ns, kd.OutboxName(mid)) != nil {
		t.Fatalf("collect = %d %v", n, err)
	}
}
