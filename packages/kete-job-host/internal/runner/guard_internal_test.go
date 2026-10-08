package runner

import (
	"context"
	"log/slog"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	kdriver "github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/kubernetes"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube/kubetest"
)

// The outbox StorageClass and the RuntimeClass handlers, as the guard checks them in each build.
func TestGuardStorageClassAndHandlers(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	srv.AddStorageClass("local", "rancher.io/local-path")
	srv.AddStorageClass("loose", "ebs.csi.aws.com", "nosuid")
	srv.AddStorageClass("good", "ebs.csi.aws.com", "nosuid", "nodev", "noexec")
	srv.AddRuntimeClassHandler("kata", "kata-qemu")
	srv.AddRuntimeClassHandler("fake-kata", "runc")
	g := &policyGuard{o: Options{Kube: srv.Client("x"), Log: slog.New(slog.DiscardHandler)}}
	check := func(sc string, classes ...string) string {
		g.o.Config.Kube = &config.Kubernetes{RuntimeClasses: classes, JobPod: &config.JobPod{OutboxStorageClass: sc}}
		g.check(context.Background())
		return g.blocked()
	}
	want := func(release bool) string {
		if release && !kdriver.TestBuild {
			return contract.BlockedClusterUnhealthy
		}
		return ""
	}
	if got := check("good", "kata"); got != "" {
		t.Errorf("good: %q", got)
	}
	if got := check("local", "kata"); got != want(true) {
		t.Errorf("local-path: %q", got)
	}
	if got := check("loose", "kata"); got != want(true) {
		t.Errorf("missing mount options: %q", got)
	}
	if got := check("absent", "kata"); got != contract.BlockedClusterUnhealthy {
		t.Errorf("missing StorageClass: %q", got)
	}
	if got := check("good", "fake-kata"); got != want(true) {
		t.Errorf("runc handler: %q", got)
	}
	if got := check("good", "nope"); got != contract.BlockedRuntimeClassMissing {
		t.Errorf("missing RuntimeClass: %q", got)
	}
}
