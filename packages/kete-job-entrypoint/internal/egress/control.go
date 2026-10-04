package egress

import (
	"bufio"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
)

// maxLine bounds one control line from the proxy ("ready" carries the CA PEM).
const maxLine = 64 << 10

// Stats is the proxy's "stats" reply.
type Stats struct {
	Requests         int64 `json:"requests"`
	Refused          int64 `json:"refused"`
	RegistryRequests int64 `json:"registry_requests"`
	LogBytes         int64 `json:"log_bytes"`
	LogFull          bool  `json:"log_full"`
	JobLogFull       bool  `json:"job_log_full"`
}

// Control speaks control protocol v1 (root's side).
type Control struct {
	r *bufio.Reader
	w io.Writer
}

// NewControl wraps the root end of the socketpair.
func NewControl(rw io.ReadWriter) *Control {
	return &Control{r: bufio.NewReaderSize(rw, 4096), w: rw}
}

func (c *Control) readLine() ([]byte, error) {
	var line []byte
	for {
		chunk, err := c.r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > maxLine {
			return nil, errors.New("egress control: line too long")
		}
		if err == nil {
			return line, nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

func (c *Control) send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = c.w.Write(append(b, '\n'))
	return err
}

// ReadReady reads the "ready" line and returns the CA certificate PEM (checked to parse).
func (c *Control) ReadReady() ([]byte, error) {
	line, err := c.readLine()
	if err != nil {
		return nil, err
	}
	var m struct {
		Type    string `json:"type"`
		Version int    `json:"version"`
		CA      string `json:"ca_cert_pem"`
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return nil, fmt.Errorf("egress control: %w", err)
	}
	if m.Type != "ready" || m.Version != 1 {
		return nil, fmt.Errorf("egress control: expected ready v1, got %q v%d", m.Type, m.Version)
	}
	block, rest := pem.Decode([]byte(m.CA))
	if block == nil || block.Type != "CERTIFICATE" || len(rest) > 1 {
		return nil, errors.New("egress control: ready carries no single CA certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !cert.IsCA {
		return nil, errors.New("egress control: ready carries an invalid CA certificate")
	}
	return []byte(m.CA), nil
}

// Phase moves the proxy to phase and waits for phase_ok.
func (c *Control) Phase(phase string) error {
	if err := c.send(map[string]string{"type": "phase", "phase": phase}); err != nil {
		return err
	}
	line, err := c.readLine()
	if err != nil {
		return err
	}
	var m struct {
		Type   string `json:"type"`
		Phase  string `json:"phase"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return err
	}
	if m.Type != "phase_ok" || m.Phase != phase {
		return fmt.Errorf("egress control: phase %s refused (%s)", phase, m.Type)
	}
	return nil
}

// Stats asks for the counters.
func (c *Control) Stats() (Stats, error) {
	if err := c.send(map[string]string{"type": "stats"}); err != nil {
		return Stats{}, err
	}
	line, err := c.readLine()
	if err != nil {
		return Stats{}, err
	}
	var m struct {
		Type string `json:"type"`
		Stats
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return Stats{}, err
	}
	if m.Type != "stats" {
		return Stats{}, fmt.Errorf("egress control: expected stats, got %q", m.Type)
	}
	return m.Stats, nil
}
