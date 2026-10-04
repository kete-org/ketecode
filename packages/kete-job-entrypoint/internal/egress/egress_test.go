package egress

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"
)

func base() Base {
	return Base{ProxyUID: 997, KeteUID: 996, ToolUID: 995, PortKete: 81, PortTool: 82, PortRoot: 83, Resolvers: []string{"198.51.100.53:53"}}
}

func TestBuildConfig(t *testing.T) {
	b, err := BuildConfig(base(), Instance{
		Clone: Hosts{Root: []string{"platform.kete.test", "github.com", "api.github.com", "platform.kete.test"}},
		Agent: Hosts{Kete: []string{"gateway.kete.test", "platform.kete.test"}, Tool: []string{"registry.npmjs.org"}, Root: []string{"platform.kete.test"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	phases := m["phases"].(map[string]any)
	clone := phases["clone"].(map[string]any)["root"].([]any)
	if len(clone) != 3 {
		t.Errorf("clone.root not deduped: %v", clone)
	}
	if _, ok := phases["report"]; ok {
		t.Errorf("empty report phase rendered: %v", phases)
	}
	if m["version"].(float64) != 1 || m["ports"].(map[string]any)["root"].(float64) != 83 {
		t.Errorf("config = %s", b)
	}
	if _, err := BuildConfig(base(), Instance{}); err == nil {
		t.Error("empty instance accepted")
	}
	if _, err := BuildConfig(base(), Instance{Clone: Hosts{Root: []string{"10.0.0.1"}}}); err == nil {
		t.Error("IP host accepted")
	}
	if _, err := BuildConfig(base(), Instance{Clone: Hosts{Root: []string{"Platform.Test"}}}); err == nil {
		t.Error("uppercase host accepted")
	}
}

func TestParseResolvConf(t *testing.T) {
	got, err := ParseResolvConf(strings.NewReader("# x\nnameserver 198.51.100.53\nnameserver fdaa::3\nsearch x\nnameserver 198.51.100.53\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "198.51.100.53:53" || got[1] != "[fdaa::3]:53" {
		t.Errorf("resolvers = %v", got)
	}
	for _, bad := range []string{"nameserver 127.0.0.11\n", "nameserver ::1\n", "", "nameserver x\n", "nameserver 0.0.0.0\n"} {
		if _, err := ParseResolvConf(strings.NewReader(bad)); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func testCAPEM(t *testing.T) string {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Kete job egress CA"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// fakeProxy answers control protocol v1 on the other end of a pipe.
func fakeProxy(t *testing.T, conn net.Conn, ready string, replies map[string]string) {
	t.Helper()
	go func() {
		_, _ = io.WriteString(conn, ready+"\n")
		buf := make([]byte, 4096)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			for _, line := range bytes.Split(bytes.TrimSpace(buf[:n]), []byte("\n")) {
				var m map[string]string
				_ = json.Unmarshal(line, &m)
				key := m["type"]
				if m["phase"] != "" {
					key += ":" + m["phase"]
				}
				_, _ = io.WriteString(conn, replies[key]+"\n")
			}
		}
	}()
}

func TestControl(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	ready, _ := json.Marshal(map[string]any{"type": "ready", "version": 1, "ca_cert_pem": testCAPEM(t)})
	fakeProxy(t, b, string(ready), map[string]string{
		"phase:clone":  `{"type":"phase_ok","phase":"clone","closed_connections":0}`,
		"phase:closed": `{"type":"error","reason":"backward"}`,
		"stats":        `{"type":"stats","requests":3,"refused":1,"registry_requests":0,"log_bytes":100,"log_full":false,"job_log_full":false}`,
	})
	c := NewControl(a)
	ca, err := c.ReadReady()
	if err != nil || !strings.Contains(string(ca), "BEGIN CERTIFICATE") {
		t.Fatalf("ready: %v", err)
	}
	if err := c.Phase("clone"); err != nil {
		t.Fatalf("phase: %v", err)
	}
	if err := c.Phase("closed"); err == nil {
		t.Error("an error reply was accepted as phase_ok")
	}
	s, err := c.Stats()
	if err != nil || s.Requests != 3 || s.LogBytes != 100 {
		t.Fatalf("stats = %+v, %v", s, err)
	}
}

func TestControlRefusesBadReady(t *testing.T) {
	for _, ready := range []string{
		`{"type":"phase_ok"}`,
		`{"type":"ready","version":2,"ca_cert_pem":""}`,
		`{"type":"ready","version":1,"ca_cert_pem":"not pem"}`,
		`not json`,
	} {
		a, b := net.Pipe()
		go func() { _, _ = io.WriteString(b, ready+"\n") }()
		if _, err := NewControl(a).ReadReady(); err == nil {
			t.Errorf("%s accepted", ready)
		}
		a.Close()
		b.Close()
	}
}
