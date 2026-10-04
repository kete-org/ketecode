//go:build linux

package launch

import (
	"syscall"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/protocol"
)

// TestSignalByNameOnlyAllowListedNamesSucceed pins the claim that Launcher.Kill's own
// `default: return 0, false` branch in signalByName (signals.go) is unreachable through the
// server's normal request flow: internal/server/conn_linux.go calls policy.ValidateSignal (which
// wraps protocol.ValidSignal, the exact same fixed set) before Kill is ever called, so a name
// outside this set never reaches signalByName from a real request — Kill's own bad_request return
// for the "not ok" case is defence in depth, not something a client can trigger. This test is the
// half of that claim that lives in this package: signalByName accepts precisely the names
// protocol.ValidSignal accepts, and rejects everything protocol.ValidSignal rejects too (checked
// against the live function, not a copy of the list, so the two can't silently drift apart).
func TestSignalByNameOnlyAllowListedNamesSucceed(t *testing.T) {
	allowed := []struct {
		name string
		want syscall.Signal
	}{
		{"SIGTERM", syscall.SIGTERM},
		{"SIGKILL", syscall.SIGKILL},
		{"SIGINT", syscall.SIGINT},
		{"SIGHUP", syscall.SIGHUP},
		{"SIGQUIT", syscall.SIGQUIT},
		{"SIGUSR1", syscall.SIGUSR1},
		{"SIGUSR2", syscall.SIGUSR2},
	}
	for _, c := range allowed {
		if !protocol.ValidSignal(c.name) {
			t.Fatalf("test fixture drifted from protocol.ValidSignal: %q no longer allow-listed", c.name)
		}
		got, ok := signalByName(c.name)
		if !ok || got != c.want {
			t.Errorf("signalByName(%q) = %v, %v; want %v, true", c.name, got, ok, c.want)
		}
	}

	// Every one of these must also be rejected by protocol.ValidSignal — otherwise this would only
	// be checking signalByName's own switch statement, not the claim that it and the allowlist
	// agree on everything Launcher.Kill can ever actually receive.
	rejected := []string{"", "SIGSEGV", "SIGPIPE", "SIGSTOP", "sigterm", "SIGTERM ", "TERM", "9"}
	for _, name := range rejected {
		if protocol.ValidSignal(name) {
			t.Fatalf("test fixture drifted: %q is unexpectedly allow-listed", name)
		}
		if _, ok := signalByName(name); ok {
			t.Errorf("signalByName(%q) = ok=true, want ok=false (not in protocol.ValidSignal)", name)
		}
	}
}

// TestSignalNameDefaultBranchIsReachable documents and pins the opposite fact for the *other*
// function in this file. Unlike signalByName above (gated by protocol.ValidSignal before any
// caller reaches it), signalName converts a spawned process's actual exit signal — wstatus.Signal()
// in reap(), launch_linux.go, reporting the real reason the tool process died — to a string for
// the EXIT protocol message. A process can die from any signal the kernel delivers (SIGSEGV,
// SIGPIPE, SIGBUS, SIGALRM, an external `kill -SEGV`, ...), not only the seven names a KILL
// request may name. So signalName's `default: return sig.String()` branch is reachable in normal
// operation — it is not dead code guarded by the same allowlist, and must keep producing a sane,
// non-empty string for signals outside it.
func TestSignalNameDefaultBranchIsReachable(t *testing.T) {
	for _, sig := range []syscall.Signal{syscall.SIGSEGV, syscall.SIGPIPE, syscall.SIGBUS, syscall.SIGALRM} {
		if got := signalName(sig); got == "" {
			t.Errorf("signalName(%v) returned an empty string", sig)
		}
	}
	for _, c := range []struct {
		sig  syscall.Signal
		want string
	}{
		{syscall.SIGTERM, "SIGTERM"},
		{syscall.SIGKILL, "SIGKILL"},
	} {
		if got := signalName(c.sig); got != c.want {
			t.Errorf("signalName(%v) = %q, want %q", c.sig, got, c.want)
		}
	}
}
