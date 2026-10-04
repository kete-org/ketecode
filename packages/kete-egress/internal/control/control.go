// Package control is control protocol v1 (module README "Control protocol v1"): newline-delimited
// JSON over fd 7, one end of a socketpair only root holds the other end of. Lines are at most 4 KiB
// and unknown fields are refused. Root sends "phase" and "stats"; the proxy sends "ready" once,
// then one reply per command.
package control

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Version is the protocol version announced in "ready".
const Version = 1

// MaxLine bounds one line, newline included.
const MaxLine = 4096

// ErrMalformed wraps every refusal of an incoming line; the proxy exits 2 on it.
var ErrMalformed = errors.New("malformed control line")

// Command is one instruction from root.
type Command struct {
	Type  string // "phase" or "stats"
	Phase string // for "phase"
}

// Stats is the reply to a "stats" command.
type Stats struct {
	Requests         int64 `json:"requests"`
	Refused          int64 `json:"refused"`
	RegistryRequests int64 `json:"registry_requests"`
	LogBytes         int64 `json:"log_bytes"`
	LogFull          bool  `json:"log_full"`
	JobLogFull       bool  `json:"job_log_full"`
}

// Reader reads commands.
type Reader struct {
	br *bufio.Reader
}

// NewReader wraps r.
func NewReader(r io.Reader) *Reader {
	return &Reader{br: bufio.NewReaderSize(r, MaxLine)}
}

// Read returns the next command, io.EOF when the peer closed cleanly between lines, or an error
// wrapping ErrMalformed.
func (r *Reader) Read() (Command, error) {
	line, err := r.br.ReadSlice('\n')
	if err != nil {
		if errors.Is(err, io.EOF) && len(line) == 0 {
			return Command{}, io.EOF
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			return Command{}, fmt.Errorf("%w: longer than %d bytes", ErrMalformed, MaxLine)
		}
		if errors.Is(err, io.EOF) {
			return Command{}, fmt.Errorf("%w: truncated line", ErrMalformed)
		}
		return Command{}, err
	}
	return parse(line)
}

func strict(line []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data")
	}
	return nil
}

func parse(line []byte) (Command, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		return Command{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	switch head.Type {
	case "phase":
		var m struct {
			Type  string  `json:"type"`
			Phase *string `json:"phase"`
		}
		if err := strict(line, &m); err != nil {
			return Command{}, fmt.Errorf("%w: %v", ErrMalformed, err)
		}
		if m.Phase == nil {
			return Command{}, fmt.Errorf("%w: phase is required", ErrMalformed)
		}
		return Command{Type: "phase", Phase: *m.Phase}, nil
	case "stats":
		var m struct {
			Type string `json:"type"`
		}
		if err := strict(line, &m); err != nil {
			return Command{}, fmt.Errorf("%w: %v", ErrMalformed, err)
		}
		return Command{Type: "stats"}, nil
	}
	return Command{}, fmt.Errorf("%w: unknown type %q", ErrMalformed, head.Type)
}

func write(w io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}

// WriteReady announces the proxy is ready and hands root the CA certificate.
func WriteReady(w io.Writer, caPEM []byte) error {
	return write(w, struct {
		Type    string `json:"type"`
		Version int    `json:"version"`
		CACert  string `json:"ca_cert_pem"`
	}{"ready", Version, string(caPEM)})
}

// WritePhaseOK confirms a phase change.
func WritePhaseOK(w io.Writer, phase string, closed int) error {
	return write(w, struct {
		Type   string `json:"type"`
		Phase  string `json:"phase"`
		Closed int    `json:"closed_connections"`
	}{"phase_ok", phase, closed})
}

// WriteError refuses a command (the proxy keeps running).
func WriteError(w io.Writer, reason string) error {
	return write(w, struct {
		Type   string `json:"type"`
		Reason string `json:"reason"`
	}{"error", reason})
}

// WriteStats answers "stats".
func WriteStats(w io.Writer, s Stats) error {
	return write(w, struct {
		Type string `json:"type"`
		Stats
	}{"stats", s})
}
