//go:build integration && linux

// Package itest runs the helper as a real root process against real second/third users and a
// real cgroup v2 hierarchy (module README "How to test"; scripts/integration.sh sets all this
// up). It never runs in `go test ./...`; only `go test -tags integration -run . ./internal/itest`
// as root.
//
// This binary plays three roles, selected by environment variables scripts/integration.sh sets
// (checked in TestMain/init before the normal testing machinery runs, since two of the roles
// re-exec this same binary as a different uid or as the spawned "tool"):
//   - the test process itself (root): starts the real helper as a subprocess, drives the
//     scenarios below, and cleans up;
//   - the "kete-side" client (KETE_IT_ROLE=client): re-executed with Credential{Uid: keteUID} —
//     Go can't switch uid per goroutine — to speak the protocol as the kete uid the socket
//     actually accepts; reads a JSON request from KETE_IT_REQUEST_FILE, writes a JSON result to
//     KETE_IT_RESULT_FILE;
//   - the "report" tool program (KETE_IT_ROLE=report, argv[0] is this binary's absolute path):
//     spawned by the helper as the tool user; prints identity/fd/cgroup facts as JSON to stdout.
package itest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/protocol"
)

// env carries scripts/integration.sh's setup into the tests.
type env struct {
	keteUID      uint32
	keteGID      uint32
	toolUID      uint32
	toolGID      uint32
	thirdUID     uint32
	thirdGID     uint32
	worktreeRoot string
	toolCgroup   string
	helperBin    string
	socketDir    string
	testBin      string // this binary's own absolute path (os.Executable)
}

func loadEnv(t *testing.T) env {
	t.Helper()
	get := func(name string) string {
		v := os.Getenv(name)
		if v == "" {
			t.Fatalf("integration test requires %s (see scripts/integration.sh)", name)
		}
		return v
	}
	parseUint := func(name string) uint32 {
		v, err := strconv.ParseUint(get(name), 10, 32)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return uint32(v)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return env{
		keteUID:      parseUint("KETE_IT_KETE_UID"),
		keteGID:      parseUint("KETE_IT_KETE_GID"),
		toolUID:      parseUint("KETE_IT_TOOL_UID"),
		toolGID:      parseUint("KETE_IT_TOOL_GID"),
		thirdUID:     parseUint("KETE_IT_THIRD_UID"),
		thirdGID:     parseUint("KETE_IT_THIRD_GID"),
		worktreeRoot: get("KETE_IT_WORKTREE_ROOT"),
		toolCgroup:   get("KETE_IT_TOOL_CGROUP"),
		helperBin:    get("KETE_IT_HELPER_BIN"),
		socketDir:    get("KETE_IT_SOCKET_DIR"),
		testBin:      self,
	}
}

// startHelper launches the real helper binary as the current process (must be root) with the
// given env-allow/env-set, returning its socket path and a stop function.
func startHelper(t *testing.T, e env, extraArgs ...string) (socket string, stop func()) {
	t.Helper()
	socket, _, stop = startHelperWithPid(t, e, extraArgs...)
	return socket, stop
}

// startHelperWithPid is startHelper, also returning the helper's pid (stable across its internal
// NNP self-re-exec, since exec(2) never changes the pid) so tests can inspect /proc/<pid>.
func startHelperWithPid(t *testing.T, e env, extraArgs ...string) (socket string, pid int, stop func()) {
	t.Helper()
	socket = filepath.Join(e.socketDir, fmt.Sprintf("it-%d.sock", time.Now().UnixNano()))
	args := append([]string{
		"--socket", socket,
		"--kete-uid", strconv.FormatUint(uint64(e.keteUID), 10),
		"--tool-uid", strconv.FormatUint(uint64(e.toolUID), 10),
		"--tool-gid", strconv.FormatUint(uint64(e.toolGID), 10),
		"--worktree-root", e.worktreeRoot,
		"--tool-cgroup", e.toolCgroup,
		"--env-allow", "PATH,HOME,KETE_IT_ROLE",
		"--spawn-rate", "1000",
		"--spawn-burst", "1000",
	}, extraArgs...)
	cmd := exec.Command(e.helperBin, args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(socket); err == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			t.Fatalf("timed out waiting for helper socket %s", socket)
		}
		time.Sleep(20 * time.Millisecond)
	}
	return socket, cmd.Process.Pid, func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
		}
	}
}

// clientRequest / clientResult are the client role's stdin/stdout contract. Binary payloads use
// []byte fields (encoding/json base64-encodes those automatically) rather than string: a Go
// string round-tripped through JSON is only valid UTF-8 — encoding/json silently replaces any
// invalid byte with U+FFFD, which both corrupts and *inflates* arbitrary binary data (each
// replaced byte becomes a 3-byte sequence).
type clientRequest struct {
	Socket       string      `json:"socket"`
	Argv         []string    `json:"argv"`
	Env          [][2]string `json:"env"`
	Cwd          string      `json:"cwd"`
	Stdin        string      `json:"stdin"`  // "pipe" | "null"
	Stdout       string      `json:"stdout"` // "pipe" | "null"
	Stderr       string      `json:"stderr"` // "pipe" | "null"
	StdinData    []byte      `json:"stdinData"`
	KillAfterMS  int         `json:"killAfterMs"`
	KillSignal   string      `json:"killSignal"`
	KillScope    string      `json:"killScope"`
	ReadDeadline int         `json:"readDeadlineMs"`
}

type clientResult struct {
	SpawnedPid   int     `json:"spawnedPid"`
	ExitCode     *int    `json:"exitCode"`
	ExitSignal   *string `json:"exitSignal"`
	Stdout       []byte  `json:"stdout"`
	Stderr       []byte  `json:"stderr"`
	ErrorCode    string  `json:"errorCode"`
	ErrorMessage string  `json:"errorMessage"`
}

func runClientRole() {
	reqFile := os.Getenv("KETE_IT_REQUEST_FILE")
	resFile := os.Getenv("KETE_IT_RESULT_FILE")
	raw, err := os.ReadFile(reqFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read request:", err)
		os.Exit(1)
	}
	var req clientRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		fmt.Fprintln(os.Stderr, "parse request:", err)
		os.Exit(1)
	}
	result := doClient(req)
	body, _ := json.Marshal(result)
	if err := os.WriteFile(resFile, body, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "write result:", err)
		os.Exit(1)
	}
}

func doClient(req clientRequest) clientResult {
	result := clientResult{}
	deadline := time.Duration(req.ReadDeadline) * time.Millisecond
	if deadline == 0 {
		deadline = 10 * time.Second
	}
	conn, err := net.DialTimeout("unix", req.Socket, 3*time.Second)
	if err != nil {
		result.ErrorCode = "connect"
		result.ErrorMessage = err.Error()
		return result
	}
	defer conn.Close()

	limits := protocol.Limits{MaxFrame: 4 * 1024 * 1024}
	_ = conn.SetDeadline(time.Now().Add(deadline))

	// A peer the server refuses outright (e.g. peer uid mismatch) may close the connection right
	// after accept, before this write reaches it — read the reply regardless of whether the
	// write itself reports an error; the server's ERROR frame (or the connection closing) is the
	// authoritative signal either way.
	_ = protocol.WriteFrame(conn, protocol.TypeHelloC2H, protocol.EncodeHelloC2H(protocol.HelloC2H{Protocol: 1}))
	typ, body, err := protocol.ReadFrame(conn, limits)
	if err != nil {
		result.ErrorCode = "handshake"
		result.ErrorMessage = fmt.Sprintf("type=%v err=%v", typ, err)
		return result
	}
	if typ == protocol.TypeError {
		eb, _ := protocol.DecodeErrorBody(body)
		result.ErrorCode = string(eb.Code)
		result.ErrorMessage = eb.Message
		return result
	}
	if typ != protocol.TypeHelloH2C {
		result.ErrorCode = "handshake"
		result.ErrorMessage = fmt.Sprintf("unexpected type %v", typ)
		return result
	}

	env := make([]protocol.EnvPair, len(req.Env))
	for i, kv := range req.Env {
		env[i] = protocol.EnvPair{kv[0], kv[1]}
	}
	spawn := protocol.Spawn{Argv: req.Argv, Env: env, Cwd: req.Cwd, Stdin: req.Stdin, Stdout: req.Stdout, Stderr: req.Stderr}
	if err := protocol.WriteFrame(conn, protocol.TypeSpawn, protocol.EncodeSpawn(spawn)); err != nil {
		result.ErrorCode = "io"
		result.ErrorMessage = err.Error()
		return result
	}
	typ, body, err = protocol.ReadFrame(conn, limits)
	if err != nil {
		result.ErrorCode = "io"
		result.ErrorMessage = err.Error()
		return result
	}
	if typ == protocol.TypeError {
		eb, _ := protocol.DecodeErrorBody(body)
		result.ErrorCode = string(eb.Code)
		result.ErrorMessage = eb.Message
		return result
	}
	if typ != protocol.TypeSpawned {
		result.ErrorCode = "protocol"
		result.ErrorMessage = fmt.Sprintf("unexpected type %v", typ)
		return result
	}
	spawned, _ := protocol.DecodeSpawned(body)
	result.SpawnedPid = spawned.Pid

	var stdout, stderr bytes.Buffer
	stdoutEOF := req.Stdout != "pipe"
	stderrEOF := req.Stderr != "pipe"
	exited := false
	stdinSent := false
	killSent := req.KillAfterMS <= 0

	// Comfortably above the largest test payload (a few hundred KiB) but under
	// protocol.MaxOutstandingCredit (16 MiB).
	const testCreditGrant = 8 * 1024 * 1024
	if req.Stdout == "pipe" {
		_ = protocol.WriteFrame(conn, protocol.TypeCredit, protocol.EncodeCredit(protocol.StreamStdout, testCreditGrant))
	}
	if req.Stderr == "pipe" {
		_ = protocol.WriteFrame(conn, protocol.TypeCredit, protocol.EncodeCredit(protocol.StreamStderr, testCreditGrant))
	}

	killTimer := time.NewTimer(time.Duration(req.KillAfterMS) * time.Millisecond)
	if killSent {
		killTimer.Stop()
	}

	for !(exited && stdoutEOF && stderrEOF) {
		if !killSent {
			select {
			case <-killTimer.C:
				_ = protocol.WriteFrame(conn, protocol.TypeKill, protocol.EncodeKill(protocol.Kill{Signal: req.KillSignal, Scope: req.KillScope}))
				killSent = true
			default:
			}
		}
		_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		typ, body, err := protocol.ReadFrame(conn, limits)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			result.ErrorCode = "io"
			result.ErrorMessage = err.Error()
			break
		}
		switch typ {
		case protocol.TypeStdinCredit:
			if req.Stdin == "pipe" && !stdinSent {
				data := req.StdinData
				// STDIN is a data frame, capped at protocol.DataFrameMax (64 KiB) independent of
				// the granted credit window.
				for len(data) > 0 {
					chunk := data
					if len(chunk) > protocol.DataFrameMax {
						chunk = chunk[:protocol.DataFrameMax]
					}
					_ = protocol.WriteFrame(conn, protocol.TypeStdin, chunk)
					data = data[len(chunk):]
				}
				_ = protocol.WriteFrame(conn, protocol.TypeStdinEnd, nil)
				stdinSent = true
			}
		case protocol.TypeStdout:
			stdout.Write(body)
		case protocol.TypeStderr:
			stderr.Write(body)
		case protocol.TypeEOF:
			stream, _ := protocol.DecodeEOF(body)
			if stream == protocol.StreamStdout {
				stdoutEOF = true
			} else {
				stderrEOF = true
			}
		case protocol.TypeExit:
			ex, _ := protocol.DecodeExit(body)
			result.ExitCode = ex.Code
			result.ExitSignal = ex.Signal
			exited = true
		case protocol.TypeError:
			eb, _ := protocol.DecodeErrorBody(body)
			result.ErrorCode = string(eb.Code)
			result.ErrorMessage = eb.Message
			exited = true
			stdoutEOF, stderrEOF = true, true
		}
	}
	result.Stdout = stdout.Bytes()
	result.Stderr = stderr.Bytes()
	return result
}

// runReportRole prints identity/fd/cgroup facts as JSON to stdout, then exits — this is what
// AC1's "report" tool program does when the helper spawns it.
//
// The report program is itself a Go binary (this test binary, re-executed), so its own runtime
// unavoidably opens a small baseline of fds after the tool's execve (at least the netpoller epoll
// instance) — those are not something the helper's close_range(3, ~0U, CLOSE_RANGE_CLOEXEC) could
// or should prevent, since they're opened by code running *after* the exec it protects. What that
// call does guarantee is that no *helper* resource (the spec pipe, the status pipe, the O_PATH
// root fd, the client socket) survives into the tool — so alongside the raw fd numbers, this
// records each fd's /proc/self/fd/<n> symlink target, and the test asserts none of the extras are
// a pipe: or socket:, while excluding the enumerating fd itself from the count.
func runReportRole() {
	type reportBody struct {
		UID       int      `json:"uid"`
		EUID      int      `json:"euid"`
		GID       int      `json:"gid"`
		EGID      int      `json:"egid"`
		Groups    []int    `json:"groups"`
		NNP       string   `json:"nnp"`
		Cwd       string   `json:"cwd"`
		Cgroup    string   `json:"cgroup"`
		OpenFDs   []int    `json:"openFds"`
		FDTargets []string `json:"fdTargets"`
		CapEff    string   `json:"capEff"`
	}
	rb := reportBody{UID: os.Getuid(), EUID: os.Geteuid(), GID: os.Getgid(), EGID: os.Getegid()}
	groups, _ := os.Getgroups()
	rb.Groups = groups
	if data, err := os.ReadFile("/proc/self/status"); err == nil {
		rb.NNP = grepField(string(data), "NoNewPrivs:")
		rb.CapEff = grepField(string(data), "CapEff:")
	}
	if cwd, err := os.Getwd(); err == nil {
		rb.Cwd = cwd
	}
	if data, err := os.ReadFile("/proc/self/cgroup"); err == nil {
		rb.Cgroup = string(bytes.TrimSpace(data))
	}

	dirFile, err := os.Open("/proc/self/fd")
	if err == nil {
		selfFD := int(dirFile.Fd()) // exclude the listing fd itself from the results
		names, _ := dirFile.Readdirnames(-1)
		_ = dirFile.Close()
		for _, name := range names {
			n, err := strconv.Atoi(name)
			if err != nil || n == selfFD {
				continue
			}
			rb.OpenFDs = append(rb.OpenFDs, n)
			target, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", n))
			if err != nil {
				target = "(gone)"
			}
			rb.FDTargets = append(rb.FDTargets, fmt.Sprintf("%d=%s", n, target))
		}
	}
	body, _ := json.Marshal(rb)
	fmt.Println(string(body))
}

func grepField(status, prefix string) string {
	for _, line := range splitLines(status) {
		if len(line) > len(prefix) && line[:len(prefix)] == prefix {
			return trimSpace(line[len(prefix):])
		}
	}
	return ""
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i, c := range s {
		if c == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

func init() {
	switch os.Getenv("KETE_IT_ROLE") {
	case "client":
		runClientRole()
		os.Exit(0)
	case "report":
		runReportRole()
		os.Exit(0)
	}
}

// runAsClient runs a request as the kete uid, via a re-exec of this binary with Credential — Go
// cannot switch uid per goroutine, only per process (module README "How to test").
func runAsClient(t *testing.T, e env, req clientRequest) clientResult {
	t.Helper()
	return runAsUID(t, e, e.keteUID, e.keteGID, req)
}

// runAsUID is runAsClient for an arbitrary uid/gid, so AC2's peer-uid tests can also connect as
// the tool uid or a third uid.
func runAsUID(t *testing.T, e env, uid, gid uint32, req clientRequest) clientResult {
	t.Helper()
	// t.TempDir() nests under a root-owned, mode-0700 per-test directory that a different uid
	// can't traverse into at all; a plain os.MkdirTemp() under os.TempDir() (world-traversable,
	// sticky) avoids that, so chmod 0777 on the leaf is actually reachable.
	dir, err := os.MkdirTemp("", "kete-it-req-")
	if err != nil {
		t.Fatalf("mkdir temp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	reqFile := filepath.Join(dir, "req.json")
	resFile := filepath.Join(dir, "res.json")
	body, _ := json.Marshal(req)
	if err := os.WriteFile(reqFile, body, 0o600); err != nil {
		t.Fatalf("write request: %v", err)
	}
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatalf("chmod temp dir: %v", err)
	}
	if err := os.Chmod(reqFile, 0o666); err != nil {
		t.Fatalf("chmod request: %v", err)
	}

	cmd := exec.Command(e.testBin)
	cmd.Env = []string{
		"KETE_IT_ROLE=client",
		"KETE_IT_REQUEST_FILE=" + reqFile,
		"KETE_IT_RESULT_FILE=" + resFile,
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: gid}}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("client role failed: %v; stderr=%s", err, stderr.String())
	}
	resBody, err := os.ReadFile(resFile)
	if err != nil {
		t.Fatalf("read result: %v; stderr=%s", err, stderr.String())
	}
	var result clientResult
	if err := json.Unmarshal(resBody, &result); err != nil {
		t.Fatalf("parse result: %v", err)
	}
	return result
}
