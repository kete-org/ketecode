// Package phase filters and buffers phase lines (ADR 0023 rule 19): the agent forwards only lines
// that parse as the entrypoint's or kete-job-init's phase-line JSON (contract JobHostPhaseLine),
// never anything else from the guest. A raw line over 512 bytes is dropped unparsed; at most 200
// lines per machine wait for the next report; everything else is dropped and counted. Lines sent
// in a report are removed only when that report's response is accepted (Ack); after a lost
// response they are sent again (Nack).
package phase

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// Parse decodes one raw line strictly as a phase line.
func Parse(raw []byte) (contract.PhaseLine, bool) {
	if len(raw) > contract.PhaseLineMaxBytes {
		return contract.PhaseLine{}, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var l contract.PhaseLine
	if err := dec.Decode(&l); err != nil {
		return contract.PhaseLine{}, false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return contract.PhaseLine{}, false
	}
	if l.Validate() != nil {
		return contract.PhaseLine{}, false
	}
	return l, true
}

// Buffer is one machine's pending phase lines. Not safe for concurrent use (the agent holds its
// lock around it).
type Buffer struct {
	pending         []contract.PhaseLine
	dropped         int64
	inflightLines   int
	inflightDropped int64
}

// Add filters one raw line into the buffer.
func (b *Buffer) Add(raw []byte) {
	l, ok := Parse(raw)
	if !ok || len(b.pending) >= contract.PhaseLinesMax {
		b.dropped++
		return
	}
	b.pending = append(b.pending, l)
}

// Take returns the lines and drop count for a report and marks them in flight.
func (b *Buffer) Take() ([]contract.PhaseLine, int64) {
	b.inflightLines = len(b.pending)
	b.inflightDropped = b.dropped
	out := make([]contract.PhaseLine, len(b.pending))
	copy(out, b.pending)
	return out, b.dropped
}

// Ack forgets what the last Take returned (its report was answered and accepted).
func (b *Buffer) Ack() {
	b.pending = append([]contract.PhaseLine(nil), b.pending[b.inflightLines:]...)
	b.dropped -= b.inflightDropped
	b.inflightLines, b.inflightDropped = 0, 0
}

// Nack keeps everything for the next report (the response was lost or refused).
func (b *Buffer) Nack() { b.inflightLines, b.inflightDropped = 0, 0 }
