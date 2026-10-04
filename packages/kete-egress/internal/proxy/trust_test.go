package proxy

import (
	"crypto/x509"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/ca"
)

func TestCheckTrustEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	ok := []map[string]string{
		{},
		{"SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt"},
		{"SSL_CERT_DIR": "/etc/ssl/certs:/usr/local/share/certs"},
		{"SSL_CERT_FILE": "/run/kete-egress-other/ca.pem"},
	}
	for _, m := range ok {
		if err := CheckTrustEnv(env(m)); err != nil {
			t.Errorf("%v refused: %v", m, err)
		}
	}
	bad := []map[string]string{
		{"SSL_CERT_FILE": "/run/kete-egress/ca.pem"},
		{"SSL_CERT_FILE": "/run/kete-egress"},
		{"SSL_CERT_FILE": "/run/./kete-egress/../kete-egress/ca.pem"},
		{"SSL_CERT_DIR": "/etc/ssl/certs:/run/kete-egress"},
		{"SSL_CERT_DIR": "/run/kete-egress/"},
	}
	for _, m := range bad {
		if err := CheckTrustEnv(env(m)); err == nil {
			t.Errorf("%v accepted", m)
		}
	}
}

func TestCheckRoots(t *testing.T) {
	job, err := ca.New([]string{"a.example"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	other, err := ca.NewNamed("Test upstream CA", []string{"a.example"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	clean := x509.NewCertPool()
	clean.AddCert(other.Cert())
	if err := CheckRoots(clean); err != nil {
		t.Errorf("clean pool refused: %v", err)
	}
	tainted := x509.NewCertPool()
	tainted.AddCert(other.Cert())
	tainted.AddCert(job.Cert())
	if err := CheckRoots(tainted); err == nil {
		t.Error("a pool with a job CA accepted")
	}
	sys, err := x509.SystemCertPool()
	if err != nil {
		t.Fatal(err)
	}
	if err := CheckRoots(sys); err != nil {
		t.Errorf("this machine's system roots refused: %v", err)
	}
}
