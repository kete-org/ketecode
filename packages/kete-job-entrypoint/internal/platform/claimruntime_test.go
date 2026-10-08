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
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// clientFor talks to srv while naming origin (the vector's platform URL) in requests and TLS.
func clientFor(t *testing.T, srv *httptest.Server, origin string) *Client {
	t.Helper()
	c := New(Options{BaseURL: origin, JobID: jobID, StorageHost: "storage.kete.test", Timeout: 5 * time.Second, ClaimTries: 2, ClaimWindow: 5 * time.Second, Backoff: 10 * time.Millisecond})
	if err := c.SetCA(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})); err != nil {
		t.Fatal(err)
	}
	tr := c.hc.Transport.(*http.Transport)
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	tr.TLSClientConfig.ServerName = "example.com" // httptest's certificate names example.com
	return c
}

func TestClaimRuntime(t *testing.T) {
	var v runtimeClaimVector
	readJobsVector(t, "claim-runtime-repo.json", &v)
	var body atomic.Value
	var resp atomic.Value
	resp.Store([]byte(v.Response))
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body.Store(string(b))
		if strings.HasSuffix(r.URL.Path, "/finish") {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		_, _ = w.Write(resp.Load().([]byte))
	}))
	defer srv.Close()
	var parsed struct {
		Deadline string `json:"deadline"`
	}
	_ = json.Unmarshal(v.Response, &parsed)
	dl, _ := time.Parse(time.RFC3339Nano, parsed.Deadline)
	before := dl.Add(-time.Minute)

	c := clientFor(t, srv, "https://portal.kete.example")
	rc, err := c.ClaimRuntime(context.Background(), v.Request.ClaimToken, v.KubeVM.LocalRepositoryName, before)
	if err != nil || rc.Repository.Name != v.KubeVM.LocalRepositoryName {
		t.Fatalf("claim: %+v %v", rc, err)
	}
	ours, _ := json.Marshal(v.Request)
	if body.Load().(string) != string(ours) {
		t.Errorf("request %s, vector %s", body.Load(), ours)
	}
	// Another local name, a past deadline, or another machine's platform: refused.
	if _, err := c.ClaimRuntime(context.Background(), "t", "gitlab:other/repo", before); !errors.Is(err, ErrRuntimeRefused) {
		t.Errorf("another name: %v", err)
	}
	if _, err := c.ClaimRuntime(context.Background(), "t", v.KubeVM.LocalRepositoryName, dl.Add(time.Minute)); !errors.Is(err, ErrRuntimeRefused) {
		t.Errorf("past deadline: %v", err)
	}
	other := clientFor(t, srv, "https://other.kete.example")
	if _, err := other.ClaimRuntime(context.Background(), "t", v.KubeVM.LocalRepositoryName, before); !errors.Is(err, ErrRuntimeRefused) {
		t.Errorf("another platform: %v", err)
	}
	for _, r := range v.KubeVM.Refusals {
		resp.Store([]byte(r.Response))
		if _, err := c.ClaimRuntime(context.Background(), "t", v.KubeVM.LocalRepositoryName, before); !errors.Is(err, ErrRuntimeRefused) {
			t.Errorf("%s: %v", r.Name, err)
		}
	}
	c.SetCallbackToken("cb")
	if err := c.FinishOutbox(context.Background()); err != nil || body.Load().(string) != `{"outbox":true}` {
		t.Errorf("finish: %v %v", err, body.Load())
	}
}
