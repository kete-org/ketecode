package enroll

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

var token = "kete_jhe_" + strings.Repeat("t", 42) + "A"

func setup(t *testing.T, h http.Handler) (Options, *fakeplatform.Platform) {
	t.Helper()
	p := fakeplatform.New("portal.kete.example", time.Now)
	var handler http.Handler = p
	if h != nil {
		handler = h
	}
	srv, copts, err := fakeplatform.StartTLSHandler(handler, "portal.kete.example")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	cfg, err := config.Parse([]byte(`{"platform_url":"https://portal.kete.example","driver":"firecracker","slots":2,"reset":"none","image_allowlist":[],"versions":{"firecracker":"1.13.1","guest_kernel":"6.1.1"},"state_dir":"` + filepath.Join(testroot.Dir(t), "state") + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	return Options{
		Config: cfg, Client: client.New(cfg.Origin, cfg.Authority, time.Now, copts), Out: &bytes.Buffer{},
		Facts: contract.Facts{Arch: "arm64", Driver: "firecracker", Slots: 2, KVM: true, Reset: "none",
			Versions: contract.Versions{Agent: "0.1.0", HostKernel: "6.8.0", Firecracker: "1.13.1", GuestKernel: "6.1.1"}},
	}, p
}

func TestEnroll(t *testing.T) {
	o, p := setup(t, nil)
	p.AddToken(token)
	o.Token = strings.NewReader(token + "\n")
	st, err := Run(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	k, err := keys.Load(keys.Dir(o.Config.StateDir))
	if err != nil || st.Fingerprint != k.Fingerprint() || !contract.ValidGeneration(st.Generation) || st.EnrolledStatus != "pending" {
		t.Fatalf("%+v %v", st, err)
	}
	h := p.HostSnapshot(st.HostID)
	if h.Status != "pending" || h.Facts.Generation != st.Generation {
		t.Fatalf("platform host %+v", h)
	}
	// Already enrolled.
	p.AddToken(token)
	o.Token = strings.NewReader(token)
	if _, err := Run(context.Background(), o); err == nil || !strings.Contains(err.Error(), "already enrolled") {
		t.Fatalf("second enroll: %v", err)
	}
	// --replace: new keys, new identity.
	o.Replace = true
	o.Token = strings.NewReader(token)
	st2, err := Run(context.Background(), o)
	if err != nil || st2.HostID == st.HostID || st2.Fingerprint == st.Fingerprint {
		t.Fatalf("replace: %+v %v", st2, err)
	}
}

func TestEnrollRefusals(t *testing.T) {
	t.Run("token unknown", func(t *testing.T) {
		o, _ := setup(t, nil)
		o.Token = strings.NewReader(token)
		if _, err := Run(context.Background(), o); err == nil || !strings.Contains(err.Error(), "new one") {
			t.Fatalf("%v", err)
		}
		if st, _ := state.Load(state.Path(o.Config.StateDir)); st.Enrolled() {
			t.Fatal("enrolled with a refused token")
		}
	})
	t.Run("token spent by the first attempt", func(t *testing.T) {
		o, p := setup(t, nil)
		p.AddToken(token)
		o.Token = strings.NewReader(token)
		if _, err := Run(context.Background(), o); err != nil {
			t.Fatal(err)
		}
		o2, _ := setup(t, p)
		o2.Token = strings.NewReader(token)
		if _, err := Run(context.Background(), o2); err == nil {
			t.Fatal("token reused")
		}
	})
	t.Run("bad stdin", func(t *testing.T) {
		for _, in := range []string{"", "kete_jhe_short", strings.Repeat("a", 300), token + " extra"} {
			o, _ := setup(t, nil)
			o.Token = strings.NewReader(in)
			if _, err := Run(context.Background(), o); err == nil {
				t.Errorf("accepted %.20q", in)
			}
		}
	})
	t.Run("key in use removes the keys", func(t *testing.T) {
		o, _ := setup(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"error":{"code":"conflict","message":"x","request_id":"r","reason":"key_in_use"}}`))
		}))
		o.Token = strings.NewReader(token)
		if _, err := Run(context.Background(), o); err == nil || keys.Exists(keys.Dir(o.Config.StateDir)) || keys.Staged(keys.Dir(o.Config.StateDir)) {
			t.Fatalf("%v, keys kept", err)
		}
	})
	t.Run("response with another fingerprint", func(t *testing.T) {
		o, _ := setup(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(contract.EnrollResponse{HostID: "7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f", Status: "pending", Fingerprint: strings.Repeat("0", 64), NextPollAfter: 30})
		}))
		o.Token = strings.NewReader(token)
		if _, err := Run(context.Background(), o); err == nil {
			t.Fatal("accepted a mismatched fingerprint")
		}
		if st, _ := state.Load(state.Path(o.Config.StateDir)); st.Enrolled() {
			t.Fatal("state written")
		}
	})
}

// TestReplaceKeepsOldIdentityOnFailure: `enroll --replace` stages the new keys and installs them
// (then the state) only after a valid 201; every failure leaves the old keys and state intact.
func TestReplaceKeepsOldIdentityOnFailure(t *testing.T) {
	var mode atomic.Value
	mode.Store("")
	var plat atomic.Pointer[fakeplatform.Platform]
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mode.Load() == "5xx" {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"error":{"code":"unavailable","message":"x","request_id":"r","reason":"unavailable"}}`))
			return
		}
		plat.Load().ServeHTTP(w, r)
	})
	o, p := setup(t, h)
	plat.Store(p)
	p.AddToken(token)
	o.Token = strings.NewReader(token)
	first, err := Run(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	kdir := keys.Dir(o.Config.StateDir)
	intact := func(t *testing.T) {
		t.Helper()
		k, err := keys.Load(kdir)
		st, err2 := state.Load(state.Path(o.Config.StateDir))
		if err != nil || err2 != nil || k.Fingerprint() != first.Fingerprint || st.HostID != first.HostID || st.Fingerprint != first.Fingerprint {
			t.Fatalf("old identity changed: %v %v", err, err2)
		}
		if keys.Staged(kdir) {
			t.Fatal("staged keys left behind")
		}
	}
	o.Replace = true
	for _, c := range []struct{ name, mode, token string }{
		{"network failure", "unreachable", token},
		{"invalid token", "", token}, // spent by the first enrollment
		{"5xx", "5xx", token},
	} {
		t.Run(c.name, func(t *testing.T) {
			mode.Store(c.mode)
			p.SetUnreachable(c.mode == "unreachable")
			defer p.SetUnreachable(false)
			o.Token = strings.NewReader(c.token)
			if _, err := Run(context.Background(), o); err == nil {
				t.Fatal("succeeded")
			}
			intact(t)
		})
	}
	mode.Store("")
	t.Run("success replaces both", func(t *testing.T) {
		p.AddToken(token)
		o.Token = strings.NewReader(token)
		st, err := Run(context.Background(), o)
		if err != nil {
			t.Fatal(err)
		}
		k, _ := keys.Load(kdir)
		if k.Fingerprint() != st.Fingerprint || st.Fingerprint == first.Fingerprint || st.HostID == first.HostID || keys.Staged(kdir) {
			t.Fatalf("%+v", st)
		}
	})
}

// TestTokenFile: R1 boot enrollment reads the token from a root-only file and removes it once the
// platform answered (accepted or refused), keeping it after a transport error.
func TestTokenFile(t *testing.T) {
	writeToken := func(t *testing.T, o Options, mode os.FileMode) string {
		t.Helper()
		dir := filepath.Join(filepath.Dir(o.Config.StateDir), "etc")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, "enroll.token")
		if err := os.WriteFile(p, []byte(token+"\n"), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	exists := func(p string) bool { _, err := os.Lstat(p); return err == nil }

	t.Run("accepted", func(t *testing.T) {
		o, p := setup(t, nil)
		p.AddToken(token)
		o.TokenFile = writeToken(t, o, 0o600)
		o.Token = strings.NewReader("ignored")
		if _, err := Run(context.Background(), o); err != nil {
			t.Fatal(err)
		}
		if exists(o.TokenFile) {
			t.Fatal("token file kept after a 201")
		}
	})
	t.Run("refused", func(t *testing.T) {
		o, _ := setup(t, nil) // the token is unknown to the platform
		o.TokenFile = writeToken(t, o, 0o600)
		if _, err := Run(context.Background(), o); err == nil {
			t.Fatal("accepted an unknown token")
		}
		if exists(o.TokenFile) {
			t.Fatal("token file kept after a refusal (the token is spent)")
		}
	})
	t.Run("network error", func(t *testing.T) {
		o, p := setup(t, nil)
		p.AddToken(token)
		p.SetUnreachable(true)
		o.TokenFile = writeToken(t, o, 0o600)
		if _, err := Run(context.Background(), o); err == nil {
			t.Fatal("enrolled while unreachable")
		}
		if !exists(o.TokenFile) {
			t.Fatal("token file removed after a transport error (it is still valid)")
		}
		p.SetUnreachable(false)
		if _, err := Run(context.Background(), o); err != nil {
			t.Fatalf("retry: %v", err)
		}
	})
	t.Run("malformed", func(t *testing.T) {
		o, _ := setup(t, nil)
		o.TokenFile = writeToken(t, o, 0o600)
		if err := os.WriteFile(o.TokenFile, []byte("not-a-token\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Run(context.Background(), o); err == nil {
			t.Fatal("accepted a malformed token")
		}
		if exists(o.TokenFile) {
			t.Fatal("malformed token file kept (it would be retried forever)")
		}
	})
	t.Run("transient 5xx", func(t *testing.T) {
		h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"error":{"code":"unavailable","message":"x","request_id":"r","reason":"unavailable"}}`))
		})
		o, _ := setup(t, h)
		o.TokenFile = writeToken(t, o, 0o600)
		if _, err := Run(context.Background(), o); err == nil {
			t.Fatal("enrolled on a 503")
		}
		if !exists(o.TokenFile) {
			t.Fatal("token file removed after a transient 503")
		}
	})
	t.Run("loose mode", func(t *testing.T) {
		o, p := setup(t, nil)
		p.AddToken(token)
		o.TokenFile = writeToken(t, o, 0o644)
		if _, err := Run(context.Background(), o); err == nil {
			t.Fatal("accepted a world-readable token file")
		}
	})
	t.Run("symlink", func(t *testing.T) {
		o, p := setup(t, nil)
		p.AddToken(token)
		real := writeToken(t, o, 0o600)
		link := real + ".link"
		if err := os.Symlink(real, link); err != nil {
			t.Fatal(err)
		}
		o.TokenFile = link
		if _, err := Run(context.Background(), o); err == nil {
			t.Fatal("followed a symlink")
		}
	})
}

// TestEnrollRefusesSpentGeneration: a dedicated host whose generation ran a job only gets a new
// identity through a reset (a fresh disk), never by re-enrolling (ADR 0023 rule 8).
func TestEnrollRefusesSpentGeneration(t *testing.T) {
	o, p := setup(t, nil)
	p.AddToken(token)
	o.Token = strings.NewReader(token)
	st, err := Run(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	st.GenerationSpentBy = "3f6b9d2a-8c41-4e7f-b5a0-9d1c2e3f4a5b"
	if err := state.Save(state.Path(o.Config.StateDir), st); err != nil {
		t.Fatal(err)
	}
	p.AddToken(token)
	o.Token, o.Replace = strings.NewReader(token), true
	if _, err := Run(context.Background(), o); err == nil || !strings.Contains(err.Error(), "must be reset") {
		t.Fatalf("re-enrolled a spent generation: %v", err)
	}
}
