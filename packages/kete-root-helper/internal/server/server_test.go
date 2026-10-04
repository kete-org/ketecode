//go:build linux

package server

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/protocol"
)

// fakeLauncher lets server_test.go exercise the whole connection state machine without any
// cgroup or root privilege — real OS pipes stand in for the tool's stdio.
type fakeLauncher struct {
	mu        sync.Mutex
	spawnFn   func(req launch.SpawnRequest) (*launch.Process, error)
	killed    []killCall
	released  []string
	killErr   error
	releaseCh chan string
}

type killCall struct {
	id     string
	signal string
	scope  string
}

func newFakeLauncher() *fakeLauncher {
	return &fakeLauncher{releaseCh: make(chan string, 64)}
}

func (f *fakeLauncher) Spawn(req launch.SpawnRequest) (*launch.Process, error) {
	return f.spawnFn(req)
}

func (f *fakeLauncher) Kill(proc *launch.Process, signal string, scope string) error {
	f.mu.Lock()
	f.killed = append(f.killed, killCall{id: proc.ID, signal: signal, scope: scope})
	f.mu.Unlock()
	return f.killErr
}

func (f *fakeLauncher) Release(proc *launch.Process) {
	f.mu.Lock()
	f.released = append(f.released, proc.ID)
	f.mu.Unlock()
	f.releaseCh <- proc.ID
}

func (f *fakeLauncher) killCalls() []killCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]killCall(nil), f.killed...)
}

// fakeProcess constructs a *launch.Process backed by real pipes, and returns the parent-side
// handles a test drives directly (writing "child stdout", reading "child stdin", etc.) along with
// a function to deliver the exit result.
type fakeProcessHandles struct {
	toChildStdin    *os.File // test reads what the session wrote to stdin
	fromChildStdout *os.File // test writes "child" stdout here
	fromChildStderr *os.File
	sendExit        func(launch.ExitResult)
}

func newFakeProcess(id string, pid int, stdin, stdout, stderr bool) (*launch.Process, *fakeProcessHandles) {
	proc := &launch.Process{ID: id, Pid: pid}
	handles := &fakeProcessHandles{}
	exitCh := make(chan launch.ExitResult, 1)
	proc.ExitCh = exitCh
	handles.sendExit = func(r launch.ExitResult) { exitCh <- r }

	if stdin {
		r, w, _ := os.Pipe()
		proc.Stdin = w
		handles.toChildStdin = r
	}
	if stdout {
		r, w, _ := os.Pipe()
		proc.Stdout = r
		handles.fromChildStdout = w
	}
	if stderr {
		r, w, _ := os.Pipe()
		proc.Stderr = r
		handles.fromChildStderr = w
	}
	return proc, handles
}

func testConfig(t *testing.T, keteUID uint32, worktreeRoot string) Config {
	t.Helper()
	return Config{
		KeteUID:      keteUID,
		MaxFrame:     1024 * 1024,
		MaxProcesses: 4,
		WorktreeRoot: worktreeRoot,
		EnvAllow:     []string{"PATH", "HOME"},
		EnvSet:       map[string]string{},
		SpawnRate:    1000,
		SpawnBurst:   1000,
	}
}

func startServer(t *testing.T, launcher Launcher, cfg Config) (socketPath string, stop func()) {
	t.Helper()
	dir := t.TempDir()
	socketPath = filepath.Join(dir, "helper.sock")
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	done := make(chan struct{})
	go func() {
		_ = Serve(ln, launcher, cfg, nil)
		close(done)
	}()
	return socketPath, func() {
		_ = ln.Close()
		<-done
	}
}

func dial(t *testing.T, socketPath string) *net.UnixConn {
	t.Helper()
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn.(*net.UnixConn)
}

func limits(cfg Config) protocol.Limits { return protocol.Limits{MaxFrame: cfg.MaxFrame} }

func doHandshake(t *testing.T, conn *net.UnixConn, cfg Config) protocol.HelloH2C {
	t.Helper()
	if err := protocol.WriteFrame(conn, protocol.TypeHelloC2H, protocol.EncodeHelloC2H(protocol.HelloC2H{Protocol: 1})); err != nil {
		t.Fatalf("write HELLO: %v", err)
	}
	typ, body, err := protocol.ReadFrame(conn, limits(cfg))
	if err != nil {
		t.Fatalf("read HELLO reply: %v", err)
	}
	if typ != protocol.TypeHelloH2C {
		t.Fatalf("expected HELLO reply, got type %v", typ)
	}
	reply, err := protocol.DecodeHelloH2C(body)
	if err != nil {
		t.Fatalf("decode HELLO reply: %v", err)
	}
	return reply
}

func sendSpawn(t *testing.T, conn *net.UnixConn, spawn protocol.Spawn) {
	t.Helper()
	if err := protocol.WriteFrame(conn, protocol.TypeSpawn, protocol.EncodeSpawn(spawn)); err != nil {
		t.Fatalf("write SPAWN: %v", err)
	}
}

func readOne(t *testing.T, conn *net.UnixConn, cfg Config) (protocol.Type, []byte) {
	t.Helper()
	typ, body, err := protocol.ReadFrame(conn, limits(cfg))
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return typ, body
}

func basicSpawn(cwd string) protocol.Spawn {
	return protocol.Spawn{
		Argv:   []string{"true"},
		Env:    []protocol.EnvPair{{"PATH", "/usr/bin"}},
		Cwd:    cwd,
		Stdin:  "null",
		Stdout: "pipe",
		Stderr: "pipe",
	}
}

func TestHandshakeAndSpawnedFlow(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	proc, handles := newFakeProcess("p1", 4242, false, true, true)
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { return proc, nil }

	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	defer conn.Close()

	reply := doHandshake(t, conn, cfg)
	if reply.Protocol != 1 {
		t.Fatalf("protocol = %d", reply.Protocol)
	}
	if len(reply.Env) != 2 {
		t.Fatalf("env = %v", reply.Env)
	}

	sendSpawn(t, conn, basicSpawn(root))
	typ, body := readOne(t, conn, cfg)
	if typ != protocol.TypeSpawned {
		t.Fatalf("expected SPAWNED, got %v", typ)
	}
	spawned, err := protocol.DecodeSpawned(body)
	if err != nil || spawned.Pid != 4242 || spawned.ID != "p1" {
		t.Fatalf("spawned = %+v err=%v", spawned, err)
	}

	_, _ = handles.fromChildStdout.WriteString("out\n")
	_ = handles.fromChildStdout.Close()
	_, _ = handles.fromChildStderr.WriteString("err\n")
	_ = handles.fromChildStderr.Close()

	// Grant output credit for both streams.
	_ = protocol.WriteFrame(conn, protocol.TypeCredit, protocol.EncodeCredit(protocol.StreamStdout, 4096))
	_ = protocol.WriteFrame(conn, protocol.TypeCredit, protocol.EncodeCredit(protocol.StreamStderr, 4096))

	code := 0
	handles.sendExit(launch.ExitResult{Code: &code})

	seen := map[protocol.Type]bool{}
	deadline := time.Now().Add(5 * time.Second)
	for len(seen) < 4 { // STDOUT, STDERR, two EOFs at minimum before EXIT
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for frames, seen=%v", seen)
		}
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		typ, body, err := protocol.ReadFrame(conn, limits(cfg))
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		switch typ {
		case protocol.TypeStdout:
			if string(body) != "out\n" {
				t.Errorf("stdout body = %q", body)
			}
			seen[protocol.TypeStdout] = true
		case protocol.TypeStderr:
			if string(body) != "err\n" {
				t.Errorf("stderr body = %q", body)
			}
			seen[protocol.TypeStderr] = true
		case protocol.TypeEOF:
			seen[protocol.Type(0x45)] = true // count both EOFs via re-use below
		case protocol.TypeExit:
			exit, err := protocol.DecodeExit(body)
			if err != nil || exit.Code == nil || *exit.Code != 0 {
				t.Errorf("exit = %+v err=%v", exit, err)
			}
			seen[protocol.TypeExit] = true
		}
	}

	select {
	case id := <-fake.releaseCh:
		if id != "p1" {
			t.Errorf("released id = %q", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Release")
	}
}

func TestPeerUIDMismatchRefused(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { t.Fatal("should not spawn"); return nil, nil }
	// A uid that can never match the real connecting (self) uid.
	cfg := testConfig(t, uint32(os.Getuid())+12345, root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	defer conn.Close()
	_ = protocol.WriteFrame(conn, protocol.TypeHelloC2H, protocol.EncodeHelloC2H(protocol.HelloC2H{Protocol: 1}))
	typ, body := readOne(t, conn, cfg)
	if typ != protocol.TypeError {
		t.Fatalf("expected ERROR, got %v", typ)
	}
	errBody, err := protocol.DecodeErrorBody(body)
	if err != nil || errBody.Code != protocol.ErrorPeer {
		t.Fatalf("error = %+v err=%v", errBody, err)
	}
}

func TestHandshakeTimeout(t *testing.T) {
	t.Skip("protocol.HandshakeTimeout is 5s; covered indirectly by manual/integration runs to keep unit tests fast")
}

func TestOutOfOrderFrameRefused(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	proc, _ := newFakeProcess("p1", 1, false, false, false)
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { return proc, nil }
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	defer conn.Close()
	// SPAWN before HELLO.
	sendSpawn(t, conn, basicSpawn(root))
	typ, body := readOne(t, conn, cfg)
	if typ != protocol.TypeError {
		t.Fatalf("expected ERROR, got %v", typ)
	}
	errBody, _ := protocol.DecodeErrorBody(body)
	if errBody.Code != protocol.ErrorBadRequest {
		t.Errorf("code = %v", errBody.Code)
	}
}

func TestOversizedFrameRefused(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	cfg := testConfig(t, uint32(os.Getuid()), root)
	cfg.MaxFrame = 64 * 1024
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	defer conn.Close()
	// A 5-byte frame header alone, declaring a body length beyond the limit: ReadFrame rejects it
	// without ever reading a body (module README: "the helper never allocates past the limit"),
	// so the test never sends one — avoiding a race between the server closing early and the
	// client still writing a 64 KiB+ payload.
	var header [5]byte
	binary.BigEndian.PutUint32(header[0:4], cfg.MaxFrame+1)
	header[4] = byte(protocol.TypeHelloC2H)
	if _, err := conn.Write(header[:]); err != nil {
		t.Fatalf("write header: %v", err)
	}
	typ, body := readOne(t, conn, cfg)
	if typ != protocol.TypeError {
		t.Fatalf("expected ERROR, got %v", typ)
	}
	errBody, _ := protocol.DecodeErrorBody(body)
	if errBody.Code != protocol.ErrorTooLarge {
		t.Errorf("code = %v", errBody.Code)
	}
}

func TestVersionMismatchRefused(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	defer conn.Close()
	_ = protocol.WriteFrame(conn, protocol.TypeHelloC2H, protocol.EncodeHelloC2H(protocol.HelloC2H{Protocol: 99}))
	typ, body := readOne(t, conn, cfg)
	if typ != protocol.TypeError {
		t.Fatalf("expected ERROR, got %v", typ)
	}
	errBody, _ := protocol.DecodeErrorBody(body)
	if errBody.Code != protocol.ErrorVersion {
		t.Errorf("code = %v", errBody.Code)
	}
}

func TestSpawnValidationErrors(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { t.Fatal("should not spawn"); return nil, nil }
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	cases := []struct {
		name  string
		spawn protocol.Spawn
		code  protocol.ErrorCode
	}{
		{"cwd outside root", protocol.Spawn{Argv: []string{"true"}, Cwd: "/etc", Stdin: "null", Stdout: "null", Stderr: "null"}, protocol.ErrorCwd},
		{"relative executable", protocol.Spawn{Argv: []string{"./x"}, Cwd: root, Stdin: "null", Stdout: "null", Stderr: "null"}, protocol.ErrorExec},
		{"env outside allowlist", protocol.Spawn{Argv: []string{"true"}, Env: []protocol.EnvPair{{"LD_PRELOAD", "x"}}, Cwd: root, Stdin: "null", Stdout: "null", Stderr: "null"}, protocol.ErrorEnv},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conn := dial(t, socketPath)
			defer conn.Close()
			doHandshake(t, conn, cfg)
			sendSpawn(t, conn, tc.spawn)
			typ, body := readOne(t, conn, cfg)
			if typ != protocol.TypeError {
				t.Fatalf("expected ERROR, got %v", typ)
			}
			errBody, err := protocol.DecodeErrorBody(body)
			if err != nil || errBody.Code != tc.code {
				t.Errorf("error = %+v err=%v want %v", errBody, err, tc.code)
			}
		})
	}
}

func TestSpawnRateLimitedIsRate(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) {
		return nil, &launch.Error{Code: protocol.ErrorRate, Message: "spawn rate limit exceeded"}
	}
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	defer conn.Close()
	doHandshake(t, conn, cfg)
	sendSpawn(t, conn, basicSpawn(root))
	typ, body := readOne(t, conn, cfg)
	if typ != protocol.TypeError {
		t.Fatalf("expected ERROR, got %v", typ)
	}
	errBody, _ := protocol.DecodeErrorBody(body)
	if errBody.Code != protocol.ErrorRate {
		t.Errorf("code = %v", errBody.Code)
	}
}

func TestSpawnBusyWhenMaxProcesses(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) {
		return nil, &launch.Error{Code: protocol.ErrorBusy, Message: "too many live processes"}
	}
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	defer conn.Close()
	doHandshake(t, conn, cfg)
	sendSpawn(t, conn, basicSpawn(root))
	typ, body := readOne(t, conn, cfg)
	if typ != protocol.TypeError {
		t.Fatalf("expected ERROR, got %v", typ)
	}
	errBody, _ := protocol.DecodeErrorBody(body)
	if errBody.Code != protocol.ErrorBusy {
		t.Errorf("code = %v", errBody.Code)
	}
}

func TestConnectionLimitExcessRefused(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { return nil, nil }
	cfg := testConfig(t, uint32(os.Getuid()), root)
	cfg.MaxProcesses = 1 // max open connections = MaxProcesses + 8 = 9
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	var conns []*net.UnixConn
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	for i := 0; i < 9; i++ {
		conns = append(conns, dial(t, socketPath))
	}
	extra := dial(t, socketPath)
	defer extra.Close()
	typ, body := readOne(t, extra, cfg)
	if typ != protocol.TypeError {
		t.Fatalf("expected ERROR, got %v", typ)
	}
	errBody, _ := protocol.DecodeErrorBody(body)
	if errBody.Code != protocol.ErrorBusy {
		t.Errorf("code = %v", errBody.Code)
	}
}

func TestCreditEnforcedBothWays(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	proc, handles := newFakeProcess("p1", 1, true, true, false)
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { return proc, nil }
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	defer conn.Close()
	// Close the "child"'s stdin read end up front so every pumpStdin write fails immediately
	// (EPIPE): the helper never grants more stdin credit beyond the initial window, which makes
	// the boundary below deterministic regardless of goroutine scheduling (a draining reader
	// would race additional STDIN_CREDIT grants against the over-limit frame below).
	handles.toChildStdin.Close()
	doHandshake(t, conn, cfg)
	spawn := basicSpawn(root)
	spawn.Stdin, spawn.Stdout, spawn.Stderr = "pipe", "pipe", "null"
	sendSpawn(t, conn, spawn)
	typ, _ := readOne(t, conn, cfg)
	if typ != protocol.TypeSpawned {
		t.Fatalf("expected SPAWNED, got %v", typ)
	}
	// STDIN_CREDIT arrives next (the initial window).
	typ, body := readOne(t, conn, cfg)
	if typ != protocol.TypeStdinCredit {
		t.Fatalf("expected STDIN_CREDIT, got %v", typ)
	}
	credit, _ := protocol.DecodeStdinCredit(body)
	if credit != defaultStdinWindow {
		t.Errorf("initial stdin credit = %d", credit)
	}

	// Each STDIN frame is capped at protocol.DataFrameMax (64 KiB) by ReadFrame itself, so
	// exceeding the 256 KiB window takes several frames: four full frames exactly exhaust it
	// (consumed == granted is allowed — the read loop's check never depends on whether pumpStdin
	// has actually written them), and a fifth of any size must be refused.
	for i := 0; i < defaultStdinWindow/protocol.DataFrameMax; i++ {
		if err := protocol.WriteFrame(conn, protocol.TypeStdin, make([]byte, protocol.DataFrameMax)); err != nil {
			t.Fatalf("write stdin frame %d: %v", i, err)
		}
	}
	if err := protocol.WriteFrame(conn, protocol.TypeStdin, []byte("one more byte")); err != nil {
		t.Fatalf("write final stdin frame: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	{
		typ, body = readOne(t, conn, cfg)
		if typ != protocol.TypeError {
			t.Fatalf("expected ERROR for exceeding stdin credit, got %v", typ)
		}
	}
	errBody, err := protocol.DecodeErrorBody(body)
	if err != nil || errBody.Code != protocol.ErrorBadRequest {
		t.Errorf("error = %+v err=%v", errBody, err)
	}
}

func TestKillAndReleaseOnConnectionClose(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	proc, _ := newFakeProcess("p1", 1, false, false, false)
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { return proc, nil }
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := dial(t, socketPath)
	doHandshake(t, conn, cfg)
	sendSpawn(t, conn, basicSpawn(root))
	typ, _ := readOne(t, conn, cfg)
	if typ != protocol.TypeSpawned {
		t.Fatalf("expected SPAWNED, got %v", typ)
	}

	kill := protocol.Kill{Signal: "SIGTERM", Scope: "group"}
	_ = protocol.WriteFrame(conn, protocol.TypeKill, protocol.EncodeKill(kill))

	deadline := time.Now().Add(5 * time.Second)
	for {
		if len(fake.killCalls()) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for Kill")
		}
		time.Sleep(10 * time.Millisecond)
	}
	calls := fake.killCalls()
	if calls[0].signal != "SIGTERM" || calls[0].scope != "group" {
		t.Errorf("kill call = %+v", calls[0])
	}

	_ = conn.Close() // client crash / scope release before exit
	select {
	case id := <-fake.releaseCh:
		if id != "p1" {
			t.Errorf("released id = %q", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Release on connection close")
	}
}

// runToExit drives one spawn through to EXIT and both EOFs: the "child" writes to both streams,
// closes them and exits 0. It returns the client connection, still open, after waiting for Release.
func runToExit(t *testing.T, fake *fakeLauncher, socketPath string, cfg Config, root string, handles *fakeProcessHandles) *net.UnixConn {
	t.Helper()
	conn := dial(t, socketPath)
	doHandshake(t, conn, cfg)
	sendSpawn(t, conn, basicSpawn(root))
	if typ, _ := readOne(t, conn, cfg); typ != protocol.TypeSpawned {
		t.Fatalf("expected SPAWNED, got %v", typ)
	}
	_, _ = handles.fromChildStdout.WriteString("out\n")
	_ = handles.fromChildStdout.Close()
	_, _ = handles.fromChildStderr.WriteString("err\n")
	_ = handles.fromChildStderr.Close()
	_ = protocol.WriteFrame(conn, protocol.TypeCredit, protocol.EncodeCredit(protocol.StreamStdout, 4096))
	_ = protocol.WriteFrame(conn, protocol.TypeCredit, protocol.EncodeCredit(protocol.StreamStderr, 4096))
	code := 0
	handles.sendExit(launch.ExitResult{Code: &code})

	eofs, exited := 0, false
	for eofs < 2 || !exited {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		typ, _, err := protocol.ReadFrame(conn, limits(cfg))
		if err != nil {
			t.Fatalf("read before EXIT and both EOFs (eofs=%d exited=%v): %v", eofs, exited, err)
		}
		switch typ {
		case protocol.TypeEOF:
			eofs++
		case protocol.TypeExit:
			exited = true
		}
	}
	select {
	case <-fake.releaseCh:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for Release")
	}
	return conn
}

// The client keeps granting CREDIT while it reads the last frames, so its writes can land after
// the helper has sent everything. The helper must half-close and keep reading: a full close makes
// those writes fail with EPIPE, and Bun then drops the frames it hadn't read yet (the tail of the
// output and EXIT: a tool result without its last line and without an exit code).
func TestSessionHalfClosesAfterExit(t *testing.T) {
	root := t.TempDir()
	fake := newFakeLauncher()
	proc, handles := newFakeProcess("p1", 7, false, true, true)
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { return proc, nil }
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := runToExit(t, fake, socketPath, cfg, root, handles)
	defer conn.Close()
	time.Sleep(100 * time.Millisecond) // past the point where the helper used to close outright

	if err := protocol.WriteFrame(conn, protocol.TypeCredit, protocol.EncodeCredit(protocol.StreamStdout, 4)); err != nil {
		t.Fatalf("client CREDIT after the last frame failed (helper closed instead of half-closing): %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := protocol.ReadFrame(conn, limits(cfg)); !errors.Is(err, io.EOF) {
		t.Fatalf("after the last frame: want a clean EOF, got %v", err)
	}
}

// A client that never closes its side doesn't hold the connection open: the helper stops reading
// after closeLinger and closes.
func TestSessionClosesAfterLinger(t *testing.T) {
	old := closeLinger.Swap(int64(200 * time.Millisecond))
	defer closeLinger.Store(old)

	root := t.TempDir()
	fake := newFakeLauncher()
	proc, handles := newFakeProcess("p1", 8, false, true, true)
	fake.spawnFn = func(req launch.SpawnRequest) (*launch.Process, error) { return proc, nil }
	cfg := testConfig(t, uint32(os.Getuid()), root)
	socketPath, stop := startServer(t, fake, cfg)
	defer stop()

	conn := runToExit(t, fake, socketPath, cfg, root, handles)
	defer conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := protocol.WriteFrame(conn, protocol.TypeCredit, protocol.EncodeCredit(protocol.StreamStdout, 1)); err != nil {
			return // the helper closed its side fully
		}
		if time.Now().After(deadline) {
			t.Fatal("helper still reading 5s after the session ended")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
