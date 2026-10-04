//go:build linux

package launch

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// specMaxSize bounds the JSON spec stage 1 writes to fd 3: argv (≤4096 entries) and env (≤1024
// entries) are already bounded by internal/policy before a request reaches here, so this is a
// generous ceiling, not a real limit on legitimate requests.
const specMaxSize = 4 * 1024 * 1024

// The fixed fd numbers stage 1's ForkExec assigns (module README "Spawn sequence", step 6): 0-2
// are the tool's stdio, 3 is the spec pipe read end, 4 is the O_PATH worktree-root fd, 5 is the
// status pipe write end.
const (
	specFD   = 3
	rootFD   = 4
	statusFD = 5
)

// stage2Spec is what stage 1 writes to fd 3: uid/gid always come from the helper's own Config,
// never from the client's request.
type stage2Spec struct {
	Argv []string `json:"argv"`
	Env  []string `json:"env"`
	Rel  string   `json:"rel"`
	UID  uint32   `json:"uid"`
	GID  uint32   `json:"gid"`
}

// stage2Status is what stage 2 writes to fd 5 on any failure before the final execve. Never argv
// or env values (module README "Logging").
type stage2Status struct {
	Code  string `json:"code"`
	Errno int    `json:"errno,omitempty"`
}

// RunStage2 is entered from main() when os.Args[1] == "__exec": the short-lived, still-root child
// that drops privilege and execve's the tool (module README "Spawn sequence", stage 2). It never
// returns — every path ends in os.Exit, syscall.Exec, or (on success) the replaced process image.
func RunStage2() {
	runtime.LockOSThread() // the final execve and PR_SET_NO_NEW_PRIVS run on this thread only.

	fail := func(code string, cause error) {
		status := stage2Status{Code: code}
		if errno, ok := cause.(syscall.Errno); ok {
			status.Errno = int(errno)
		}
		if body, err := json.Marshal(status); err == nil {
			_, _ = unix.Write(statusFD, body)
		}
		os.Exit(126)
	}

	specFile := os.NewFile(uintptr(specFD), "spec")
	raw, err := io.ReadAll(io.LimitReader(specFile, specMaxSize+1))
	if err != nil {
		fail("internal", err)
	}
	if len(raw) > specMaxSize {
		fail("internal", fmt.Errorf("spec exceeds %d bytes", specMaxSize))
	}
	_ = specFile.Close()

	var spec stage2Spec
	if err := json.Unmarshal(raw, &spec); err != nil {
		fail("internal", err)
	}
	if len(spec.Argv) == 0 {
		fail("internal", fmt.Errorf("empty argv in spec"))
	}

	unix.CloseOnExec(statusFD)

	// The helper runs at oom_score_adj -1000 (the entrypoint protects it from the OOM killer) and
	// every child inherits that value, which would make every tool immune to OOM kills, including
	// its own cgroup's memory.max OOM. Reset it to 0 while still root (raising it needs no
	// privilege, but doing it before the drop keeps the order simple), and verify it.
	if err := resetOOMScore(); err != nil {
		fail("identity", err)
	}

	if err := syscall.Setgroups([]int{}); err != nil {
		fail("identity", err)
	}
	if err := syscall.Setgid(int(spec.GID)); err != nil {
		fail("identity", err)
	}
	if err := syscall.Setuid(int(spec.UID)); err != nil {
		fail("identity", err)
	}
	if ruid, euid, suid := unix.Getresuid(); ruid != int(spec.UID) || euid != int(spec.UID) || suid != int(spec.UID) {
		fail("identity", fmt.Errorf("uid drop verification failed: r=%d e=%d s=%d", ruid, euid, suid))
	}
	if rgid, egid, sgid := unix.Getresgid(); rgid != int(spec.GID) || egid != int(spec.GID) || sgid != int(spec.GID) {
		fail("identity", fmt.Errorf("gid drop verification failed: r=%d e=%d s=%d", rgid, egid, sgid))
	}
	if groups, err := syscall.Getgroups(); err != nil || len(groups) != 0 {
		fail("identity", fmt.Errorf("supplementary groups not empty: %v (err %v)", groups, err))
	}

	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		fail("nnp", err)
	}
	if got, err := unix.PrctlRetInt(unix.PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0); err != nil || got != 1 {
		fail("nnp", fmt.Errorf("PR_GET_NO_NEW_PRIVS = %d (err %v)", got, err))
	}

	// Authoritative cwd check, as the tool user: resolve `rel` beneath the root fd at this exact
	// moment, with the tool user's permissions. The kernel refuses any escape (EXDEV); this is
	// the security check — the helper-side pre-check (launch_linux.go) was only a friendly error.
	how := unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_MAGICLINKS,
	}
	dirFD, err := unix.Openat2(rootFD, spec.Rel, &how)
	if err != nil {
		fail("cwd", err)
	}
	if err := unix.Fchdir(dirFD); err != nil {
		_ = unix.Close(dirFD)
		fail("cwd", err)
	}
	_ = unix.Close(dirFD)
	_ = unix.Close(rootFD)
	_ = unix.Close(specFD)

	path, err := resolveExecutable(spec.Argv[0], spec.Env)
	if err != nil {
		fail("not_found", err)
	}

	// Every fd ≥ 3 (including fd 5, already CLOEXEC above, and any Go runtime fd that survived
	// the self-exec) closes at the upcoming execve; only 0-2 (the tool's stdio) remain.
	if err := unix.CloseRange(3, ^uint(0), unix.CLOSE_RANGE_CLOEXEC); err != nil {
		fail("internal", err)
	}

	if err := syscall.Exec(path, spec.Argv, spec.Env); err != nil {
		fail("exec", err)
	}
	// unreachable: syscall.Exec only returns on error.
}

// resetOOMScore writes 0 to /proc/self/oom_score_adj and reads it back.
func resetOOMScore() error {
	fd, err := unix.Open("/proc/self/oom_score_adj", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if _, err := unix.Write(fd, []byte("0")); err != nil {
		return err
	}
	buf := make([]byte, 16)
	n, err := unix.Pread(fd, buf, 0)
	if err != nil {
		return err
	}
	if got := strings.TrimSpace(string(buf[:n])); got != "0" {
		return fmt.Errorf("oom_score_adj reads back %q, want 0", got)
	}
	return nil
}

// resolveExecutable resolves argv[0]. An absolute path is used as is (internal/policy already
// refused a relative path containing "/"); a bare name is looked up on the final env's PATH, as
// the tool user, never as root (D5) — absolute PATH entries only, skipping relative or empty
// entries, and the first candidate that is a regular file with an execute bit for the tool user.
//
// Access/Stat/Exec below is a classic TOCTOU shape (the file checked here need not be the file
// syscall.Exec below ends up running), but by the time this function runs, the caller (RunStage2)
// has already done Setuid/Setgid to the tool identity and verified the drop — every syscall in
// this function, and the eventual Exec, already runs with only the tool user's own privileges, on
// a path the earlier authoritative openat2(RESOLVE_BENEATH) check has confirmed is beneath the
// worktree root. So a race here lets the tool user swap in a different file it can already reach
// with its own permissions — it cannot cross the privilege boundary this helper exists to
// enforce, unlike the cwd check above, which runs the authoritative resolution atomically for
// exactly that reason.
func resolveExecutable(name string, env []string) (string, error) {
	if strings.HasPrefix(name, "/") {
		return name, nil
	}
	pathValue := ""
	for _, kv := range env {
		if rest, ok := strings.CutPrefix(kv, "PATH="); ok {
			pathValue = rest
			break
		}
	}
	for _, dir := range strings.Split(pathValue, ":") {
		if !strings.HasPrefix(dir, "/") {
			continue
		}
		candidate := dir + "/" + name
		if unix.Access(candidate, unix.X_OK) != nil {
			continue
		}
		var st unix.Stat_t
		if unix.Stat(candidate, &st) != nil {
			continue
		}
		if st.Mode&unix.S_IFMT != unix.S_IFREG {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("%q not found on PATH", name)
}
