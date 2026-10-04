package protocol

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
)

func testLimits() Limits {
	return Limits{MaxFrame: 1024 * 1024}
}

func TestWriteReadFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, TypeSpawn, []byte(`{"argv":["git"]}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	typ, body, err := ReadFrame(&buf, testLimits())
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != TypeSpawn {
		t.Errorf("type = %v", typ)
	}
	if string(body) != `{"argv":["git"]}` {
		t.Errorf("body = %q", body)
	}
}

func TestReadFrameZeroLength(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, TypeStdinEnd, nil); err != nil {
		t.Fatalf("write: %v", err)
	}
	typ, body, err := ReadFrame(&buf, testLimits())
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != TypeStdinEnd || len(body) != 0 {
		t.Errorf("type=%v body=%v", typ, body)
	}
}

func TestReadFrameUnknownType(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteFrame(&buf, Type(0xEE), []byte("x")); err != nil {
		t.Fatalf("write: %v", err)
	}
	typ, body, err := ReadFrame(&buf, testLimits())
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != Type(0xEE) || string(body) != "x" {
		t.Errorf("unexpected decode of unknown type: %v %q", typ, body)
	}
	if typ.String() != "UNKNOWN" {
		t.Errorf("String() = %q", typ.String())
	}
}

func TestReadFrameControlTooLarge(t *testing.T) {
	limits := Limits{MaxFrame: 16}
	var buf bytes.Buffer
	if err := WriteFrame(&buf, TypeSpawn, bytes.Repeat([]byte("a"), 17)); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, _, err := ReadFrame(&buf, limits)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
}

func TestReadFrameDataFrameCappedIndependentlyOfMaxFrame(t *testing.T) {
	limits := Limits{MaxFrame: 1024 * 1024}
	var buf bytes.Buffer
	body := bytes.Repeat([]byte("a"), DataFrameMax+1)
	if err := WriteFrame(&buf, TypeStdout, body); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, _, err := ReadFrame(&buf, limits)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge for oversized data frame, got %v", err)
	}
}

func TestReadFrameNeverAllocatesPastLimit(t *testing.T) {
	// A declared length far beyond the limit, followed by nothing: ReadFrame must fail on the
	// length check before attempting to read (and therefore before blocking on) the body.
	limits := Limits{MaxFrame: 16}
	var header bytes.Buffer
	header.Write([]byte{0x7F, 0xFF, 0xFF, 0xFF})
	header.WriteByte(byte(TypeSpawn))
	_, _, err := ReadFrame(&header, limits)
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
}

func TestReadFramePartialHeader(t *testing.T) {
	r := bytes.NewReader([]byte{0x00, 0x00})
	_, _, err := ReadFrame(r, testLimits())
	if !errors.Is(err, io.ErrUnexpectedEOF) && err != io.EOF {
		t.Fatalf("expected an EOF-family error, got %v", err)
	}
}

func TestReadFramePartialBody(t *testing.T) {
	var buf bytes.Buffer
	_ = WriteFrame(&buf, TypeSpawn, []byte("0123456789"))
	truncated := buf.Bytes()[:len(buf.Bytes())-3]
	_, _, err := ReadFrame(bytes.NewReader(truncated), testLimits())
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected io.ErrUnexpectedEOF, got %v", err)
	}
}

func TestStrictJSONRejectsUnknownField(t *testing.T) {
	body := []byte(`{"protocol":1,"extra":true}`)
	if _, err := DecodeHelloC2H(body); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
}

func TestStrictJSONRejectsTrailingData(t *testing.T) {
	body := []byte(`{"protocol":1}{"protocol":1}`)
	if _, err := DecodeHelloC2H(body); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
}

func TestStrictJSONRejectsWrongType(t *testing.T) {
	body := []byte(`{"protocol":"one"}`)
	if _, err := DecodeHelloC2H(body); err == nil {
		t.Fatal("expected an error for a wrong-typed field")
	}
}

func TestSpawnRoundTrip(t *testing.T) {
	v := Spawn{
		Argv:   []string{"git", "status"},
		Env:    []EnvPair{{"PATH", "/usr/bin"}},
		Cwd:    "/srv/wt",
		Stdin:  "pipe",
		Stdout: "pipe",
		Stderr: "null",
	}
	body := EncodeSpawn(v)
	got, err := DecodeSpawn(body)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Cwd != v.Cwd || len(got.Argv) != 2 || len(got.Env) != 1 || got.Env[0][0] != "PATH" {
		t.Errorf("round trip mismatch: %+v", got)
	}
}

func TestBinaryBodiesRoundTrip(t *testing.T) {
	if got, err := DecodeStdinCredit(EncodeStdinCredit(262144)); err != nil || got != 262144 {
		t.Errorf("stdin credit round trip: %v %v", got, err)
	}
	stream, n, err := DecodeCredit(EncodeCredit(StreamStderr, 4096))
	if err != nil || stream != StreamStderr || n != 4096 {
		t.Errorf("credit round trip: %v %v %v", stream, n, err)
	}
	if got, err := DecodeEOF(EncodeEOF(StreamStdout)); err != nil || got != StreamStdout {
		t.Errorf("eof round trip: %v %v", got, err)
	}
}

func TestDecodeStdinCreditWrongSize(t *testing.T) {
	if _, err := DecodeStdinCredit([]byte{1, 2, 3}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
}

func TestDecodeCreditWrongSize(t *testing.T) {
	if _, _, err := DecodeCredit([]byte{1, 2, 3}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
}

func TestDecodeEOFWrongSize(t *testing.T) {
	if _, err := DecodeEOF([]byte{}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
	if _, err := DecodeEOF([]byte{1, 2}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
}

func TestValidSignalAndScope(t *testing.T) {
	for _, sig := range []string{"SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"} {
		if !ValidSignal(sig) {
			t.Errorf("%s should be valid", sig)
		}
	}
	for _, sig := range []string{"SIGSTOP", "SIGCONT", "", "sigterm"} {
		if ValidSignal(sig) {
			t.Errorf("%s should not be valid", sig)
		}
	}
	if !ValidKillScope("process") || !ValidKillScope("group") {
		t.Error("process/group should be valid scopes")
	}
	if ValidKillScope("all") {
		t.Error(`"all" should not be a valid scope`)
	}
}

// Cross-language contract vectors, shared with util/test/kete/tool-helper-protocol.test.ts.

type vectorFile struct {
	ProtocolVersion int      `json:"protocolVersion"`
	Vectors         []vector `json:"vectors"`
}

type vector struct {
	Name     string          `json:"name"`
	Type     string          `json:"type"`
	TypeByte int             `json:"typeByte"`
	FrameHex string          `json:"frameHex"`
	Decoded  decodedExpected `json:"decoded"`
}

type decodedExpected struct {
	Kind   string          `json:"kind"`
	Value  json.RawMessage `json:"value,omitempty"`
	Hex    string          `json:"hex,omitempty"`
	Stream int             `json:"stream,omitempty"`
	// Value below is used for u8/u32/stream_u32 kinds. Named separately from Value (json) to keep
	// the raw-message field generic for the "json" kind.
	IntValue *uint32 `json:"-"`
}

// UnmarshalJSON allows the "value" field to hold either an arbitrary JSON object (kind "json") or
// a bare number (kind "u32"/"u8"/"stream_u32").
func (d *decodedExpected) UnmarshalJSON(data []byte) error {
	type alias struct {
		Kind   string          `json:"kind"`
		Value  json.RawMessage `json:"value,omitempty"`
		Hex    string          `json:"hex,omitempty"`
		Stream int             `json:"stream,omitempty"`
	}
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	d.Kind = a.Kind
	d.Value = a.Value
	d.Hex = a.Hex
	d.Stream = a.Stream
	if len(a.Value) > 0 && (a.Kind == "u32" || a.Kind == "u8" || a.Kind == "stream_u32") {
		var n uint32
		if err := json.Unmarshal(a.Value, &n); err == nil {
			d.IntValue = &n
		}
	}
	return nil
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	data, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("read vectors.json: %v", err)
	}
	var vf vectorFile
	if err := json.Unmarshal(data, &vf); err != nil {
		t.Fatalf("parse vectors.json: %v", err)
	}
	return vf
}

func TestVectors(t *testing.T) {
	vf := loadVectors(t)
	if vf.ProtocolVersion != ProtocolVersion {
		t.Fatalf("vectors.json protocolVersion = %d, implementation = %d", vf.ProtocolVersion, ProtocolVersion)
	}
	limits := Limits{MaxFrame: 1024 * 1024}
	for _, v := range vf.Vectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(v.FrameHex)
			if err != nil {
				t.Fatalf("bad hex: %v", err)
			}
			typ, body, err := DecodeFrame(raw, limits)
			if err != nil {
				t.Fatalf("DecodeFrame: %v", err)
			}
			if int(typ) != v.TypeByte {
				t.Fatalf("type byte = %d, want %d", typ, v.TypeByte)
			}
			verifyDecoded(t, typ, body, v.Decoded)
		})
	}
}

func verifyDecoded(t *testing.T, typ Type, body []byte, expect decodedExpected) {
	t.Helper()
	switch expect.Kind {
	case "json":
		var wantJSON any
		if err := json.Unmarshal(expect.Value, &wantJSON); err != nil {
			t.Fatalf("bad expected JSON: %v", err)
		}
		gotJSON := decodeAny(t, typ, body)
		// Normalize both sides through the same struct-less JSON round trip (map keys sort
		// alphabetically) so field order differences between a decoded struct and the expected
		// generic value don't cause a spurious mismatch.
		gotBytes, _ := json.Marshal(gotJSON)
		var gotGeneric any
		if err := json.Unmarshal(gotBytes, &gotGeneric); err != nil {
			t.Fatalf("re-decode got value: %v", err)
		}
		gotNorm, _ := json.Marshal(gotGeneric)
		wantBytes, _ := json.Marshal(wantJSON)
		if string(gotNorm) != string(wantBytes) {
			t.Errorf("decoded mismatch: got %s want %s", gotNorm, wantBytes)
		}
	case "raw":
		want, err := hex.DecodeString(expect.Hex)
		if err != nil {
			t.Fatalf("bad expected hex: %v", err)
		}
		if !bytes.Equal(body, want) {
			t.Errorf("raw body mismatch: got %x want %x", body, want)
		}
	case "empty":
		if len(body) != 0 {
			t.Errorf("expected empty body, got %x", body)
		}
	case "u32":
		got, err := DecodeStdinCredit(body)
		if err != nil {
			t.Fatalf("decode u32: %v", err)
		}
		if expect.IntValue == nil || got != *expect.IntValue {
			t.Errorf("u32 mismatch: got %d want %v", got, expect.IntValue)
		}
	case "u8":
		got, err := DecodeEOF(body)
		if err != nil {
			t.Fatalf("decode u8: %v", err)
		}
		if expect.IntValue == nil || uint32(got) != *expect.IntValue {
			t.Errorf("u8 mismatch: got %d want %v", got, expect.IntValue)
		}
	case "stream_u32":
		stream, n, err := DecodeCredit(body)
		if err != nil {
			t.Fatalf("decode stream_u32: %v", err)
		}
		if int(stream) != expect.Stream || expect.IntValue == nil || n != *expect.IntValue {
			t.Errorf("stream_u32 mismatch: got stream=%d n=%d want stream=%d n=%v", stream, n, expect.Stream, expect.IntValue)
		}
	default:
		t.Fatalf("unknown expected kind %q", expect.Kind)
	}
}

func decodeAny(t *testing.T, typ Type, body []byte) any {
	t.Helper()
	var v any
	var err error
	switch typ {
	case TypeHelloC2H:
		v, err = DecodeHelloC2H(body)
	case TypeHelloH2C:
		v, err = DecodeHelloH2C(body)
	case TypeSpawn:
		v, err = DecodeSpawn(body)
	case TypeSpawned:
		v, err = DecodeSpawned(body)
	case TypeKill:
		v, err = DecodeKill(body)
	case TypeExit:
		v, err = DecodeExit(body)
	case TypeError:
		v, err = DecodeErrorBody(body)
	default:
		t.Fatalf("decodeAny: unhandled type %v", typ)
	}
	if err != nil {
		t.Fatalf("decode %v: %v", typ, err)
	}
	return v
}
