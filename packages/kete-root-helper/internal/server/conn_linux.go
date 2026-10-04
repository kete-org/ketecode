package server

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/policy"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/protocol"
)

// handleConn runs one connection end to end: peer credential check, HELLO, SPAWN, then the
// running session (module README "Protocol v1", "State machine").
func handleConn(conn *net.UnixConn, launcher Launcher, cfg Config, logger *log.Logger) {
	defer conn.Close()

	uid, err := peerUID(conn)
	if err != nil || uid != cfg.KeteUID {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorPeer, "peer uid did not match --kete-uid")
		return
	}

	limits := protocol.Limits{MaxFrame: cfg.MaxFrame}

	_ = conn.SetReadDeadline(time.Now().Add(protocol.HandshakeTimeout))
	typ, body, err := protocol.ReadFrame(conn, limits)
	if err != nil {
		reportReadError(conn, cfg.MaxFrame, err)
		return
	}
	if typ != protocol.TypeHelloC2H {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorBadRequest, "expected HELLO first")
		return
	}
	hello, err := protocol.DecodeHelloC2H(body)
	if err != nil {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorBadRequest, "malformed HELLO")
		return
	}
	if hello.Protocol != protocol.ProtocolVersion {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorVersion, fmt.Sprintf("unsupported protocol %d", hello.Protocol))
		return
	}

	envAllow := append([]string(nil), cfg.EnvAllow...)
	sort.Strings(envAllow)
	reply := protocol.HelloH2C{
		Protocol:     protocol.ProtocolVersion,
		MaxFrame:     cfg.MaxFrame,
		DataChunk:    protocol.DataFrameMax,
		StdinWindow:  defaultStdinWindow,
		OutputWindow: defaultOutputWindow,
		Env:          envAllow,
	}
	if err := writeFrameDeadlined(conn, protocol.TypeHelloH2C, protocol.EncodeHelloH2C(reply)); err != nil {
		return
	}

	_ = conn.SetReadDeadline(time.Now().Add(protocol.HandshakeTimeout))
	typ, body, err = protocol.ReadFrame(conn, limits)
	if err != nil {
		reportReadError(conn, cfg.MaxFrame, err)
		return
	}
	if typ != protocol.TypeSpawn {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorBadRequest, "expected SPAWN")
		return
	}
	spawnMsg, err := protocol.DecodeSpawn(body)
	if err != nil {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorBadRequest, "malformed SPAWN")
		return
	}

	if err := policy.ValidateArgv(spawnMsg.Argv); err != nil {
		sendValidationError(conn, cfg.MaxFrame, err)
		return
	}
	if err := policy.ValidateEnv(spawnMsg.Env, cfg.EnvAllow); err != nil {
		sendValidationError(conn, cfg.MaxFrame, err)
		return
	}
	if err := policy.ValidateCwd(spawnMsg.Cwd, cfg.WorktreeRoot); err != nil {
		sendValidationError(conn, cfg.MaxFrame, err)
		return
	}

	stdinMode, err := stdioModeOf(spawnMsg.Stdin)
	if err != nil {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorBadRequest, err.Error())
		return
	}
	stdoutMode, err := stdioModeOf(spawnMsg.Stdout)
	if err != nil {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorBadRequest, err.Error())
		return
	}
	stderrMode, err := stdioModeOf(spawnMsg.Stderr)
	if err != nil {
		writeErrorAndClose(conn, cfg.MaxFrame, protocol.ErrorBadRequest, err.Error())
		return
	}

	proc, err := launcher.Spawn(launch.SpawnRequest{
		Argv:   spawnMsg.Argv,
		Env:    mergeEnv(spawnMsg.Env, cfg.EnvSet),
		Cwd:    spawnMsg.Cwd,
		Stdin:  stdinMode,
		Stdout: stdoutMode,
		Stderr: stderrMode,
	})
	if err != nil {
		sendLaunchError(conn, cfg.MaxFrame, err)
		return
	}

	_ = conn.SetReadDeadline(time.Time{})
	s := &session{
		conn:       conn,
		launcher:   launcher,
		proc:       proc,
		maxFrame:   cfg.MaxFrame,
		logger:     logger,
		stdoutGate: newCreditGate(),
		stderrGate: newCreditGate(),
	}
	if stdinMode == launch.StdioPipe {
		s.stdinQueue = newStdinQueue()
	}

	if err := s.writeFrame(protocol.TypeSpawned, protocol.EncodeSpawned(protocol.Spawned{Pid: proc.Pid, ID: proc.ID})); err != nil {
		s.releaseProcess()
		return
	}

	s.run()
}

func stdioModeOf(value string) (launch.StdioMode, error) {
	switch value {
	case "pipe":
		return launch.StdioPipe, nil
	case "null":
		return launch.StdioNull, nil
	default:
		return 0, fmt.Errorf("stdio mode must be \"pipe\" or \"null\" (got %q)", value)
	}
}

func mergeEnv(requestEnv []protocol.EnvPair, envSet map[string]string) []string {
	merged := make(map[string]string, len(requestEnv)+len(envSet))
	for _, pair := range requestEnv {
		merged[pair[0]] = pair[1]
	}
	for name, value := range envSet {
		merged[name] = value // fixed values override the request's, D6
	}
	out := make([]string, 0, len(merged))
	for name, value := range merged {
		out = append(out, name+"="+value)
	}
	sort.Strings(out)
	return out
}

func reportReadError(conn *net.UnixConn, maxFrame uint32, err error) {
	if errors.Is(err, protocol.ErrTooLarge) {
		writeErrorAndClose(conn, maxFrame, protocol.ErrorTooLarge, "frame exceeds the limit")
		return
	}
	_ = conn.Close()
}

func sendValidationError(conn *net.UnixConn, maxFrame uint32, err error) {
	var ve *policy.ValidationError
	if errors.As(err, &ve) {
		writeErrorAndClose(conn, maxFrame, ve.Code, ve.Message)
		return
	}
	writeErrorAndClose(conn, maxFrame, protocol.ErrorBadRequest, err.Error())
}

func sendLaunchError(conn *net.UnixConn, maxFrame uint32, err error) {
	var le *launch.Error
	if errors.As(err, &le) {
		writeErrorAndClose(conn, maxFrame, le.Code, le.Message)
		return
	}
	writeErrorAndClose(conn, maxFrame, protocol.ErrorInternal, err.Error())
}

func writeFrameDeadlined(conn *net.UnixConn, t protocol.Type, body []byte) error {
	_ = conn.SetWriteDeadline(time.Now().Add(protocol.SocketWriteDeadline))
	return protocol.WriteFrame(conn, t, body)
}

// session runs the protocol state machine for one spawned process, after SPAWNED has been sent.
type session struct {
	conn     *net.UnixConn
	launcher Launcher
	proc     *launch.Process
	maxFrame uint32
	logger   *log.Logger

	writeMu sync.Mutex

	stdinMu       sync.Mutex
	stdinGranted  int64
	stdinConsumed int64
	stdinQueue    *stdinQueue

	stdoutGate *creditGate
	stderrGate *creditGate

	releaseOnce sync.Once
}

func (s *session) releaseProcess() {
	s.releaseOnce.Do(func() {
		s.launcher.Release(s.proc)
	})
}

func (s *session) writeFrame(t protocol.Type, body []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return writeFrameDeadlined(s.conn, t, body)
}

func (s *session) protocolError(code protocol.ErrorCode, message string) {
	_ = s.writeFrame(protocol.TypeError, protocol.EncodeErrorBody(protocol.ErrorBody{Code: code, Message: message}))
}

func (s *session) run() {
	defer s.conn.Close()
	defer s.releaseProcess()
	if s.stdinQueue != nil {
		defer s.stdinQueue.Abandon()
	}

	stdoutDone := make(chan struct{})
	stderrDone := make(chan struct{})
	if s.proc.Stdout != nil {
		go s.pumpOutput(protocol.StreamStdout, s.proc.Stdout, s.stdoutGate, stdoutDone)
	} else {
		close(stdoutDone)
	}
	if s.proc.Stderr != nil {
		go s.pumpOutput(protocol.StreamStderr, s.proc.Stderr, s.stderrGate, stderrDone)
	} else {
		close(stderrDone)
	}
	if s.proc.Stdin != nil {
		s.grantStdinCredit(defaultStdinWindow)
		go s.pumpStdin()
	}

	go func() {
		result := <-s.proc.ExitCh
		s.sendExit(result)
		<-stdoutDone
		<-stderrDone
		s.releaseProcess()
		s.finishWriting()
	}()

	s.readLoop()
}

// closeLinger bounds how long the helper keeps reading after it has sent everything (finishWriting).
// Atomic, not a const, so server_test.go can shorten it without racing live sessions.
var closeLinger atomic.Int64

func init() { closeLinger.Store(int64(5 * time.Second)) }

// finishWriting ends a session whose process has exited and whose output has all been sent: it
// half-closes the connection (the client reads EOF after the last frame) and leaves readLoop
// running until the client closes its side or closeLinger passes; run() then closes the socket.
//
// Never a plain Close here. The client keeps writing CREDIT as its consumer reads the last
// frames, so a CREDIT can still be in flight. Closing makes that write fail with EPIPE, and Bun
// (which runs kete) then drops whatever it hasn't read from the socket yet: the last STDOUT
// frames and EXIT. The tool result loses its tail and its exit code, which is what
// TestSessionHalfClosesAfterExit reproduces at the socket level.
func (s *session) finishWriting() {
	_ = s.conn.SetReadDeadline(time.Now().Add(time.Duration(closeLinger.Load())))
	s.writeMu.Lock()
	err := s.conn.CloseWrite()
	s.writeMu.Unlock()
	if err != nil {
		_ = s.conn.Close()
	}
}

func (s *session) sendExit(result launch.ExitResult) {
	_ = s.writeFrame(protocol.TypeExit, protocol.EncodeExit(protocol.Exit{Code: result.Code, Signal: result.Signal}))
}

func (s *session) readLoop() {
	limits := protocol.Limits{MaxFrame: s.maxFrame}
	for {
		typ, body, err := protocol.ReadFrame(s.conn, limits)
		if err != nil {
			if errors.Is(err, protocol.ErrTooLarge) {
				s.protocolError(protocol.ErrorTooLarge, "frame exceeds the limit")
			}
			return
		}
		switch typ {
		case protocol.TypeStdin:
			if !s.handleStdin(body) {
				return
			}
		case protocol.TypeStdinEnd:
			if s.stdinQueue != nil {
				s.stdinQueue.PushEnd()
			}
		case protocol.TypeCredit:
			if !s.handleCredit(body) {
				return
			}
		case protocol.TypeKill:
			if !s.handleKill(body) {
				return
			}
		default:
			s.protocolError(protocol.ErrorBadRequest, fmt.Sprintf("unexpected frame type 0x%02x", byte(typ)))
			return
		}
	}
}

func (s *session) handleStdin(body []byte) bool {
	if s.stdinQueue == nil {
		s.protocolError(protocol.ErrorBadRequest, "STDIN sent but stdin is not piped")
		return false
	}
	s.stdinMu.Lock()
	if s.stdinConsumed+int64(len(body)) > s.stdinGranted {
		s.stdinMu.Unlock()
		s.protocolError(protocol.ErrorBadRequest, "STDIN exceeds granted credit")
		return false
	}
	s.stdinConsumed += int64(len(body))
	s.stdinMu.Unlock()
	s.stdinQueue.Push(append([]byte(nil), body...))
	return true
}

func (s *session) handleCredit(body []byte) bool {
	stream, n, err := protocol.DecodeCredit(body)
	if err != nil || !protocol.ValidStream(stream) {
		s.protocolError(protocol.ErrorBadRequest, "malformed CREDIT")
		return false
	}
	gate := s.stdoutGate
	if stream == protocol.StreamStderr {
		gate = s.stderrGate
	}
	if !gate.Add(int64(n)) {
		s.protocolError(protocol.ErrorBadRequest, "outstanding credit exceeds the limit")
		return false
	}
	return true
}

func (s *session) handleKill(body []byte) bool {
	kill, err := protocol.DecodeKill(body)
	if err != nil {
		s.protocolError(protocol.ErrorBadRequest, "malformed KILL")
		return false
	}
	if err := policy.ValidateSignal(kill.Signal); err != nil {
		s.protocolError(protocol.ErrorBadRequest, err.Error())
		return false
	}
	if err := policy.ValidateKillScope(kill.Scope); err != nil {
		s.protocolError(protocol.ErrorBadRequest, err.Error())
		return false
	}
	if err := s.launcher.Kill(s.proc, kill.Signal, kill.Scope); err != nil && s.logger != nil {
		s.logger.Printf(`{"event":"kill_error","spawn":%q,"error":%q}`, s.proc.ID, err.Error())
	}
	return true
}

func (s *session) grantStdinCredit(n int64) {
	s.stdinMu.Lock()
	s.stdinGranted += n
	s.stdinMu.Unlock()
	_ = s.writeFrame(protocol.TypeStdinCredit, protocol.EncodeStdinCredit(uint32(n)))
}

func (s *session) pumpStdin() {
	for {
		chunk, end, ok := s.stdinQueue.Pop()
		if !ok {
			_ = s.proc.Stdin.Close()
			return
		}
		if chunk != nil {
			if _, err := s.proc.Stdin.Write(chunk); err != nil {
				_ = s.proc.Stdin.Close()
				return
			}
			s.grantStdinCredit(int64(len(chunk)))
		}
		if end {
			_ = s.proc.Stdin.Close()
			return
		}
	}
}

func (s *session) pumpOutput(stream uint8, reader io.ReadCloser, gate *creditGate, done chan<- struct{}) {
	defer close(done)
	defer reader.Close()
	frameType := protocol.TypeStdout
	if stream == protocol.StreamStderr {
		frameType = protocol.TypeStderr
	}
	buf := make([]byte, protocol.DataFrameMax)
	for {
		n, ok := gate.Take(int64(len(buf)))
		if !ok {
			return
		}
		read, err := reader.Read(buf[:n])
		if read > 0 {
			if werr := s.writeFrame(frameType, buf[:read]); werr != nil {
				return
			}
			if int64(read) < n {
				gate.Add(n - int64(read))
			}
		} else if int64(read) < n {
			gate.Add(n - int64(read))
		}
		if err != nil {
			_ = s.writeFrame(protocol.TypeEOF, protocol.EncodeEOF(stream))
			return
		}
	}
}

// creditGate tracks output credit granted by the client for one stream: pumpOutput only reads
// from the pipe while credit is available (module README "Flow control / backpressure").
type creditGate struct {
	mu        sync.Mutex
	cond      *sync.Cond
	available int64
	closed    bool
}

func newCreditGate() *creditGate {
	g := &creditGate{}
	g.cond = sync.NewCond(&g.mu)
	return g
}

// Add grants n more bytes of credit. It reports false (a protocol error) if the outstanding total
// would exceed protocol.MaxOutstandingCredit.
func (g *creditGate) Add(n int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.available+n > protocol.MaxOutstandingCredit {
		return false
	}
	g.available += n
	g.cond.Broadcast()
	return true
}

// Take blocks until credit is available, then consumes and returns up to max bytes of it. ok is
// false only once the gate has been closed with no credit left (session teardown).
func (g *creditGate) Take(max int64) (int64, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for g.available <= 0 && !g.closed {
		g.cond.Wait()
	}
	if g.available <= 0 {
		return 0, false
	}
	n := g.available
	if n > max {
		n = max
	}
	g.available -= n
	return n, true
}

func (g *creditGate) Close() {
	g.mu.Lock()
	g.closed = true
	g.cond.Broadcast()
	g.mu.Unlock()
}

// stdinQueue buffers STDIN chunks between the read loop (never blocks: append only) and
// pumpStdin, which may block on the child's pipe (module README "Flow control / backpressure":
// "the helper's socket reader never blocks on a pipe write").
type stdinQueue struct {
	mu        sync.Mutex
	cond      *sync.Cond
	items     [][]byte
	ended     bool
	abandoned bool
}

func newStdinQueue() *stdinQueue {
	q := &stdinQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *stdinQueue) Push(chunk []byte) {
	q.mu.Lock()
	q.items = append(q.items, chunk)
	q.cond.Broadcast()
	q.mu.Unlock()
}

func (q *stdinQueue) PushEnd() {
	q.mu.Lock()
	q.ended = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

func (q *stdinQueue) Abandon() {
	q.mu.Lock()
	q.abandoned = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

// Pop blocks until a chunk, STDIN_END, or abandonment is available. ok is false only once
// abandoned with nothing queued.
func (q *stdinQueue) Pop() (chunk []byte, end bool, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.ended && !q.abandoned {
		q.cond.Wait()
	}
	if len(q.items) > 0 {
		chunk = q.items[0]
		q.items = q.items[1:]
		return chunk, false, true
	}
	if q.ended {
		return nil, true, true
	}
	return nil, false, false
}
