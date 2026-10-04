// Package server implements the helper's listener and per-connection protocol state machine
// (module README, protocol v1). Launcher is the seam: server_test.go runs the whole state machine
// against a fake Launcher over a real unix socket, without any cgroup or root privilege.
package server

import (
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/protocol"
	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/ratelimit"
)

// defaultStdinWindow / defaultOutputWindow are the flow-control windows advertised in HELLO
// h→c and used as the initial STDIN_CREDIT grant (module README "Protocol v1").
const (
	defaultStdinWindow  = 262144
	defaultOutputWindow = 262144
)

// Launcher is the seam between the protocol state machine and the OS. *launch.Launcher satisfies
// it directly; server_test.go uses a fake.
type Launcher interface {
	Spawn(req launch.SpawnRequest) (*launch.Process, error)
	Kill(proc *launch.Process, signal string, scope string) error
	Release(proc *launch.Process)
}

// Config is the per-connection configuration the listener hands to every session.
type Config struct {
	KeteUID      uint32
	MaxFrame     uint32
	MaxProcesses int
	WorktreeRoot string
	EnvAllow     []string
	EnvSet       map[string]string
	SpawnRate    float64
	SpawnBurst   int
}

// Listen sets up the helper's unix socket per the module README's start-up checks: the parent
// directory must exist, be root-owned and not group/other-writable, and not be a symlink; a stale
// socket file is unlinked; once bound, the socket is chowned to keteUID and chmod 0600 so only
// that uid can even connect (module README "Protocol v1": the tool uid can't reach it at all).
func Listen(socketPath string, keteUID uint32) (net.Listener, error) {
	dir := filepath.Dir(socketPath)
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, fmt.Errorf("--socket parent dir %q: %w", dir, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("--socket parent dir %q must not be a symlink", dir)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("--socket parent dir %q is not a directory", dir)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, fmt.Errorf("--socket parent dir %q: cannot read owner", dir)
	}
	if stat.Uid != 0 {
		return nil, fmt.Errorf("--socket parent dir %q must be root-owned", dir)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return nil, fmt.Errorf("--socket parent dir %q must not be group- or other-writable", dir)
	}

	if sockInfo, err := os.Lstat(socketPath); err == nil {
		if sockInfo.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("--socket %q exists and is not a socket", socketPath)
		}
		if err := os.Remove(socketPath); err != nil {
			return nil, fmt.Errorf("--socket %q: removing stale socket: %w", socketPath, err)
		}
	}

	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, err
	}
	if err := os.Chown(socketPath, int(keteUID), 0); err != nil {
		_ = ln.Close()
		return nil, err
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = ln.Close()
		return nil, err
	}
	return ln, nil
}

// Serve accepts connections until the listener closes, running each on its own goroutine.
// Connections beyond MaxProcesses+8 or beyond the accept rate limit are refused with ERROR busy /
// ERROR rate and closed immediately (module README "Limits").
func Serve(ln net.Listener, launcher Launcher, cfg Config, logger *log.Logger) error {
	if logger == nil {
		logger = log.New(os.Stderr, "", 0)
	}
	acceptBucket := ratelimit.New(cfg.SpawnRate, cfg.SpawnBurst, nil)
	maxConns := int64(cfg.MaxProcesses + 8)
	var active int64

	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		unixConn, ok := conn.(*net.UnixConn)
		if !ok {
			_ = conn.Close()
			continue
		}

		if !acceptBucket.Allow() {
			writeErrorAndClose(unixConn, cfg.MaxFrame, protocol.ErrorRate, "connection rate limit exceeded")
			continue
		}
		if atomic.AddInt64(&active, 1) > maxConns {
			atomic.AddInt64(&active, -1)
			writeErrorAndClose(unixConn, cfg.MaxFrame, protocol.ErrorBusy, "too many open connections")
			continue
		}

		go func() {
			defer atomic.AddInt64(&active, -1)
			handleConn(unixConn, launcher, cfg, logger)
		}()
	}
}

func peerUID(conn *net.UnixConn) (uint32, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}
	var ucred *unix.Ucred
	var gerr error
	if err := raw.Control(func(fd uintptr) {
		ucred, gerr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if gerr != nil {
		return 0, gerr
	}
	return ucred.Uid, nil
}

func writeErrorAndClose(conn *net.UnixConn, maxFrame uint32, code protocol.ErrorCode, message string) {
	_ = conn.SetWriteDeadline(time.Now().Add(protocol.SocketWriteDeadline))
	_ = protocol.WriteFrame(conn, protocol.TypeError, protocol.EncodeErrorBody(protocol.ErrorBody{Code: code, Message: message}))
	_ = conn.Close()
}
