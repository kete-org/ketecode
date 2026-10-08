package fakeplatform

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
)

// StartTLS serves p over real TLS with a fresh CA whose leaf names p.Authority, and returns the
// client options that trust that CA and dial the server for any address (so the agent's client
// verifies the certificate exactly as in production, against a test root).
func StartTLS(p *Platform) (*httptest.Server, client.Options, error) {
	return StartTLSHandler(p, p.Authority)
}

// NewCert returns a fresh test CA and a leaf certificate for authority signed by it, valid for
// validity from an hour ago.
func NewCert(authority string, validity time.Duration) (tls.Certificate, *x509.Certificate, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	now := time.Now()
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "kete-job-host test CA"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(validity),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	ca, _ := x509.ParseCertificate(caDER)
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: authority}, DNSNames: []string{authority},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(validity),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	return tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}, ca, nil
}

// StartTLSHandler is StartTLS for any handler (client error-path tests).
func StartTLSHandler(h http.Handler, authority string) (*httptest.Server, client.Options, error) {
	cert, ca, err := NewCert(authority, 24*time.Hour)
	if err != nil {
		return nil, client.Options{}, err
	}
	srv := httptest.NewUnstartedServer(h)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	srv.StartTLS()
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	addr := srv.Listener.Addr().String()
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	return srv, client.Options{RootCAs: pool, DialContext: dial}, nil
}
