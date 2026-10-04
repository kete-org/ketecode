package platform

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
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
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["claim_token"] != "tok" || r.Header.Get("Authorization") != "" {
			t.Errorf("claim body %v", body)
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
