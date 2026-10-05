package platform

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const jobID = "0b9a3c1e-2f4d-4e6a-8b7c-1d2e3f4a5b6c"

func newClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	c := New(Options{BaseURL: srv.URL, JobID: jobID, StorageHost: "storage.kete.test", Timeout: 5 * time.Second, ClaimTries: 5, ClaimWindow: 10 * time.Second, Backoff: 10 * time.Millisecond})
	if srv.TLS != nil {
		ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
		if err := c.SetCA(ca); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

func TestClaimSuccessAndStatuses(t *testing.T) {
	var status atomic.Int32
	status.Store(200)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/jobs/"+jobID+"/claim" || r.Method != http.MethodPost {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		// jobs-v1 additive (2026-10-05): the claim announces clone_revoke_callback.
		if string(raw) != `{"claim_token":"tok","features":["clone_revoke_callback"]}` || r.Header.Get("Authorization") != "" {
			t.Errorf("claim body %s", raw)
		}
		w.WriteHeader(int(status.Load()))
		_, _ = io.WriteString(w, `{"callback_token":"cb","extra":1}`)
	}))
	defer srv.Close()
	c := newClient(t, srv)
	resp, err := c.Claim(context.Background(), "tok")
	if err != nil || resp.CallbackToken != "cb" {
		t.Fatalf("claim = %+v, %v", resp, err)
	}
	status.Store(409)
	if _, err := c.Claim(context.Background(), "tok"); err != ErrReplayed {
		t.Errorf("409: %v", err)
	}
	status.Store(404)
	if _, err := c.Claim(context.Background(), "tok"); err != ErrGone {
		t.Errorf("404: %v", err)
	}
}

// A claim whose request was written is never retried (a second claim would fail the job).
func TestClaimNotRetriedAfterWrite(t *testing.T) {
	var n atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		_, _ = io.ReadAll(r.Body)
		hj, _ := w.(http.Hijacker)
		conn, _, _ := hj.Hijack()
		_ = conn.Close()
	}))
	srv.StartTLS()
	defer srv.Close()
	c := newClient(t, srv)
	if _, err := c.Claim(context.Background(), "tok"); err == nil {
		t.Fatal("claim succeeded")
	}
	if n.Load() != 1 {
		t.Errorf("claim sent %d times", n.Load())
	}
}

// A claim that never reached the server (dial refused) is retried.
func TestClaimRetriedBeforeWrite(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	c := newClient(t, srv)
	c.o.BaseURL = "https://" + addr
	start := time.Now()
	if _, err := c.Claim(context.Background(), "tok"); err == nil {
		t.Fatal("claim succeeded")
	}
	// 5 tries with 10, 20, 40, 80 ms backoff.
	if time.Since(start) < 140*time.Millisecond {
		t.Errorf("not retried (took %v)", time.Since(start))
	}
}

func TestCallbacks(t *testing.T) {
	var resultTries atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer cb" {
			w.WriteHeader(404)
			return
		}
		body, _ := io.ReadAll(r.Body)
		switch {
		case strings.HasSuffix(r.URL.Path, "/events"):
			if strings.Contains(string(body), `"message"`) && len(body) > 600 {
				t.Errorf("message not cut: %d", len(body))
			}
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/result"):
			if resultTries.Add(1) < 3 {
				w.WriteHeader(503)
				return
			}
			if string(body) != `{"version":1}` {
				t.Errorf("result not verbatim: %s", body)
			}
			w.WriteHeader(204)
		case strings.HasSuffix(r.URL.Path, "/uploads"):
			_, _ = io.WriteString(w, `{"audit":{"url":"https://storage.kete.test/u/1?token=x"},"proxy_log":{"url":"https://storage.kete.test/u/2?token=y"},"bundle":{"url":"https://storage.kete.test/u/3?token=z"}}`)
		case strings.HasSuffix(r.URL.Path, "/finish"):
			if string(body) != `{"push_error":"symlink"}` {
				t.Errorf("finish body %s", body)
			}
			w.WriteHeader(202)
		}
	}))
	defer srv.Close()
	c := newClient(t, srv)
	if err := c.Events(context.Background(), Event{Phase: "agent"}); err != ErrGone {
		t.Errorf("no bearer: %v", err)
	}
	c.SetCallbackToken("cb")
	if err := c.Events(context.Background(), Event{Phase: "agent", Message: strings.Repeat("m", 800)}); err != nil {
		t.Errorf("events: %v", err)
	}
	if err := c.Result(context.Background(), []byte(`{"version":1}`)); err != nil || resultTries.Load() != 3 {
		t.Errorf("result: %v after %d tries", err, resultTries.Load())
	}
	u, err := c.Uploads(context.Background(), true)
	if err != nil || u.Host != "storage.kete.test" || u.Bundle == nil {
		t.Errorf("uploads = %+v, %v", u, err)
	}
	if err := c.Finish(context.Background(), "symlink"); err != nil {
		t.Errorf("finish: %v", err)
	}
}

func TestParseUploads(t *testing.T) {
	bad := []string{
		`{"audit":{"url":"http://s.test/a"},"proxy_log":{"url":"https://s.test/b"}}`,
		`{"audit":{"url":"https://s.test/a"},"proxy_log":{"url":"https://t.test/b"}}`,
		`{"audit":{"url":"https://t.test/a"},"proxy_log":{"url":"https://t.test/b"}}`,
		`{"audit":{"url":"https://s.test:8443/a"},"proxy_log":{"url":"https://s.test/b"}}`,
		`{"audit":{"url":"https://10.0.0.1/a"},"proxy_log":{"url":"https://10.0.0.1/b"}}`,
	}
	for _, b := range bad {
		if _, err := ParseUploads([]byte(b), false, "s.test"); err == nil {
			t.Errorf("%s accepted", b)
		}
	}
	if _, err := ParseUploads([]byte(`{"audit":{"url":"https://s.test/a"},"proxy_log":{"url":"https://s.test:443/b"}}`), false, "s.test"); err != nil {
		t.Errorf("the pinned host refused: %v", err)
	}
	if _, err := ParseUploads([]byte(`{"audit":{"url":"https://s.test/a"},"proxy_log":{"url":"https://s.test/b"}}`), true, "s.test"); err == nil {
		t.Error("missing bundle URL accepted")
	}
}

func validClaim() *ClaimResponse {
	c := &ClaimResponse{
		Spec:       json.RawMessage(`{"version":1,"prompt":"p","policy":{"version":1,"budget":5,"timeout":30},"branch":"kete/job/x"}`),
		GatewayKey: "gk", CallbackToken: "cb", GatewayURL: "https://gateway.kete.test",
		PlatformURL: "https://platform.kete.test", Deadline: time.Now().Add(time.Hour).Format(time.RFC3339),
	}
	c.Clone.URL, c.Clone.Token, c.Clone.Ref, c.Clone.BaseSHA = "https://github.com/o/r.git", "ct", "main", strings.Repeat("a", 40)
	return c
}

func TestValidateClaim(t *testing.T) {
	cl, field := validClaim().Validate("https://platform.kete.test", "storage.kete.test", time.Now())
	if cl == nil {
		t.Fatalf("valid claim refused: %s", field)
	}
	if cl.CloneHost != "github.com" || cl.GatewayHost != "gateway.kete.test" || cl.PolicyTimeout != 30 || cl.Branch != "kete/job/x" || cl.CallbackToken != "cb" {
		t.Errorf("claim = %+v", cl)
	}
	cases := map[string]func(*ClaimResponse){
		"callback_token":      func(c *ClaimResponse) { c.CallbackToken = "" },
		"platform_url":        func(c *ClaimResponse) { c.PlatformURL = "https://other.kete.test" },
		"deadline":            func(c *ClaimResponse) { c.Deadline = time.Now().Add(-time.Minute).Format(time.RFC3339) },
		"gateway_url":         func(c *ClaimResponse) { c.GatewayURL = "http://gateway.kete.test" },
		"clone.url":           func(c *ClaimResponse) { c.Clone.URL = "https://u:p@github.com/o/r" },
		"clone.ref":           func(c *ClaimResponse) { c.Clone.Ref = "-x" },
		"clone.base_sha":      func(c *ClaimResponse) { c.Clone.BaseSHA = "abc" },
		"spec.version":        func(c *ClaimResponse) { c.Spec = json.RawMessage(`{"version":2}`) },
		"spec.policy.timeout": func(c *ClaimResponse) { c.Spec = json.RawMessage(`{"version":1,"policy":{"timeout":0},"branch":"b"}`) },
		"spec.branch": func(c *ClaimResponse) {
			c.Spec = json.RawMessage(`{"version":1,"policy":{"timeout":3},"branch":"a..b"}`)
		},
		"spec": func(c *ClaimResponse) { c.Spec = json.RawMessage(`[1]`) },
	}
	for _, host := range []string{"gateway.kete.test", "github.com", "api.github.com", ""} {
		if cl, field := validClaim().Validate("https://platform.kete.test", host, time.Now()); cl != nil || field != "storage_host" {
			t.Errorf("storage host %q: field = %q", host, field)
		}
	}
	for want, mod := range cases {
		c := validClaim()
		mod(c)
		if cl, field := c.Validate("https://platform.kete.test", "storage.kete.test", time.Now()); cl != nil || field != want {
			t.Errorf("%s: field = %q", want, field)
		}
	}
	if h, u := RevokeURL("github.com"); h != "api.github.com" || u != "https://api.github.com/installation/token" {
		t.Error("github revoke")
	}
	if h, u := RevokeURL("github.kete.test"); h != "github.kete.test" || u != "https://github.kete.test/api/v3/installation/token" {
		t.Error("ghes revoke")
	}
}

func TestCloneDone(t *testing.T) {
	var tries atomic.Int32
	var fail atomic.Int32 // answer 500 to the first n tries
	var status atomic.Int32
	status.Store(204)
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/jobs/"+jobID+"/clone-done" || r.Header.Get("Authorization") != "Bearer cb" || string(body) != "{}" {
			t.Errorf("clone-done request %s %s %q %s", r.Method, r.URL.Path, r.Header.Get("Authorization"), body)
		}
		if tries.Add(1) <= fail.Load() {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(int(status.Load()))
	}))
	defer srv.Close()
	c := newClient(t, srv)
	c.SetCallbackToken("cb")
	ctx := context.Background()

	if err := c.CloneDone(ctx); err != nil || tries.Load() != 1 {
		t.Errorf("success: %v after %d tries", err, tries.Load())
	}
	tries.Store(0)
	fail.Store(2)
	if err := c.CloneDone(ctx); err != nil || tries.Load() != 3 {
		t.Errorf("retried success: %v after %d tries", err, tries.Load())
	}
	tries.Store(0)
	fail.Store(5)
	if err := c.CloneDone(ctx); err == nil || tries.Load() != 3 {
		t.Errorf("three failures: %v after %d tries (want an error after 3)", err, tries.Load())
	}
	tries.Store(0)
	fail.Store(0)
	status.Store(404)
	if err := c.CloneDone(ctx); err != ErrGone || tries.Load() != 1 {
		t.Errorf("404: %v after %d tries", err, tries.Load())
	}
	tries.Store(0)
	status.Store(409)
	var se *StatusError
	if err := c.CloneDone(ctx); !errors.As(err, &se) || se.Status != 409 || tries.Load() != 1 {
		t.Errorf("409: %v after %d tries (a 4xx is not retried)", err, tries.Load())
	}
}

func TestValidateClaimProvider(t *testing.T) {
	raw := func(s string) json.RawMessage { return json.RawMessage(s) }
	// Absent: GitHub, x-access-token, the revoke API host.
	cl, field := validClaim().Validate("https://platform.kete.test", "storage.kete.test", time.Now())
	if cl == nil || cl.CloneProvider != ProviderGitHub || cl.CloneUsername != "x-access-token" || cl.CloneAPIHost != "api.github.com" {
		t.Fatalf("default provider: %+v %s", cl, field)
	}
	// Explicit github with a username.
	c := validClaim()
	c.Clone.Provider, c.Clone.Username = raw(`"github"`), raw(`"bot"`)
	if cl, field := c.Validate("https://platform.kete.test", "storage.kete.test", time.Now()); cl == nil || cl.CloneUsername != "bot" || cl.CloneAPIHost != "api.github.com" {
		t.Errorf("explicit github: %+v %s", cl, field)
	}
	// Harness Code: no API host.
	c = validClaim()
	c.Clone.URL = "https://git.harness.io/acct/default/shop/web.git"
	c.Clone.Provider, c.Clone.Username = raw(`"harness_code"`), raw(`"kete_code_clone"`)
	cl, field = c.Validate("https://platform.kete.test", "storage.kete.test", time.Now())
	if cl == nil || cl.CloneProvider != ProviderHarnessCode || cl.CloneUsername != "kete_code_clone" || cl.CloneAPIHost != "" || cl.CloneHost != "git.harness.io" {
		t.Fatalf("harness: %+v %s", cl, field)
	}
	// Harness Code without a username uses the default.
	c.Clone.Username = nil
	if cl, _ := c.Validate("https://platform.kete.test", "storage.kete.test", time.Now()); cl == nil || cl.CloneUsername != "x-access-token" {
		t.Error("harness default username")
	}
	// The storage-host check compares with the clone host only (no API host for Harness).
	if cl, field := c.Validate("https://platform.kete.test", "git.harness.io", time.Now()); cl != nil || field != "storage_host" {
		t.Errorf("harness storage host = clone host: %s", field)
	}
	if cl, _ := c.Validate("https://platform.kete.test", "api.github.com", time.Now()); cl == nil {
		t.Error("harness: GitHub's API host refused as the storage host")
	}

	bad := map[string][2]json.RawMessage{
		"unknown provider": {raw(`"gitlab"`), nil},
		"empty provider":   {raw(`""`), nil},
		"null provider":    {raw(`null`), nil},
		"number provider":  {raw(`1`), nil},
		"upper provider":   {raw(`"GITHUB"`), nil},
	}
	for name, v := range bad {
		c := validClaim()
		c.Clone.Provider, c.Clone.Username = v[0], v[1]
		if cl, field := c.Validate("https://platform.kete.test", "storage.kete.test", time.Now()); cl != nil || field != "clone.provider" {
			t.Errorf("%s: field = %q", name, field)
		}
	}
	for name, u := range map[string]string{
		"colon":     `"user:name"`,
		"empty":     `""`,
		"space":     `"a b"`,
		"control":   `"a\u0001b"`,
		"non-ascii": `"usér"`,
		"too long":  `"` + strings.Repeat("u", 129) + `"`,
		"null":      `null`,
		"number":    `7`,
	} {
		c := validClaim()
		c.Clone.Username = raw(u)
		if cl, field := c.Validate("https://platform.kete.test", "storage.kete.test", time.Now()); cl != nil || field != "clone.username" {
			t.Errorf("username %s: field = %q", name, field)
		}
	}
	c = validClaim()
	c.Clone.Username = raw(`"` + strings.Repeat("u", 128) + `"`)
	if cl, _ := c.Validate("https://platform.kete.test", "storage.kete.test", time.Now()); cl == nil {
		t.Error("a 128-byte username refused")
	}
}

// The shared test vector (kete-code-platform docs/contracts/test-vectors/jobs-v1, copied byte
// for byte into internal/fakeplatform/testdata): our claim request equals its request's shape,
// and its response validates as a Harness Code claim.
func TestHarnessCodeVector(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "fakeplatform", "testdata", "jobs-v1", "claim-harness-code.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Request  ClaimRequest    `json:"request"`
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	ours, _ := json.Marshal(ClaimRequest{ClaimToken: v.Request.ClaimToken, Features: []string{FeatureCloneRevokeCallback}})
	theirs, _ := json.Marshal(v.Request)
	if string(ours) != string(theirs) {
		t.Errorf("claim request %s, vector %s", ours, theirs)
	}
	resp, err := ParseClaim(v.Response)
	if err != nil {
		t.Fatal(err)
	}
	// The vector's deadline is fixed; validate just before it.
	dl, _ := time.Parse(time.RFC3339, resp.Deadline)
	cl, field := resp.Validate("https://portal.kete.example", "storage.kete.example", dl.Add(-time.Minute))
	if cl == nil {
		t.Fatalf("vector refused: %s", field)
	}
	if cl.CloneProvider != ProviderHarnessCode || cl.CloneUsername != "kete_code_clone" || cl.CloneHost != "git.harness.io" || cl.CloneAPIHost != "" {
		t.Errorf("vector claim = %+v", cl)
	}
}
