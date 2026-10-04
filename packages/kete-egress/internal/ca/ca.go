// Package ca is the proxy's per-VM certificate authority (module README "Security model",
// decisions D3 and D4). The CA key is generated at start-up and held in memory only — it is never
// written anywhere — and the CA carries critical DNS name constraints limited to the allowlisted
// hosts (their subdomains excluded wherever no allowlisted host lies below them; no IP addresses at
// all), so even a leaked key could only sign for names the job may reach anyway. Leaf
// certificates share one leaf key and are issued once per host, on first use, and cached; since
// only allowlisted hosts are ever issued, the cache is bounded by the configuration.
package ca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strings"
	"sync"
	"time"
)

// nameConstraints is decision D4. If a required client proves unable to use a name-constrained
// CA (piece D's image smoke test), setting this to false is the documented one-line fallback.
const nameConstraints = true

// JobCAName is the job CA's subject common name. kete-egress serve refuses to start if its
// upstream trust (the system roots) contains a certificate with this name.
const JobCAName = "Kete job egress CA"

// Validity is the lifetime of the CA and every leaf (the longest job is 130 minutes).
const Validity = 24 * time.Hour

// CA issues leaf certificates for the allowlisted hosts.
type CA struct {
	cert    *x509.Certificate
	key     *ecdsa.PrivateKey
	certPEM []byte
	leafKey *ecdsa.PrivateKey
	allowed map[string]bool
	notBef  time.Time
	notAft  time.Time

	mu     sync.Mutex
	leaves map[string]*tls.Certificate
}

// New creates the job CA, whose name constraints permit exactly hosts (normalised DNS names).
func New(hosts []string, now time.Time) (*CA, error) {
	return NewNamed(JobCAName, hosts, now)
}

// NewNamed is New with another subject common name; tests use it for the fake upstreams' CA,
// which must not look like a job CA.
func NewNamed(commonName string, hosts []string, now time.Time) (*CA, error) {
	if len(hosts) == 0 {
		return nil, errors.New("ca: no hosts to constrain to")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("ca: key: %w", err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("ca: leaf key: %w", err)
	}
	serial, err := randSerial()
	if err != nil {
		return nil, err
	}
	notBefore := now.Add(-time.Hour)
	notAfter := now.Add(Validity)
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: commonName},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	if nameConstraints {
		tmpl.PermittedDNSDomainsCritical = true
		tmpl.PermittedDNSDomains = append([]string(nil), hosts...)
		// A permitted "github.com" also permits every subdomain (RFC 5280), so exclude the
		// subdomains (".github.com": subdomains only) of each host with no allowlisted
		// descendant. A host that does have one (github.com with api.github.com) keeps its
		// subdomains permitted — excluding them would exclude the descendant too.
		tmpl.ExcludedDNSDomains = excludedSubdomains(hosts)
		// No IP SANs may be issued at all.
		tmpl.ExcludedIPRanges = []*net.IPNet{
			{IP: net.IPv4zero.To4(), Mask: net.CIDRMask(0, 32)},
			{IP: net.IPv6zero, Mask: net.CIDRMask(0, 128)},
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, fmt.Errorf("ca: create: %w", err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("ca: parse: %w", err)
	}
	allowed := make(map[string]bool, len(hosts))
	for _, h := range hosts {
		allowed[h] = true
	}
	return &CA{
		cert:    cert,
		key:     key,
		certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		leafKey: leafKey,
		allowed: allowed,
		notBef:  notBefore,
		notAft:  notAfter,
		leaves:  map[string]*tls.Certificate{},
	}, nil
}

func excludedSubdomains(hosts []string) []string {
	var out []string
	for _, h := range hosts {
		hasDescendant := false
		for _, other := range hosts {
			if other != h && strings.HasSuffix(other, "."+h) {
				hasDescendant = true
				break
			}
		}
		if !hasDescendant {
			out = append(out, "."+h)
		}
	}
	return out
}

func randSerial() (*big.Int, error) {
	s, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("ca: serial: %w", err)
	}
	return s.Add(s, big.NewInt(1)), nil
}

// CertPEM is the CA certificate, for the clients' trust stores.
func (c *CA) CertPEM() []byte { return append([]byte(nil), c.certPEM...) }

// Cert is the parsed CA certificate.
func (c *CA) Cert() *x509.Certificate { return c.cert }

// Leaf returns the (cached) certificate for host, which must be one the CA was created for.
func (c *CA) Leaf(host string) (*tls.Certificate, error) {
	if !c.allowed[host] {
		return nil, fmt.Errorf("ca: %q is not an allowlisted host", host)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if leaf, ok := c.leaves[host]; ok {
		return leaf, nil
	}
	serial, err := randSerial()
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: host},
		DNSNames:              []string{host},
		NotBefore:             c.notBef,
		NotAfter:              c.notAft,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &c.leafKey.PublicKey, c.key)
	if err != nil {
		return nil, fmt.Errorf("ca: leaf for %q: %w", host, err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	leaf := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: c.leafKey, Leaf: parsed}
	c.leaves[host] = leaf
	return leaf, nil
}

// signUnchecked issues a leaf for any name, bypassing the allowlist; tests use it to show the
// name constraints themselves refuse an unlisted host.
func (c *CA) signUnchecked(host string) (*x509.Certificate, error) {
	serial, err := randSerial()
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		DNSNames:     []string{host},
		NotBefore:    c.notBef,
		NotAfter:     c.notAft,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &c.leafKey.PublicKey, c.key)
	if err != nil {
		return nil, err
	}
	return x509.ParseCertificate(der)
}
