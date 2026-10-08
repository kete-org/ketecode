package fakeplatform

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// CA is the fake's own test CA (never the job CA's name), with leaf certificates for *.kete.test.
type CA struct {
	cert  *x509.Certificate
	key   *ecdsa.PrivateKey
	mu    sync.Mutex
	cache map[string]*tls.Certificate
}

// NewCA creates a CA.
func NewCA(cn string) (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &CA{cert: cert, key: key, cache: map[string]*tls.Certificate{}}, nil
}

// CertPEM is the CA certificate.
func (c *CA) CertPEM() []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.cert.Raw})
}

// Leaf returns a certificate for name (only *.kete.test).
func (c *CA) Leaf(name string) (*tls.Certificate, error) {
	if !strings.HasSuffix(name, ".kete.test") {
		return nil, errors.New("fake CA: unknown name")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if l, ok := c.cache[name]; ok {
		return l, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, &key.PublicKey, c.key)
	if err != nil {
		return nil, err
	}
	l := &tls.Certificate{Certificate: [][]byte{der, c.cert.Raw}, PrivateKey: key}
	c.cache[name] = l
	return l, nil
}

func basic(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}

// LoadOrCreateCA reuses the CA saved in dir (ca.crt, ca.key) or creates one and saves it there, so
// a fake restarted for the next job keeps the trust its clients were given (the Kubernetes
// runner's kind e2e serves one job per fake process). Test credentials only.
func LoadOrCreateCA(dir, cn string) (*CA, error) {
	certPEM, err1 := os.ReadFile(filepath.Join(dir, "ca.crt"))
	keyPEM, err2 := os.ReadFile(filepath.Join(dir, "ca.key"))
	if err1 == nil && err2 == nil {
		cb, _ := pem.Decode(certPEM)
		kb, _ := pem.Decode(keyPEM)
		if cb == nil || kb == nil {
			return nil, errors.New("fake CA: bad PEM in " + dir)
		}
		cert, err := x509.ParseCertificate(cb.Bytes)
		if err != nil {
			return nil, err
		}
		key, err := x509.ParseECPrivateKey(kb.Bytes)
		if err != nil {
			return nil, err
		}
		return &CA{cert: cert, key: key, cache: map[string]*tls.Certificate{}}, nil
	}
	c, err := NewCA(cn)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(c.key)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, "ca.key"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return c, os.WriteFile(filepath.Join(dir, "ca.crt"), c.CertPEM(), 0o644)
}
