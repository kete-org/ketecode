package control

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestReadCommands(t *testing.T) {
	r := NewReader(strings.NewReader("{\"type\":\"phase\",\"phase\":\"clone\"}\n{\"type\":\"stats\"}\n"))
	c, err := r.Read()
	if err != nil || c.Type != "phase" || c.Phase != "clone" {
		t.Fatalf("got %+v, %v", c, err)
	}
	c, err = r.Read()
	if err != nil || c.Type != "stats" {
		t.Fatalf("got %+v, %v", c, err)
	}
	if _, err := r.Read(); !errors.Is(err, io.EOF) {
		t.Fatalf("clean EOF: %v", err)
	}
}

func TestMalformed(t *testing.T) {
	bad := []string{
		"not json\n",
		"{}\n",
		"{\"type\":\"reboot\"}\n",
		"{\"type\":\"phase\"}\n",
		"{\"type\":\"phase\",\"phase\":\"agent\",\"force\":true}\n",
		"{\"type\":\"stats\",\"reset\":true}\n",
		"{\"type\":\"stats\"} {\"type\":\"stats\"}\n",
		"{\"type\":\"phase\",\"phase\":1}\n",
		"{\"type\":\"stats\"}", // no newline, then EOF
		"{\"type\":\"phase\",\"phase\":\"" + strings.Repeat("a", MaxLine) + "\"}\n",
	}
	for _, in := range bad {
		_, err := NewReader(strings.NewReader(in)).Read()
		if !errors.Is(err, ErrMalformed) {
			t.Errorf("%.60q: err = %v, want ErrMalformed", in, err)
		}
	}
}

func TestWriters(t *testing.T) {
	var b bytes.Buffer
	_ = WriteReady(&b, []byte("-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n"))
	_ = WritePhaseOK(&b, "agent", 3)
	_ = WriteError(&b, "phase \"clone\" can't follow \"agent\"")
	_ = WriteStats(&b, Stats{Requests: 5, Refused: 2, RegistryRequests: 1, LogBytes: 900, LogFull: true, JobLogFull: true})
	lines := strings.Split(strings.TrimSuffix(b.String(), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("%d lines: %q", len(lines), b.String())
	}
	want := []map[string]any{
		{"type": "ready", "version": 1.0, "ca_cert_pem": "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n"},
		{"type": "phase_ok", "phase": "agent", "closed_connections": 3.0},
		{"type": "error", "reason": "phase \"clone\" can't follow \"agent\""},
		{"type": "stats", "requests": 5.0, "refused": 2.0, "registry_requests": 1.0, "log_bytes": 900.0, "log_full": true, "job_log_full": true},
	}
	for i, ln := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(ln), &m); err != nil {
			t.Fatal(err)
		}
		if len(m) != len(want[i]) {
			t.Errorf("line %d has fields %v", i, m)
		}
		for k, v := range want[i] {
			if m[k] != v {
				t.Errorf("line %d %s = %v, want %v", i, k, m[k], v)
			}
		}
	}
}
