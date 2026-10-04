package ca

import (
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
	"time"
)

func pool(t *testing.T, c *CA) *x509.CertPool {
	t.Helper()
	block, _ := pem.Decode(c.CertPEM())
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatal("CertPEM is not a PEM certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	p := x509.NewCertPool()
	p.AddCert(cert)
	return p
}

func TestLeafVerifiesForItsHostOnly(t *testing.T) {
	c, err := New([]string{"github.com", "registry.npmjs.org"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	roots := pool(t, c)
	leaf, err := c.Leaf("github.com")
	if err != nil {
		t.Fatal(err)
	}
	opts := x509.VerifyOptions{Roots: roots, DNSName: "github.com", KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if _, err := leaf.Leaf.Verify(opts); err != nil {
		t.Fatalf("leaf doesn't verify: %v", err)
	}
	opts.DNSName = "registry.npmjs.org"
	if _, err := leaf.Leaf.Verify(opts); err == nil {
		t.Error("github.com leaf verified for another host")
	}
	again, _ := c.Leaf("github.com")
	if again != leaf {
		t.Error("leaf not cached")
	}
	if _, err := c.Leaf("evil.example"); err == nil {
		t.Error("issued a leaf for an unlisted host")
	}
}

func TestNameConstraintsRefuseUnlistedHost(t *testing.T) {
	c, err := New([]string{"github.com"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	rogue, err := c.signUnchecked("evil.example")
	if err != nil {
		t.Fatal(err)
	}
	_, err = rogue.Verify(x509.VerifyOptions{Roots: pool(t, c), DNSName: "evil.example", KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	if err == nil {
		t.Fatal("a leaf for an unlisted host verified: the name constraints aren't enforced")
	}
	if _, ok := err.(x509.CertificateInvalidError); !ok {
		t.Errorf("unexpected error type %T: %v", err, err)
	}
}

func TestSubdomainsExcluded(t *testing.T) {
	c, err := New([]string{"github.com", "api.github.com", "registry.npmjs.org"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	roots := pool(t, c)
	verify := func(name string) error {
		leaf, err := c.signUnchecked(name)
		if err != nil {
			t.Fatal(err)
		}
		_, err = leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: name, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
		return err
	}
	for _, ok := range []string{"github.com", "api.github.com", "registry.npmjs.org"} {
		if err := verify(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"evil.registry.npmjs.org", "x.api.github.com", "npmjs.org", "evil.example"} {
		if err := verify(bad); err == nil {
			t.Errorf("%s verified", bad)
		}
	}
	// github.com has an allowlisted descendant, so its other subdomains stay permitted
	// (documented limitation).
	if err := verify("gist.github.com"); err != nil {
		t.Errorf("gist.github.com: %v (expected permitted: github.com has a descendant)", err)
	}
	got := strings.Join(c.Cert().ExcludedDNSDomains, ",")
	if got != ".api.github.com,.registry.npmjs.org" {
		t.Errorf("excluded = %s", got)
	}
}

func TestCAProperties(t *testing.T) {
	now := time.Now()
	c, err := New([]string{"b.example", "a.example"}, now)
	if err != nil {
		t.Fatal(err)
	}
	ca := c.Cert()
	if !ca.IsCA || !ca.BasicConstraintsValid || ca.MaxPathLen != 0 || !ca.MaxPathLenZero {
		t.Errorf("basic constraints: IsCA=%v MaxPathLen=%d zero=%v", ca.IsCA, ca.MaxPathLen, ca.MaxPathLenZero)
	}
	if ca.KeyUsage != x509.KeyUsageCertSign {
		t.Errorf("key usage = %v", ca.KeyUsage)
	}
	if !ca.PermittedDNSDomainsCritical || len(ca.PermittedDNSDomains) != 2 {
		t.Errorf("name constraints: critical=%v %v", ca.PermittedDNSDomainsCritical, ca.PermittedDNSDomains)
	}
	if len(ca.ExcludedIPRanges) != 2 {
		t.Errorf("excluded IP ranges = %v", ca.ExcludedIPRanges)
	}
	if ca.NotAfter.Sub(now) > Validity+time.Second || now.Sub(ca.NotBefore) < 59*time.Minute {
		t.Errorf("validity %v - %v", ca.NotBefore, ca.NotAfter)
	}
	if ca.Subject.CommonName != "Kete job egress CA" {
		t.Errorf("CN = %q", ca.Subject.CommonName)
	}
	leaf, err := c.Leaf("a.example")
	if err != nil {
		t.Fatal(err)
	}
	l := leaf.Leaf
	if l.IsCA || len(l.DNSNames) != 1 || l.DNSNames[0] != "a.example" || len(l.IPAddresses) != 0 {
		t.Errorf("leaf: IsCA=%v DNS=%v IP=%v", l.IsCA, l.DNSNames, l.IPAddresses)
	}
	if len(l.ExtKeyUsage) != 1 || l.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Errorf("leaf EKU = %v", l.ExtKeyUsage)
	}
	if !l.NotAfter.Equal(ca.NotAfter) {
		t.Error("leaf outlives or undercuts the CA")
	}
	if l.SerialNumber.Cmp(ca.SerialNumber) == 0 || l.SerialNumber.Sign() <= 0 {
		t.Error("serials")
	}
	if _, err := New(nil, now); err == nil {
		t.Error("CA with no hosts created")
	}
}
