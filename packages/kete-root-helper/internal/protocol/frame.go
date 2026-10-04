// Package protocol implements the helper's wire protocol v1 (see the module README): a
// length-prefixed frame per message, JSON control bodies decoded strictly, and small binary
// bodies for flow control and stream framing. This package is pure — no I/O beyond the io.Reader
// / io.Writer it's given — so it has no build tag and no dependency on golang.org/x/sys.
package protocol

import (
	"encoding/binary"
	"errors"
	"io"
)

// ProtocolVersion is the only version this build implements. HELLO negotiates it; any other
// value is refused with ErrorVersion.
const ProtocolVersion = 1

// Type identifies a frame. Low bit 0x40 marks a helper-to-client (h→c) message; everything else
// is client-to-helper (c→h).
type Type byte

const (
	TypeHelloC2H    Type = 0x01
	TypeSpawn       Type = 0x02
	TypeStdin       Type = 0x03
	TypeStdinEnd    Type = 0x04
	TypeCredit      Type = 0x05
	TypeKill        Type = 0x06
	TypeHelloH2C    Type = 0x41
	TypeSpawned     Type = 0x42
	TypeStdout      Type = 0x43
	TypeStderr      Type = 0x44
	TypeEOF         Type = 0x45
	TypeExit        Type = 0x46
	TypeError       Type = 0x47
	TypeStdinCredit Type = 0x48
)

func (t Type) String() string {
	switch t {
	case TypeHelloC2H:
		return "HELLO"
	case TypeSpawn:
		return "SPAWN"
	case TypeStdin:
		return "STDIN"
	case TypeStdinEnd:
		return "STDIN_END"
	case TypeCredit:
		return "CREDIT"
	case TypeKill:
		return "KILL"
	case TypeHelloH2C:
		return "HELLO"
	case TypeSpawned:
		return "SPAWNED"
	case TypeStdout:
		return "STDOUT"
	case TypeStderr:
		return "STDERR"
	case TypeEOF:
		return "EOF"
	case TypeExit:
		return "EXIT"
	case TypeError:
		return "ERROR"
	case TypeStdinCredit:
		return "STDIN_CREDIT"
	default:
		return "UNKNOWN"
	}
}

// IsDataFrame reports whether t carries raw stream bytes (bound to DataFrameMax) rather than a
// small control body (bound to the configured max-frame).
func IsDataFrame(t Type) bool {
	return t == TypeStdin || t == TypeStdout || t == TypeStderr
}

// DataFrameMax is the hard cap on STDIN/STDOUT/STDERR frame bodies, independent of --max-frame.
const DataFrameMax = 64 * 1024

// Limits gathers the size and rate limits negotiated or configured for a connection.
type Limits struct {
	// MaxFrame bounds HELLO/SPAWN and every other control body. Data frames (STDIN/STDOUT/STDERR)
	// are bound to the smaller of this and DataFrameMax.
	MaxFrame uint32
}

var (
	// ErrTooLarge is returned when a frame's declared body length exceeds its limit. The header
	// (5 bytes) is always read; the body never is.
	ErrTooLarge = errors.New("protocol: frame body exceeds the limit")
	// ErrFrameTooShort is returned by DecodeFrameHex/tests when a byte slice is shorter than a
	// complete frame header.
	ErrFrameTooShort = errors.New("protocol: incomplete frame header")
)

func maxBody(t Type, limits Limits) uint32 {
	if IsDataFrame(t) {
		if limits.MaxFrame < DataFrameMax {
			return limits.MaxFrame
		}
		return DataFrameMax
	}
	return limits.MaxFrame
}

// WriteFrame writes one frame: a 4-byte big-endian body length, a 1-byte type, then the body.
func WriteFrame(w io.Writer, t Type, body []byte) error {
	var header [5]byte
	binary.BigEndian.PutUint32(header[0:4], uint32(len(body)))
	header[4] = byte(t)
	if _, err := w.Write(header[:]); err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	_, err := w.Write(body)
	return err
}

// ReadFrame reads exactly one frame from r. It reads the 5-byte header first, checks the declared
// body length against limits, and only then reads the body — never allocating past the limit.
func ReadFrame(r io.Reader, limits Limits) (Type, []byte, error) {
	var header [5]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, nil, err
	}
	length := binary.BigEndian.Uint32(header[0:4])
	t := Type(header[4])
	if length > maxBody(t, limits) {
		return t, nil, ErrTooLarge
	}
	if length == 0 {
		return t, nil, nil
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return 0, nil, err
	}
	return t, body, nil
}

// DecodeFrame parses one complete frame out of buf (header + body, no trailing bytes allowed —
// callers with a byte-accurate slice, such as test vectors, use this; a live connection uses
// ReadFrame directly on the socket instead).
func DecodeFrame(buf []byte, limits Limits) (Type, []byte, error) {
	if len(buf) < 5 {
		return 0, nil, ErrFrameTooShort
	}
	length := binary.BigEndian.Uint32(buf[0:4])
	t := Type(buf[4])
	if length > maxBody(t, limits) {
		return t, nil, ErrTooLarge
	}
	if uint32(len(buf)-5) != length {
		return t, nil, errors.New("protocol: frame length does not match buffer size")
	}
	return t, buf[5:], nil
}
