//go:build kete_testdriver

package runner_test

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// newConnectProxy is an HTTP CONNECT proxy that reports each requested host and tunnels to
// target (the fake platform's listener) whatever was asked.
func newConnectProxy(t *testing.T, target string, seen func(string)) *url.URL {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT only", 405)
			return
		}
		seen(r.Host)
		up, err := net.Dial("tcp", target)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		w.WriteHeader(200)
		down, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			up.Close()
			return
		}
		go func() { _, _ = io.Copy(up, down); up.Close() }()
		go func() { _, _ = io.Copy(down, up); down.Close() }()
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	return u
}
