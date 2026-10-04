package guestinit

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func cloudJSON(provider string) string {
	return strings.Replace(microvmJSON, `"microvm"`, `"cloudvm","host_provider":"`+provider+`"`, 1)
}

// fakeMetadata serves each provider's user-data endpoint the way the provider does, checking the
// request headers the provider requires.
func fakeMetadata(t *testing.T, status int, body func(provider string) string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var provider string
		switch r.URL.Path {
		case "/computeMetadata/v1/instance/attributes/user-data":
			if r.Header.Get("Metadata-Flavor") != "Google" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.Header().Set("Metadata-Flavor", "Google")
			provider = "gcp"
		case "/metadata/v1/user-data":
			provider = "digitalocean"
		case "/hetzner/v1/userdata":
			provider = "hetzner"
		case "/opc/v2/instance/metadata/user_data":
			if r.Header.Get("Authorization") != "Bearer Oracle" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			provider = "oci"
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(status)
		b := body(provider)
		if provider == "oci" && status == http.StatusOK {
			b = base64.StdEncoding.EncodeToString([]byte(b))
		}
		_, _ = w.Write([]byte(b))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func client(base string) UserDataClient {
	return UserDataClient{Base: base, Timeout: 2 * time.Second, Attempts: 3, Backoff: 10 * time.Millisecond}
}

// TestUserDataReaders: each provider's reader against a fake metadata server, then the
// cloudvm validation of what it read.
func TestUserDataReaders(t *testing.T) {
	srv, _ := fakeMetadata(t, http.StatusOK, cloudJSON)
	for provider := range UserDataRequests {
		raw, err := client(srv.URL).Fetch(context.Background(), provider)
		if err != nil {
			t.Errorf("%s: %v", provider, err)
			continue
		}
		cfg, err := ParseUserData(raw, provider)
		if err != nil || cfg.HostProvider != provider || cfg.ClaimToken != token {
			t.Errorf("%s: %+v %v", provider, cfg, err)
		}
	}
	if _, err := client(srv.URL).Fetch(context.Background(), "aws"); err == nil {
		t.Error("unknown provider fetched")
	}
}

func TestParseUserDataRefusals(t *testing.T) {
	for name, c := range map[string]struct{ raw, provider string }{
		"other provider": {cloudJSON("gcp"), "hetzner"},
		"microvm":        {microvmJSON, "gcp"},
		"not json":       {"#cloud-config\nruncmd: []", "gcp"},
		"empty":          {"", "gcp"},
	} {
		if _, err := ParseUserData([]byte(c.raw), c.provider); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestUserDataFailures(t *testing.T) {
	// A 404 is permanent: one request, no retry.
	srv, hits := fakeMetadata(t, http.StatusNotFound, cloudJSON)
	if _, err := client(srv.URL).Fetch(context.Background(), "hetzner"); err == nil || hits.Load() != 1 {
		t.Errorf("404: %v after %d requests", err, hits.Load())
	}
	// A 5xx is retried up to Attempts.
	srv, hits = fakeMetadata(t, http.StatusServiceUnavailable, cloudJSON)
	if _, err := client(srv.URL).Fetch(context.Background(), "digitalocean"); err == nil || hits.Load() != 3 {
		t.Errorf("503: %v after %d requests", err, hits.Load())
	}
	// Oversize bodies are refused.
	srv, _ = fakeMetadata(t, http.StatusOK, func(string) string { return strings.Repeat("a", 5000) })
	for _, p := range []string{"hetzner", "oci"} {
		if _, err := client(srv.URL).Fetch(context.Background(), p); err == nil {
			t.Errorf("%s oversize accepted", p)
		}
	}
	// GCP's response must carry its flavor header (a non-metadata server answering is refused).
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(cloudJSON("gcp"))) }))
	defer plain.Close()
	if _, err := client(plain.URL).Fetch(context.Background(), "gcp"); err == nil {
		t.Error("gcp without the flavor response header accepted")
	}
	// Redirects are never followed.
	redir := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://example.invalid/", http.StatusFound)
	}))
	defer redir.Close()
	if _, err := client(redir.URL).Fetch(context.Background(), "digitalocean"); err == nil {
		t.Error("redirect followed or accepted")
	}
	// OCI's body must be base64.
	notB64 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("{not base64}")) }))
	defer notB64.Close()
	if _, err := client(notB64.URL).Fetch(context.Background(), "oci"); err == nil {
		t.Error("oci without base64 accepted")
	}
	// Cancellation stops the retries.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client(srv.URL).Fetch(ctx, "hetzner"); err == nil {
		t.Error("cancelled fetch succeeded")
	}
}
