//go:build integration && linux

package itest

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-root-helper/internal/cgroup"
)

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

// TestSpawnIdentity is AC1: identity, groups, NNP, cgroup, fds and cwd of a spawned process.
func TestSpawnIdentity(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	res := runAsClient(t, e, clientRequest{
		Socket: socket,
		Argv:   []string{e.testBin},
		Env:    [][2]string{{"PATH", "/usr/bin:/bin"}, {"KETE_IT_ROLE", "report"}},
		Cwd:    e.worktreeRoot,
		Stdin:  "null", Stdout: "pipe", Stderr: "pipe",
	})
	if res.ErrorCode != "" {
		t.Fatalf("spawn refused: %s: %s", res.ErrorCode, res.ErrorMessage)
	}
	if res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("report exited abnormally: code=%v signal=%v stderr=%q", res.ExitCode, res.ExitSignal, res.Stderr)
	}
	var rb reportBody
	if err := json.Unmarshal(bytes.TrimSpace(res.Stdout), &rb); err != nil {
		t.Fatalf("parse report JSON: %v; stdout=%q", err, res.Stdout)
	}

	if rb.UID != int(e.toolUID) || rb.EUID != int(e.toolUID) {
		t.Errorf("uid/euid = %d/%d, want %d", rb.UID, rb.EUID, e.toolUID)
	}
	if rb.GID != int(e.toolGID) || rb.EGID != int(e.toolGID) {
		t.Errorf("gid/egid = %d/%d, want %d", rb.GID, rb.EGID, e.toolGID)
	}
	if len(rb.Groups) != 0 {
		t.Errorf("groups = %v, want empty", rb.Groups)
	}
	if rb.NNP != "1" {
		t.Errorf("NoNewPrivs = %q, want \"1\"", rb.NNP)
	}
	if rb.CapEff != "0000000000000000" {
		t.Errorf("CapEff = %q, want all zero", rb.CapEff)
	}
	if rb.Cwd != e.worktreeRoot {
		t.Errorf("cwd = %q, want %q", rb.Cwd, e.worktreeRoot)
	}
	// fds 0-2 (the tool's stdio) must be present; any fd beyond that is only acceptable if it's
	// something the report program's own Go runtime opened after the exec (e.g. the netpoller's
	// epoll instance) — never a pipe or socket, which would mean a helper resource (the spec
	// pipe, status pipe, root fd, or client socket) leaked past close_range.
	fdSet := map[int]bool{}
	for _, fd := range rb.OpenFDs {
		fdSet[fd] = true
	}
	for _, want := range []int{0, 1, 2} {
		if !fdSet[want] {
			t.Errorf("fd %d missing; open fds = %v (%v)", want, rb.OpenFDs, rb.FDTargets)
		}
	}
	extra := len(rb.OpenFDs) - 3
	if extra < 0 {
		t.Errorf("fewer than 3 open fds: %v", rb.OpenFDs)
	}
	if extra > 3 {
		t.Errorf("too many extra open fds (%d beyond stdio): %v (%v)", extra, rb.OpenFDs, rb.FDTargets)
	}
	for _, target := range rb.FDTargets {
		// fds 0-2 are the tool's own requested stdio (here, stdout/stderr are legitimately
		// pipes back to the helper) — only fd >= 3 would indicate a leaked helper-internal
		// resource (the spec pipe, status pipe, root fd, or client socket).
		if strings.HasPrefix(target, "0=") || strings.HasPrefix(target, "1=") || strings.HasPrefix(target, "2=") {
			continue
		}
		if strings.Contains(target, "=pipe:") || strings.Contains(target, "=socket:") {
			t.Errorf("a helper resource (pipe or socket) survived into the tool: %s (all: %v)", target, rb.FDTargets)
		}
	}
	if !strings.Contains(rb.Cgroup, filepath.Base(e.toolCgroup)) {
		t.Errorf("cgroup = %q, want it to contain the tool cgroup %q", rb.Cgroup, e.toolCgroup)
	}
}

// TestHelperReexecsForNoNewPrivs is D9: the helper self-re-execs at start-up if NNP wasn't
// already set, and the running process ends up with it set.
func TestHelperReexecsForNoNewPrivs(t *testing.T) {
	e := loadEnv(t)
	_, pid, stop := startHelperWithPid(t, e)
	defer stop()

	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		t.Fatalf("read /proc/%d/status: %v", pid, err)
	}
	if !strings.Contains(string(data), "NoNewPrivs:\t1") {
		t.Errorf("helper process status does not show NoNewPrivs: 1:\n%s", data)
	}
}

// TestRefusePeerNotKeteUID is part of AC2. The socket file is 0600 owned by the kete uid, so a
// third (non-root) uid is refused by the OS at connect(2) itself (EACCES) — it never reaches the
// protocol layer. Root bypasses that file-permission check (CAP_DAC_OVERRIDE) and does connect,
// but the server's own SO_PEERCRED check then refuses it with ERROR peer.
func TestRefusePeerNotKeteUID(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	t.Run("third uid (blocked at connect)", func(t *testing.T) {
		res := runAsUID(t, e, e.thirdUID, e.thirdGID, clientRequest{
			Socket: socket, Argv: []string{"true"}, Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
		})
		if res.ErrorCode != "connect" {
			t.Errorf("error = %q/%q, want connect (EACCES)", res.ErrorCode, res.ErrorMessage)
		}
	})

	t.Run("root (blocked by SO_PEERCRED)", func(t *testing.T) {
		res := runAsUID(t, e, 0, 0, clientRequest{
			Socket: socket, Argv: []string{"true"}, Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
		})
		if res.ErrorCode != "peer" {
			t.Errorf("error = %q/%q, want peer", res.ErrorCode, res.ErrorMessage)
		}
	})
}

// TestToolUIDCannotConnect is part of AC2: the socket is 0600 owned by the kete uid, so the tool
// user's connect(2) itself fails (EACCES), never reaching the protocol layer.
func TestToolUIDCannotConnect(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	res := runAsUID(t, e, e.toolUID, e.toolGID, clientRequest{
		Socket: socket, Argv: []string{"true"}, Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
	})
	if res.ErrorCode != "connect" {
		t.Errorf("error = %q/%q, want connect (EACCES)", res.ErrorCode, res.ErrorMessage)
	}
}

// TestRefuseCwdEscapes is AC2's cwd checks: "..", an absolute path outside the root, and a
// symlink that escapes are all refused with cwd.
func TestRefuseCwdEscapes(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	evilLink := filepath.Join(e.worktreeRoot, "evil-link")
	_ = os.Remove(evilLink)
	if err := os.Symlink("/etc", evilLink); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	defer os.Remove(evilLink)

	cases := map[string]string{
		"dotdot":              e.worktreeRoot + "/../etc",
		"absolute outside":    "/etc",
		"symlink escape":      evilLink,
		"not lexically clean": e.worktreeRoot + "/./sub/..",
	}
	for name, cwd := range cases {
		t.Run(name, func(t *testing.T) {
			res := runAsClient(t, e, clientRequest{
				Socket: socket, Argv: []string{"true"}, Cwd: cwd, Stdin: "null", Stdout: "null", Stderr: "null",
			})
			if res.ErrorCode != "cwd" {
				t.Errorf("cwd=%q error = %q/%q, want cwd", cwd, res.ErrorCode, res.ErrorMessage)
			}
		})
	}
}

// TestRefuseRelativeExecutable is AC2: "./x" and "bin/x" are refused; a bare name is not.
func TestRefuseRelativeExecutable(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	for _, argv0 := range []string{"./x", "bin/x", "../x"} {
		t.Run(argv0, func(t *testing.T) {
			res := runAsClient(t, e, clientRequest{
				Socket: socket, Argv: []string{argv0}, Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
			})
			if res.ErrorCode != "exec" {
				t.Errorf("argv0=%q error = %q/%q, want exec", argv0, res.ErrorCode, res.ErrorMessage)
			}
		})
	}
}

// TestBareCommandNameResolvesOnPath: "true" is found on the tool user's PATH by stage 2.
func TestBareCommandNameResolvesOnPath(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	res := runAsClient(t, e, clientRequest{
		Socket: socket, Argv: []string{"true"}, Env: [][2]string{{"PATH", "/usr/bin:/bin"}},
		Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
	})
	if res.ErrorCode != "" {
		t.Fatalf("refused: %s: %s", res.ErrorCode, res.ErrorMessage)
	}
	if res.ExitCode == nil || *res.ExitCode != 0 {
		t.Errorf("exit = %v/%v, want 0", res.ExitCode, res.ExitSignal)
	}
}

// TestRefuseEnvOutsideAllowlist is AC2.
func TestRefuseEnvOutsideAllowlist(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	res := runAsClient(t, e, clientRequest{
		Socket: socket, Argv: []string{"true"}, Env: [][2]string{{"LD_PRELOAD", "/evil.so"}},
		Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
	})
	if res.ErrorCode != "env" {
		t.Errorf("error = %q/%q, want env", res.ErrorCode, res.ErrorMessage)
	}
}

// TestStdinStdoutBinaryRoundTrip is AC3: binary-safe stdin/stdout round trip through `cat`.
func TestStdinStdoutBinaryRoundTrip(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	data := make([]byte, 200*1024)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("rand: %v", err)
	}
	res := runAsClient(t, e, clientRequest{
		Socket: socket, Argv: []string{"/bin/cat"}, Env: [][2]string{{"PATH", "/usr/bin:/bin"}},
		Cwd: e.worktreeRoot, Stdin: "pipe", Stdout: "pipe", Stderr: "null",
		StdinData: data, ReadDeadline: 15000,
	})
	if res.ErrorCode != "" {
		t.Fatalf("refused: %s: %s", res.ErrorCode, res.ErrorMessage)
	}
	if res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("exit = %v/%v", res.ExitCode, res.ExitSignal)
	}
	got := sha256.Sum256(res.Stdout)
	want := sha256.Sum256(data)
	if got != want {
		t.Errorf("stdout does not match stdin: got %d bytes, want %d bytes", len(res.Stdout), len(data))
	}
}

// TestExitCodeReported is AC3.
func TestExitCodeReported(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	res := runAsClient(t, e, clientRequest{
		Socket: socket, Argv: []string{"/bin/sh", "-c", "exit 3"}, Env: [][2]string{{"PATH", "/usr/bin:/bin"}},
		Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
	})
	if res.ErrorCode != "" {
		t.Fatalf("refused: %s: %s", res.ErrorCode, res.ErrorMessage)
	}
	if res.ExitCode == nil || *res.ExitCode != 3 {
		t.Errorf("exit code = %v, want 3", res.ExitCode)
	}
}

// TestSignalTermination is AC3: a KILL request terminates the process, reported as a signal.
func TestSignalTermination(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	res := runAsClient(t, e, clientRequest{
		Socket: socket, Argv: []string{"/bin/sleep", "30"}, Env: [][2]string{{"PATH", "/usr/bin:/bin"}},
		Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
		KillAfterMS: 300, KillSignal: "SIGTERM", KillScope: "process",
		ReadDeadline: 10000,
	})
	if res.ErrorCode != "" {
		t.Fatalf("refused: %s: %s", res.ErrorCode, res.ErrorMessage)
	}
	if res.ExitSignal == nil || *res.ExitSignal != "SIGTERM" {
		t.Errorf("exit = code=%v signal=%v, want signal SIGTERM", res.ExitCode, res.ExitSignal)
	}
}

// TestKillGroupKillsBackgroundedGrandchild is AC3: a `sh -c 'sleep N & wait'` backgrounded
// grandchild is gone from the leaf after a group kill, not just the leader.
func TestKillGroupKillsBackgroundedGrandchild(t *testing.T) {
	e := loadEnv(t)
	socket, stop := startHelper(t, e)
	defer stop()

	req := clientRequest{
		Socket: socket, Argv: []string{"/bin/sh", "-c", "sleep 100 & wait"}, Env: [][2]string{{"PATH", "/usr/bin:/bin"}},
		Cwd: e.worktreeRoot, Stdin: "null", Stdout: "null", Stderr: "null",
		KillAfterMS: 500, KillSignal: "SIGKILL", KillScope: "group",
		ReadDeadline: 10000,
	}
	// clientResult doesn't carry the spawn id, so rather than track it, poll every leaf under the
	// tool cgroup after the group kill and require all of them empty — proving the backgrounded
	// grandchild is gone too, not just the leader (module README "Kill": a "process"-scope kill
	// would leave it running).
	res := runAsClient(t, e, req)
	if res.ErrorCode != "" {
		t.Fatalf("refused: %s: %s", res.ErrorCode, res.ErrorMessage)
	}
	if res.ExitSignal == nil {
		t.Fatalf("exit = code=%v signal=%v, want a signal (the leader was killed)", res.ExitCode, res.ExitSignal)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		entries, err := os.ReadDir(e.toolCgroup)
		if err != nil {
			t.Fatalf("read tool cgroup: %v", err)
		}
		populated := false
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			leaf := filepath.Join(e.toolCgroup, entry.Name())
			if p, err := cgroup.Populated(leaf); err == nil && p {
				populated = true
			}
		}
		if !populated {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a leaf remained populated after group kill (the backgrounded grandchild survived)")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestToolCgroupWithoutBoundedLimitsRefusesStartup: --tool-cgroup with pids.max still "max" makes
// the helper refuse to start.
func TestToolCgroupWithoutBoundedLimitsRefusesStartup(t *testing.T) {
	e := loadEnv(t)
	unboundedDir := filepath.Join(filepath.Dir(e.toolCgroup), "unbounded-test")
	if err := os.Mkdir(unboundedDir, 0o700); err != nil && !os.IsExist(err) {
		t.Fatalf("mkdir: %v", err)
	}
	defer os.Remove(unboundedDir)

	socket := filepath.Join(e.socketDir, "unbounded.sock")
	args := []string{
		"--socket", socket,
		"--kete-uid", strconv.FormatUint(uint64(e.keteUID), 10),
		"--tool-uid", strconv.FormatUint(uint64(e.toolUID), 10),
		"--tool-gid", strconv.FormatUint(uint64(e.toolGID), 10),
		"--worktree-root", e.worktreeRoot,
		"--tool-cgroup", unboundedDir,
	}
	cmd := exec.Command(e.helperBin, args...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected the helper to refuse to start; output: %s", out)
	}
}

// TestOomScoreReset: the entrypoint runs the helper at oom_score_adj -1000, which every child
// inherits; stage 2 resets it to 0 so no tool is immune to the OOM killer (its cgroup's
// memory.max included).
func TestOomScoreReset(t *testing.T) {
	e := loadEnv(t)
	socket, pid, stop := startHelperWithPid(t, e)
	defer stop()
	if err := os.WriteFile(fmt.Sprintf("/proc/%d/oom_score_adj", pid), []byte("-1000"), 0o644); err != nil {
		t.Fatalf("set helper oom_score_adj: %v", err)
	}
	got, err := os.ReadFile(fmt.Sprintf("/proc/%d/oom_score_adj", pid))
	if err != nil || strings.TrimSpace(string(got)) != "-1000" {
		t.Fatalf("helper oom_score_adj = %q (err %v), want -1000", got, err)
	}

	res := runAsClient(t, e, clientRequest{
		Socket: socket, Argv: []string{"/bin/cat", "/proc/self/oom_score_adj"},
		Env: [][2]string{{"PATH", "/usr/bin:/bin"}},
		Cwd: e.worktreeRoot, Stdin: "null", Stdout: "pipe", Stderr: "pipe",
	})
	if res.ErrorCode != "" {
		t.Fatalf("spawn refused: %s: %s", res.ErrorCode, res.ErrorMessage)
	}
	if res.ExitCode == nil || *res.ExitCode != 0 {
		t.Fatalf("cat exited abnormally: code=%v signal=%v stderr=%q", res.ExitCode, res.ExitSignal, res.Stderr)
	}
	if strings.TrimSpace(string(res.Stdout)) != "0" {
		t.Errorf("tool oom_score_adj = %q, want 0", res.Stdout)
	}
}

// TestStaleLeafDoesNotBlockSpawn: leaf cgroups a previous helper left behind (their rmdir can lag
// the last process's exit) must never collide with a new helper's spawns — leaf names are unique
// per helper process. Before this, every helper named its first leaf "p1", so a stale "p1" made
// the next helper refuse its first spawn with "create leaf: … file exists" (seen on CI).
func TestStaleLeafDoesNotBlockSpawn(t *testing.T) {
	e := loadEnv(t)
	stale := []string{"p1", "p2", fmt.Sprintf("p%d-1", os.Getpid())}
	for _, name := range stale {
		dir := filepath.Join(e.toolCgroup, name)
		if err := os.Mkdir(dir, 0o700); err != nil && !os.IsExist(err) {
			t.Fatalf("create stale leaf %s: %v", name, err)
		}
		t.Cleanup(func() { _ = os.Remove(dir) })
	}

	socket, stop := startHelper(t, e)
	defer stop()
	for i := 0; i < 3; i++ {
		res := runAsClient(t, e, clientRequest{
			Socket: socket, Argv: []string{"/bin/true"},
			Env: [][2]string{{"PATH", "/usr/bin:/bin"}},
			Cwd: e.worktreeRoot, Stdin: "null", Stdout: "pipe", Stderr: "pipe",
		})
		if res.ErrorCode != "" {
			t.Fatalf("spawn %d refused with stale leaves present: %s: %s", i, res.ErrorCode, res.ErrorMessage)
		}
	}
}
