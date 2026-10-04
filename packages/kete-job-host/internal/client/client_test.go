package client

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
)

func server(t *testing.T, h http.HandlerFunc, trust bool) *Client {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	if trust {
		pool.AddCert(srv.Certificate())
	}
	addr := srv.Listener.Addr().String()
	return New("https://example.com", "example.com", time.Now, Options{RootCAs: pool, DialContext: func(ctx context.Context, n, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, n, addr)
	}})
}

var key = ed25519.NewKeyFromSeed(make([]byte, 32))

const hostID = "7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f"

func TestSignedRequest(t *testing.T) {
	var got http.Header
	c := server(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Header().Set("x-kete-request-id", "req_1")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{}`))
	}, true)
	resp, err := c.Post(context.Background(), contract.PollPath, hostID, key, []byte(`{"a":1}`), 200)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := sig.ParseSignatureInput(got.Get("Signature-Input"))
	if !ok || p.Nonce != resp.Nonce || p.KeyID != hostID || p.Expires-p.Created != 60 || resp.RequestID != "req_1" {
		t.Fatalf("params %+v ok=%v resp %+v", p, ok, resp)
	}
	if got.Get("Content-Type") != "application/json" || got.Get("Content-Digest") != sig.ContentDigest([]byte(`{"a":1}`)) {
		t.Fatalf("headers %v", got)
	}
	pub := sig.EncodeKey(key.Public().(ed25519.PublicKey))
	_, err = sig.Verify(sig.Request{Method: "POST", Authority: "example.com", Path: contract.PollPath, Body: []byte(`{"a":1}`), Now: time.Now().Unix(),
		Headers: sig.Headers{ContentType: got.Get("Content-Type"), ContentDigest: got.Get("Content-Digest"), SignatureInput: got.Get("Signature-Input"), Signature: got.Get("Signature")}},
		func(string) string { return pub })
	if err != nil {
		t.Fatalf("server-side verify: %v", err)
	}
}

func TestUntrustedCertificateRefused(t *testing.T) {
	called := false
	c := server(t, func(w http.ResponseWriter, r *http.Request) { called = true }, false)
	_, err := c.Post(context.Background(), contract.PollPath, hostID, key, []byte(`{}`), 200)
	if err == nil || called {
		t.Fatalf("untrusted server reached: %v", err)
	}
}

func TestRedirectNotFollowed(t *testing.T) {
	c := server(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != contract.PollPath {
			t.Error("redirect followed")
		}
		http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
	}, true)
	_, err := c.Post(context.Background(), contract.PollPath, hostID, key, []byte(`{}`), 200)
	if ae, ok := err.(*APIError); !ok || ae.Status != 307 {
		t.Fatalf("%v", err)
	}
}

func TestErrorResponse(t *testing.T) {
	c := server(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":{"code":"rate_limited","message":"slow down","request_id":"req 9 <bad>","reason":"rate_limited"}}`))
	}, true)
	_, err := c.Post(context.Background(), contract.PollPath, hostID, key, []byte(`{}`), 200)
	ae, ok := err.(*APIError)
	if !ok || ae.Reason != contract.ErrRateLimited || ae.RetryAfter != 7*time.Second || ae.RequestID != "" {
		t.Fatalf("%+v", err)
	}
	if strings.Contains(ae.Error(), "slow down") {
		t.Fatal("server message in the error text")
	}
}

func TestUnknownReasonAndOversize(t *testing.T) {
	c := server(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Big") == "" {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"error":{"reason":"made_up"}}`))
			return
		}
	}, true)
	_, err := c.Post(context.Background(), contract.PollPath, hostID, key, []byte(`{}`), 200)
	if ae, ok := err.(*APIError); !ok || ae.Reason != "" || ae.Status != 500 {
		t.Fatalf("%+v", err)
	}
	big := server(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write(make([]byte, contract.ResponseMaxBytes+10))
	}, true)
	if _, err := big.Post(context.Background(), contract.PollPath, hostID, key, []byte(`{}`), 200); err == nil {
		t.Fatal("oversize response accepted")
	}
	if _, err := big.Post(context.Background(), contract.EnrollPath, "x", key, make([]byte, contract.EnrollMaxBytes+1), 201); err == nil {
		t.Fatal("oversize enroll body sent")
	}
}

func TestBackoff(t *testing.T) {
	var b Backoff
	prev := time.Duration(0)
	for i := range 12 {
		d := b.Next()
		if d < MinBackoff || d > MaxBackoff {
			t.Fatalf("step %d: %v", i, d)
		}
		if i < 4 && d < prev {
			t.Fatalf("step %d shrank: %v < %v", i, d, prev)
		}
		prev = d
	}
	b.Reset()
	if d := b.Next(); d > 15*time.Second {
		t.Fatalf("after reset %v", d)
	}
	if retryAfter("999999", time.Now()) != MaxBackoff || retryAfter("x", time.Now()) != 0 {
		t.Fatal("retry-after bounds")
	}
}
