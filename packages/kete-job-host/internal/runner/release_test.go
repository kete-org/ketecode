//go:build !kete_testdriver

package runner_test

import (
	"context"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/clock"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube/kubetest"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/runner"
)

// A release build refuses the placeholder pod driver before it takes the Lease or enrolls.
func TestReleaseBuildRefusesPlaceholder(t *testing.T) {
	c, err := config.Parse([]byte(`{"platform_url":"https://portal.kete.example","driver":"kubernetes","slots":1,"reset":"none",
	  "image_allowlist":["docker.io/library/busybox@sha256:1111111111111111111111111111111111111111111111111111111111111111"],
	  "kubernetes":{"namespace":"kete-system","jobs_namespace":"kete-jobs","instance":"kete-runner","admission_policies":["p"],"runtime_class_names":["kata"],"pod_driver":"placeholder"}}`))
	if err != nil {
		t.Fatal(err)
	}
	srv := kubetest.New()
	defer srv.Close()
	err = runner.Run(context.Background(), runner.Options{Config: c, Kube: srv.Client("x"), Identity: "p", Clock: clock.Fixed(true)})
	if err == nil || !strings.Contains(err.Error(), "test builds") {
		t.Fatalf("Run = %v", err)
	}
	if len(srv.Writes) != 0 {
		t.Fatalf("writes before refusing: %v", srv.Writes)
	}
}

// A release build refuses kind CI's runc-backed kete-test RuntimeClass, whatever the pod driver,
// before it takes the Lease or enrolls.
func TestReleaseBuildRefusesSharedKernelTestClass(t *testing.T) {
	c, err := config.Parse([]byte(`{"platform_url":"https://portal.kete.example","driver":"kubernetes","slots":1,"reset":"none",
	  "image_allowlist":["docker.io/library/busybox@sha256:1111111111111111111111111111111111111111111111111111111111111111"],
	  "kubernetes":{"namespace":"kete-system","jobs_namespace":"kete-jobs","instance":"kete-runner","admission_policies":["p"],"runtime_class_names":["kete-test"],
	    "repositories":["gitlab:a/b"],"repository_sources":[{"name":"gitlab:a/b","clone_url":"https://git.example/a/b.git","clone_secret":"s"}],
	    "pod_driver":"kubevm","job_pod":{"cpu":"1","memory":"1Gi","ephemeral_storage":"1Gi","outbox_size":"1Gi"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	srv := kubetest.New()
	defer srv.Close()
	err = runner.Run(context.Background(), runner.Options{Config: c, Kube: srv.Client("x"), Identity: "p", Clock: clock.Fixed(true)})
	if err == nil || !strings.Contains(err.Error(), "kete-test") {
		t.Fatalf("Run = %v", err)
	}
	if len(srv.Writes) != 0 {
		t.Fatalf("writes before refusing: %v", srv.Writes)
	}
}
