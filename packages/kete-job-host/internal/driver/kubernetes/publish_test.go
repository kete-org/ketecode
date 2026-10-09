package kubernetes

import (
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube/kubetest"
)

func TestParseOutcome(t *testing.T) {
	for raw, ok := range map[string]bool{
		`{"status":"created","base_sha":"` + strings.Repeat("a", 40) + `","commit_sha":"` + strings.Repeat("b", 40) + `"}`: true,
		`{"status":"refused","reason":"branch_exists"}`:                                                                    true,
		`{"status":"refused"}`:                                                    false,
		`{"status":"created","reason":"branch_exists"}`:                           false,
		`{"status":"failed","reason":"publisher_failed","extra":1}`:               false,
		`{"status":"no_changes"} trailing`:                                        false,
		`{"status":"created","mr":{"iid":1,"url":"http://gitlab.example/x/-/1"}}`: false,
		``: false,
	} {
		if _, got := ParseOutcome([]byte(raw)); got != ok {
			t.Errorf("%s: %v", raw, got)
		}
	}
	if _, got := ParseOutcome([]byte(strings.Repeat(" ", MaxOutcome+1))); got {
		t.Error("an oversized message was accepted")
	}
}

func TestPublishPodRefusesBadRequests(t *testing.T) {
	ks := kubetest.New()
	defer ks.Close()
	d, err := New(Options{Client: ks.Client("u"), Namespace: "kete-jobs", Instance: "r", Pod: func(driver.Spec) (kube.Pod, error) { return kube.Pod{}, nil },
		Outbox: &OutboxOptions{Size: "1Gi", MountPath: OutboxPath},
		Publish: &PublishOptions{Image: "r@sha256:" + strings.Repeat("1", 64), RuntimeClass: "kata", ConfigMap: "kete-publisher", CPU: "500m", Memory: "512Mi",
			Timeout: 15 * time.Minute, Writers: map[string]string{"gitlab:a/b": "w"}}})
	if err != nil {
		t.Fatal(err)
	}
	good := driver.PublishSpec{MachineID: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", JobID: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
		Repository: contract.RunRepository{Name: "gitlab:a/b", BaseRef: "main"}, Branch: "kete/job/x1"}
	if _, err := d.PublishPod(good); err != nil || !d.CanPublish("gitlab:a/b") || d.CanPublish("gitlab:c/d") {
		t.Fatal(err)
	}
	for name, mut := range map[string]func(*driver.PublishSpec){
		"no writer":      func(s *driver.PublishSpec) { s.Repository.Name = "gitlab:c/d" },
		"bad branch":     func(s *driver.PublishSpec) { s.Branch = "main" },
		"flag injection": func(s *driver.PublishSpec) { s.Repository.BaseRef = "--config=/x" },
		"bad machine":    func(s *driver.PublishSpec) { s.MachineID = "x" },
	} {
		s := good
		mut(&s)
		if _, err := d.PublishPod(s); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
