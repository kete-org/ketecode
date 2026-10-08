package kubernetes_test

import (
	"context"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	kd "github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/kubernetes"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube/kubetest"
)

const (
	ns  = "kete-jobs"
	mid = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"
	jid = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"
)

func newDriver(t *testing.T, srv *kubetest.Server, start time.Duration) *kd.Driver {
	t.Helper()
	d, err := kd.New(kd.Options{Client: srv.Client("runner"), Namespace: ns, StartTimeout: start, PollEvery: 5 * time.Millisecond,
		Pod: func(driver.Spec) (kube.Pod, error) {
			return kube.Pod{Spec: kube.PodSpec{Containers: []kube.Container{{Name: "job", Image: "x"}}}}, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestStatusMapping(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	d := newDriver(t, srv, time.Hour)
	ctx := context.Background()
	if err := d.Start(ctx, driver.Spec{MachineID: mid, JobID: jid, Deadline: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	name := kd.PodName(mid)
	for _, c := range []struct {
		phase, reason string
		want          driver.Status
	}{
		{kube.PodPending, "", driver.StatusStarting},
		{kube.PodRunning, "", driver.StatusRunning},
		{kube.PodSucceeded, "", driver.StatusExited},
		{kube.PodFailed, "", driver.StatusExited},
		{kube.PodFailed, "DeadlineExceeded", driver.StatusCrashed},
		{kube.PodFailed, "Evicted", driver.StatusCrashed},
	} {
		srv.SetPodPhase(ns, name, c.phase, c.reason)
		if got, err := d.Status(ctx, mid); err != nil || got != c.want {
			t.Errorf("%s/%s: %v %v, want %v", c.phase, c.reason, got, err, c.want)
		}
	}
	srv.SetPodPhase(ns, name, "Unknown", "")
	if _, err := d.Status(ctx, mid); err == nil {
		t.Error("phase Unknown is not an error")
	}
	if err := d.Stop(ctx, mid); err != nil {
		t.Fatal(err)
	}
	if got, _ := d.Status(ctx, mid); got != driver.StatusGone {
		t.Fatalf("after stop: %v", got)
	}
	if err := d.Stop(ctx, mid); err != nil {
		t.Fatalf("second stop: %v", err)
	}
}

func TestPendingPastStartTimeoutCrashes(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	d := newDriver(t, srv, time.Nanosecond)
	if err := d.Start(context.Background(), driver.Spec{MachineID: mid, JobID: jid, Deadline: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1100 * time.Millisecond) // creationTimestamp has second precision
	if got, _ := d.Status(context.Background(), mid); got != driver.StatusCrashed {
		t.Fatalf("got %v", got)
	}
}

func TestStartFailsWhenNeverScheduled(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	srv.Set(func(s *kubetest.Server) { s.Unschedulable = true })
	d := newDriver(t, srv, time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := d.Start(ctx, driver.Spec{MachineID: mid, JobID: jid, Deadline: time.Now().Add(time.Hour)}); err == nil {
		t.Fatal("Start succeeded without a node")
	}
	if srv.Get("secrets", ns, kd.PodName(mid)) != nil {
		t.Fatal("the machine Secret was written before scheduling")
	}
}
