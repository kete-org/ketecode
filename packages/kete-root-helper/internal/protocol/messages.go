package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Protocol-wide limits (module README "Limits").
const (
	MaxArgv              = 4096
	MaxEnvEntries        = 1024
	HandshakeTimeout     = 5 * time.Second
	SpawnTimeout         = 5 * time.Second
	MaxOutstandingCredit = 16 * 1024 * 1024
	SocketWriteDeadline  = 60 * time.Second
)

// Stream identifiers used by CREDIT and EOF bodies.
const (
	StreamStdout uint8 = 1
	StreamStderr uint8 = 2
)

// ErrorCode is one of the fixed refusal/error codes the helper reports in an ERROR body. Never
// argv or env values — see the module README.
type ErrorCode string

const (
	ErrorVersion    ErrorCode = "version"
	ErrorPeer       ErrorCode = "peer"
	ErrorTooLarge   ErrorCode = "too_large"
	ErrorBadRequest ErrorCode = "bad_request"
	ErrorRate       ErrorCode = "rate"
	ErrorBusy       ErrorCode = "busy"
	ErrorEnv        ErrorCode = "env"
	ErrorCwd        ErrorCode = "cwd"
	ErrorNotFound   ErrorCode = "not_found"
	ErrorExec       ErrorCode = "exec"
	ErrorIdentity   ErrorCode = "identity"
	ErrorNNP        ErrorCode = "nnp"
	ErrorInternal   ErrorCode = "internal"
)

// ErrBadRequest is returned by the binary-body decoders below when a body has the wrong shape.
var ErrBadRequest = errors.New("protocol: malformed message body")

// decodeStrict JSON-decodes body into v, rejecting unknown fields and any trailing data —
// messages.go's bodies are never partial reads by the time they reach here (ReadFrame/DecodeFrame
// already sized them exactly).
func decodeStrict(body []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if dec.More() {
		return fmt.Errorf("%w: trailing data after JSON body", ErrBadRequest)
	}
	return nil
}

// HelloC2H is the client's first frame (type HELLO, 0x01).
type HelloC2H struct {
	Protocol int `json:"protocol"`
}

func DecodeHelloC2H(body []byte) (HelloC2H, error) {
	var v HelloC2H
	err := decodeStrict(body, &v)
	return v, err
}

func EncodeHelloC2H(v HelloC2H) []byte {
	b, _ := json.Marshal(v)
	return b
}

// HelloH2C is the helper's reply (type HELLO, 0x41).
type HelloH2C struct {
	Protocol     int      `json:"protocol"`
	MaxFrame     uint32   `json:"maxFrame"`
	DataChunk    uint32   `json:"dataChunk"`
	StdinWindow  uint32   `json:"stdinWindow"`
	OutputWindow uint32   `json:"outputWindow"`
	Env          []string `json:"env"`
}

func DecodeHelloH2C(body []byte) (HelloH2C, error) {
	var v HelloH2C
	err := decodeStrict(body, &v)
	return v, err
}

func EncodeHelloH2C(v HelloH2C) []byte {
	if v.Env == nil {
		v.Env = []string{}
	}
	b, _ := json.Marshal(v)
	return b
}

// EnvPair is a [name, value] entry in a SPAWN request's env list.
type EnvPair [2]string

// Spawn is the client's process request (type SPAWN, 0x02), sent exactly once per connection.
type Spawn struct {
	Argv   []string  `json:"argv"`
	Env    []EnvPair `json:"env"`
	Cwd    string    `json:"cwd"`
	Stdin  string    `json:"stdin"`
	Stdout string    `json:"stdout"`
	Stderr string    `json:"stderr"`
}

func DecodeSpawn(body []byte) (Spawn, error) {
	var v Spawn
	if err := decodeStrict(body, &v); err != nil {
		return Spawn{}, err
	}
	return v, nil
}

func EncodeSpawn(v Spawn) []byte {
	if v.Env == nil {
		v.Env = []EnvPair{}
	}
	b, _ := json.Marshal(v)
	return b
}

// Spawned is the helper's reply once stage 2 has exec'd (type SPAWNED, 0x42).
type Spawned struct {
	Pid int    `json:"pid"`
	ID  string `json:"id"`
}

func DecodeSpawned(body []byte) (Spawned, error) {
	var v Spawned
	err := decodeStrict(body, &v)
	return v, err
}

func EncodeSpawned(v Spawned) []byte {
	b, _ := json.Marshal(v)
	return b
}

// Kill is a client request to signal the spawned process (type KILL, 0x06).
type Kill struct {
	Signal string `json:"signal"`
	Scope  string `json:"scope"`
}

func DecodeKill(body []byte) (Kill, error) {
	var v Kill
	err := decodeStrict(body, &v)
	return v, err
}

func EncodeKill(v Kill) []byte {
	b, _ := json.Marshal(v)
	return b
}

// Exit reports the leader's termination (type EXIT, 0x46): exactly one of Code/Signal is non-nil.
type Exit struct {
	Code   *int    `json:"code"`
	Signal *string `json:"signal"`
}

func DecodeExit(body []byte) (Exit, error) {
	var v Exit
	err := decodeStrict(body, &v)
	return v, err
}

func EncodeExit(v Exit) []byte {
	b, _ := json.Marshal(v)
	return b
}

// ErrorBody is always terminal: the helper closes the connection right after sending it (type
// ERROR, 0x47).
type ErrorBody struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}

func DecodeErrorBody(body []byte) (ErrorBody, error) {
	var v ErrorBody
	err := decodeStrict(body, &v)
	return v, err
}

func EncodeErrorBody(v ErrorBody) []byte {
	b, _ := json.Marshal(v)
	return b
}

// Binary bodies -------------------------------------------------------------------------------

// EncodeStdinCredit encodes a STDIN_CREDIT body (type 0x48): a 4-byte big-endian byte count.
func EncodeStdinCredit(bytesAvailable uint32) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, bytesAvailable)
	return b
}

func DecodeStdinCredit(body []byte) (uint32, error) {
	if len(body) != 4 {
		return 0, ErrBadRequest
	}
	return binary.BigEndian.Uint32(body), nil
}

// EncodeCredit encodes a CREDIT body (type 0x05): a 1-byte stream id then a 4-byte big-endian
// byte count.
func EncodeCredit(stream uint8, n uint32) []byte {
	b := make([]byte, 5)
	b[0] = stream
	binary.BigEndian.PutUint32(b[1:5], n)
	return b
}

func DecodeCredit(body []byte) (stream uint8, n uint32, err error) {
	if len(body) != 5 {
		return 0, 0, ErrBadRequest
	}
	return body[0], binary.BigEndian.Uint32(body[1:5]), nil
}

// EncodeEOF encodes an EOF body (type 0x45): a 1-byte stream id.
func EncodeEOF(stream uint8) []byte {
	return []byte{stream}
}

func DecodeEOF(body []byte) (uint8, error) {
	if len(body) != 1 {
		return 0, ErrBadRequest
	}
	return body[0], nil
}

// ValidStream reports whether stream is StreamStdout or StreamStderr.
func ValidStream(stream uint8) bool {
	return stream == StreamStdout || stream == StreamStderr
}

// ValidSignal reports whether name is one of the signals the helper accepts in a KILL request
// (module README "Kill").
func ValidSignal(name string) bool {
	switch name {
	case "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2":
		return true
	default:
		return false
	}
}

// ValidKillScope reports whether scope is "process" or "group".
func ValidKillScope(scope string) bool {
	return scope == "process" || scope == "group"
}
