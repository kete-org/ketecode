package proxy

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"errors"
	"fmt"
	"io"
	"os"
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

// Limits of the configuration v2 upstream files.
const (
	maxCABundle  = 256 << 10
	maxProxyAuth = 1024
)

// AddCABundle returns pool plus the PEM certificates of path (configuration v2
// upstream.ca_bundle_file): extra roots for upstream TLS only, never the job's clients' trust. The
// file must hold at least one certificate, and none may be named like the job CA (CheckRoots).
func AddCABundle(pool *x509.CertPool, path string) (*x509.CertPool, error) {
	b, err := readSmall(path, maxCABundle)
	if err != nil {
		return nil, fmt.Errorf("ca_bundle_file: %w", err)
	}
	extra := x509.NewCertPool()
	if !extra.AppendCertsFromPEM(b) {
		return nil, errors.New("ca_bundle_file holds no PEM certificate")
	}
	if err := CheckRoots(extra); err != nil {
		return nil, fmt.Errorf("ca_bundle_file: %w", err)
	}
	out := pool.Clone()
	out.AppendCertsFromPEM(b)
	return out, nil
}

// ReadProxyAuth reads configuration v2 upstream.proxy_auth_file: one `username:password` line
// (printable ASCII, a non-empty username without ':'). The value is never logged or echoed in an
// error.
func ReadProxyAuth(path string) (string, error) {
	b, err := readSmall(path, maxProxyAuth)
	if err != nil {
		return "", fmt.Errorf("proxy_auth_file: %w", err)
	}
	v := strings.TrimRight(string(b), "\r\n")
	i := strings.IndexByte(v, ':')
	if i < 1 {
		return "", errors.New("proxy_auth_file must hold username:password")
	}
	for j := 0; j < len(v); j++ {
		if v[j] < 0x20 || v[j] > 0x7e {
			return "", errors.New("proxy_auth_file must be printable ASCII on one line")
		}
	}
	return v, nil
}

func readSmall(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("larger than %d bytes", max)
	}
	return b, nil
}
