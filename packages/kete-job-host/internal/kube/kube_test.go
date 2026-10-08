package kube_test

import (
	"context"
	"crypto/rand"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube/kubetest"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

const ns = "kete-system"

func fastElector(c *kube.Client, id string) *kube.Elector {
	return &kube.Elector{Client: c, Namespace: ns, Name: "kete-runner", Identity: id,
		Duration: 600 * time.Millisecond, RenewDeadline: 400 * time.Millisecond, Retry: 50 * time.Millisecond}
}

func TestLeaseSingleHolderAndHandover(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a := fastElector(srv.Client("a"), "pod-a")
	if err := a.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	actx, stopA := context.WithCancel(ctx)
	aDone := make(chan error, 1)
	go func() { aDone <- a.Hold(actx) }()

	b := fastElector(srv.Client("b"), "pod-b")
	bctx, bcancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	if err := b.Acquire(bctx); err == nil {
		t.Fatal("b acquired a lease a keeps renewing")
	}
	bcancel()
	stopA() // a releases on shutdown
	if err := <-aDone; err != nil {
		t.Fatalf("hold: %v", err)
	}
	start := time.Now()
	if err := b.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatalf("released lease taken only after %s", time.Since(start))
	}
	if h := srv.Get("leases", ns, "kete-runner")["spec"].(map[string]any)["holderIdentity"]; h != "pod-b" {
		t.Fatalf("holder %v", h)
	}
}

func TestLeaseExpiresWhenHolderStops(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a := fastElector(srv.Client("a"), "pod-a")
	if err := a.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	// a crashes (never renews, never releases): b takes over after a lease duration.
	b := fastElector(srv.Client("b"), "pod-b")
	start := time.Now()
	if err := b.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d < 500*time.Millisecond {
		t.Fatalf("b took a live lease after %s", d)
	}
	// a notices it lost the lease.
	if err := a.Hold(ctx); !errors.Is(err, kube.ErrLost) {
		t.Fatalf("a.Hold = %v, want ErrLost", err)
	}
}

func TestLeaseLostWhenAPIServerFails(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	a := fastElector(srv.Client("a"), "pod-a")
	if err := a.Acquire(ctx); err != nil {
		t.Fatal(err)
	}
	srv.Set(func(s *kubetest.Server) { s.Fail = true })
	if err := a.Hold(ctx); !errors.Is(err, kube.ErrLost) {
		t.Fatalf("Hold = %v, want ErrLost past the renew deadline", err)
	}
}

func TestSecretStoreRoundTripAndFailures(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	st := &kube.SecretStore{Client: srv.Client("runner"), Namespace: ns, Name: "kete-runner-state"}
	empty, err := st.LoadContext(ctx)
	if err != nil || empty.Enrolled() || empty.Version != state.Version {
		t.Fatalf("empty load: %+v %v", empty, err)
	}
	rctx, stop := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); st.Run(rctx) }()
	defer func() { stop(); wg.Wait() }()

	s := state.State{Version: state.Version, HostID: "7d0f3c2e-5b1a-4c8e-9f60-000000000001", Generation: "k8s-1",
		Fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", Machines: []state.Machine{}}
	if err := st.Save(s); err != nil {
		t.Fatal(err)
	}
	if err := st.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	rev := int64(4)
	s.AppliedRevision = &rev
	_ = st.Save(s)
	if err := st.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	other := &kube.SecretStore{Client: srv.Client("runner"), Namespace: ns, Name: "kete-runner-state"}
	got, err := other.LoadContext(ctx)
	if err != nil || got.HostID != s.HostID || got.AppliedRevision == nil || *got.AppliedRevision != 4 {
		t.Fatalf("reload: %+v %v", got, err)
	}
	if err := st.Save(state.State{Version: 9}); err == nil {
		t.Fatal("an invalid state was accepted")
	}

	// A failing API server: Save reports the background failure (starts blocked), and recovers.
	srv.Set(func(s *kubetest.Server) { s.Fail = true })
	_ = st.Save(s)
	fctx, fcancel := context.WithTimeout(ctx, 300*time.Millisecond)
	_ = st.Flush(fctx)
	fcancel()
	if err := st.Save(s); err == nil {
		t.Fatal("Save didn't report the failed background write")
	}
	srv.Set(func(s *kubetest.Server) { s.Fail = false })
	if err := st.Flush(ctx); err != nil {
		t.Fatalf("flush after recovery: %v", err)
	}
	if err := st.Save(s); err != nil {
		t.Fatalf("Save after recovery: %v", err)
	}

	// Another writer changes the Secret: the next write conflicts and is reported, never forced.
	sec := srv.Get("secrets", ns, "kete-runner-state")
	srv.Put("secrets", ns, sec)
	_ = st.Save(s)
	fctx, fcancel = context.WithTimeout(ctx, 300*time.Millisecond)
	_ = st.Flush(fctx)
	fcancel()
	if err := st.Save(s); err == nil {
		t.Fatal("a conflicting write was not reported")
	}
}

func TestKeySecretStageCommitLoad(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	ctx := context.Background()
	ks := kube.KeySecret{Client: srv.Client("runner"), Namespace: ns, Name: "kete-runner-keys"}
	if _, err := ks.Load(ctx); !errors.Is(err, kube.ErrNoKeys) {
		t.Fatalf("missing: %v", err)
	}
	k, err := keys.Generate(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := ks.Stage(ctx, k); err != nil {
		t.Fatal(err)
	}
	if _, err := ks.Load(ctx); !errors.Is(err, kube.ErrNoKeys) {
		t.Fatalf("staged keys were used: %v", err)
	}
	other, _ := keys.Generate(rand.Reader)
	if err := ks.Commit(ctx, other); err == nil {
		t.Fatal("committed keys that were not staged")
	}
	if err := ks.Commit(ctx, k); err != nil {
		t.Fatal(err)
	}
	got, err := ks.Load(ctx)
	if err != nil || got.Fingerprint() != k.Fingerprint() {
		t.Fatalf("load: %v", err)
	}
	// A tampered fingerprint annotation is refused.
	sec := srv.Get("secrets", ns, "kete-runner-keys")
	sec["metadata"].(map[string]any)["annotations"].(map[string]any)[kube.AnnFingerprint] = other.Fingerprint()
	srv.Put("secrets", ns, sec)
	if _, err := ks.Load(ctx); err == nil || errors.Is(err, kube.ErrNoKeys) {
		t.Fatalf("mismatched fingerprint accepted: %v", err)
	}
}

func TestNodeBootIDAndVersion(t *testing.T) {
	srv := kubetest.New()
	defer srv.Close()
	c := srv.Client("runner")
	id, err := c.NodeBootID(context.Background(), kubetest.Node)
	if err != nil || id != kubetest.BootID {
		t.Fatalf("boot id %q %v", id, err)
	}
	if _, err := c.NodeBootID(context.Background(), "nope"); !kube.IsNotFound(err) {
		t.Fatalf("missing node: %v", err)
	}
	v, err := c.ServerVersion(context.Background())
	if err != nil || v != "v1.31.2" {
		t.Fatalf("version %q %v", v, err)
	}
}
