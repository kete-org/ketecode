package proxy

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/ca"
)

// JobCADir is where the entrypoint writes the job CA for clients (module README "Clients").
const JobCADir = "/run/kete-egress"

// CheckTrustEnv refuses an upstream trust configuration that could pick up the job CA:
// SSL_CERT_FILE, or any SSL_CERT_DIR entry, naming anything under JobCADir.
func CheckTrustEnv(getenv func(string) string) error {
	check := func(name, path string) error {
		if path == "" {
			return nil
		}
		clean := filepath.Clean(path)
		if clean == JobCADir || strings.HasPrefix(clean, JobCADir+"/") {
			return fmt.Errorf("%s=%q points at the job CA's directory; upstream trust must be the system roots only", name, path)
		}
		return nil
	}
	if err := check("SSL_CERT_FILE", getenv("SSL_CERT_FILE")); err != nil {
		return err
	}
	for _, dir := range filepath.SplitList(getenv("SSL_CERT_DIR")) {
		if err := check("SSL_CERT_DIR", dir); err != nil {
			return err
		}
	}
	return nil
}

// CheckRoots refuses a root pool containing a certificate whose subject common name is the job
// CA's.
func CheckRoots(pool *x509.CertPool) error {
	// Subjects is deprecated only for the platform verifiers of macOS and Windows; on Linux
	// SystemCertPool returns an ordinary pool and Subjects lists every root.
	for _, raw := range pool.Subjects() {
		var rdn pkix.RDNSequence
		if _, err := asn1.Unmarshal(raw, &rdn); err != nil {
			return fmt.Errorf("system roots: unparsable subject: %w", err)
		}
		var name pkix.Name
		name.FillFromRDNSequence(&rdn)
		if name.CommonName == ca.JobCAName {
			return fmt.Errorf("the system roots contain a certificate named %q: a job CA must never be an upstream root", ca.JobCAName)
		}
	}
	return nil
}
