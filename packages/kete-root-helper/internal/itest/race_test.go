//go:build integration && linux

package itest

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/sys/unix"
)

// TestRefuseCwdEscapesDuringConcurrentSymlinkSwap is AC2's race case. TestRefuseCwdEscapes (in
// scenarios_test.go) only checks a *static* symlink, created before any spawn — it races nothing.
//
// This test races the real window: the gap between the helper's early, non-authoritative
// root-side cwd pre-check and stage 2's authoritative openat2(RESOLVE_BENEATH) as the tool user.
// One goroutine continuously swaps what `race-swap` is, with renameat2(RENAME_EXCHANGE) — an
// atomic exchange of two names, never a moment where either is missing — between a REAL directory
// beneath the worktree root and a symlink to "/etc" (outside it). So a spawn can see a real
// directory at pre-check time and an escaping symlink by the time stage 2 resolves it. The helper
// refuses any symlinked cwd, so the legitimate outcome is a real directory (pwd prints a path
// beneath the root) and the escaping outcome must be a `cwd` refusal — never a pwd outside the root.
//
// The real directory only ever moves between two names that are both beneath the root, so even a
// process already chdir'd into it keeps a cwd beneath the root (getcwd reports the current name);
// that's why this is an exchange inside the worktree, not a move across the root boundary.
func TestRefuseCwdEscapesDuringConcurrentSymlinkSwap(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	swapPath := filepath.Join(e.worktreeRoot, "race-swap")
	otherPath := filepath.Join(e.worktreeRoot, "race-swap.other")
	for _, p := range []string{swapPath, otherPath} {
		_ = os.RemoveAll(p)
	}
	if err := os.Mkdir(swapPath, 0o755); err != nil {
		t.Fatalf("mkdir real dir: %v", err)
	}
	if err := os.Symlink("/etc", otherPath); err != nil {
		t.Fatalf("symlink to /etc: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(swapPath)
		_ = os.RemoveAll(otherPath)
	})

	stopSwap := make(chan struct{})
	swapDone := make(chan struct{})
	var swaps int64
	go func() {
		defer close(swapDone)
		for {
			select {
			case <-stopSwap:
				return
			default:
			}
			if err := unix.Renameat2(unix.AT_FDCWD, swapPath, unix.AT_FDCWD, otherPath, unix.RENAME_EXCHANGE); err != nil {
				t.Errorf("renameat2(RENAME_EXCHANGE): %v", err)
				return
			}
			atomic.AddInt64(&swaps, 1)
		}
	}()

	const iterations = 200
	var refused, ranBeneathRoot int
	for i := 0; i < iterations; i++ {
		res := runAsClient(t, e, clientRequest{
			Socket: socket, Argv: []string{"/bin/pwd", "-P"}, Env: [][2]string{{"PATH", "/usr/bin:/bin"}},
			Cwd: swapPath, Stdin: "null", Stdout: "pipe", Stderr: "pipe",
			ReadDeadline: 5000,
		})
		switch {
		case res.ErrorCode == "cwd":
			refused++
		case res.ErrorCode != "":
			close(stopSwap)
			<-swapDone
			t.Fatalf("iteration %d: unexpected refusal %q/%q (want cwd or success)", i, res.ErrorCode, res.ErrorMessage)
		default:
			if res.ExitCode == nil || *res.ExitCode != 0 {
				close(stopSwap)
				<-swapDone
				t.Fatalf("iteration %d: pwd exited abnormally: code=%v signal=%v stderr=%q", i, res.ExitCode, res.ExitSignal, res.Stderr)
			}
			got := strings.TrimSpace(string(res.Stdout))
			rel, err := filepath.Rel(e.worktreeRoot, got)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				close(stopSwap)
				<-swapDone
				t.Fatalf("SECURITY: iteration %d ran with cwd %q, outside the worktree root %q (rel=%q) — a spawn was not refused despite an out-of-root symlink target", i, got, e.worktreeRoot, rel)
			}
			ranBeneathRoot++
		}
	}
	close(stopSwap)
	<-swapDone

	total := atomic.LoadInt64(&swaps)
	t.Logf("race exercised: %d exchanges while spawning; of %d spawns, %d were refused (cwd) and %d ran beneath the worktree root",
		total, iterations, refused, ranBeneathRoot)
	if total < int64(iterations) {
		t.Errorf("only %d exchanges happened during %d spawns; the race window may not have been exercised much", total, iterations)
	}
	if refused == 0 {
		t.Fatalf("all %d spawns ran and none were refused: the swap goroutine never won the race against the client, so this run did not actually exercise the escaping side of the race window (rerun, or increase iterations)", iterations)
	}
	if ranBeneathRoot == 0 {
		t.Fatalf("all %d spawns were refused and none ran: the swap goroutine never lost the race, so this run did not actually exercise the legitimate side of the race window (rerun, or increase iterations)", iterations)
	}
}
