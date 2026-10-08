package proxy

import (
	"crypto/x509"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/ca"
)

func TestAddCABundle(t *testing.T) {
	dir := t.TempDir()
	corp, err := ca.NewNamed("Corp Root", []string{"corp.example"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	good := filepath.Join(dir, "corp.pem")
	if err := os.WriteFile(good, corp.CertPEM(), 0o600); err != nil {
		t.Fatal(err)
	}
	pool, err := AddCABundle(x509.NewCertPool(), good)
	if err != nil || len(pool.Subjects()) != 1 { //nolint:staticcheck // Linux pools list subjects
		t.Fatalf("pool %v err %v", pool, err)
	}
	job, err := ca.New([]string{"x.example"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(dir, "job.pem")
	_ = os.WriteFile(bad, job.CertPEM(), 0o600)
	if _, err := AddCABundle(x509.NewCertPool(), bad); err == nil {
		t.Error("a bundle holding a job CA was accepted")
	}
	empty := filepath.Join(dir, "empty.pem")
	_ = os.WriteFile(empty, []byte("not pem"), 0o600)
	if _, err := AddCABundle(x509.NewCertPool(), empty); err == nil {
		t.Error("a bundle without a certificate was accepted")
	}
}

func TestReadProxyAuth(t *testing.T) {
	dir := t.TempDir()
	for content, ok := range map[string]bool{
		"svc:pw\n": true, "svc:p:w": true, ":pw": false, "nocolon": false, "svc:p\nw": false, "": false,
	} {
		p := filepath.Join(dir, "auth")
		_ = os.WriteFile(p, []byte(content), 0o600)
		v, err := ReadProxyAuth(p)
		if (err == nil) != ok {
			t.Errorf("%q: err %v", content, err)
		}
		if err != nil && content != "" && len(content) > 3 && contains(err.Error(), content) {
			t.Errorf("the error echoes the file: %v", err)
		}
		_ = v
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
