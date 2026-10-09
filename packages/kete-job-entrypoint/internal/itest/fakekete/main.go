//go:build linux

// Command fakekete stands in for `kete job run --json <spec>` in the entrypoint's integration
// suite. It checks its identity and environment (the gateway key on fd 3, none in the environment), runs `id -un` through the real root helper (a minimal protocol v1
// client), edits README.md, writes an audit log to its audit pipe (fd 4, KETE_JOB_AUDIT_FD — never a
// file) and prints a result v1 — or, per the spec's prompt, misbehaves: "hang" (ignores SIGTERM,
// never finishes), "symlink", "fifo", "oversize", "audit-flood" (writes more than the entrypoint's
// 20,000,000-byte audit cap and expects EPIPE).
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func lookup(file, name string) (int, bool) {
	f, err := os.Open(file)
	if err != nil {
		return 0, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		p := strings.Split(sc.Text(), ":")
		if len(p) >= 3 && p[0] == name {
			n, err := strconv.Atoi(p[2])
			return n, err == nil
		}
	}
	return 0, false
}

func statusField(name string) string {
	b, _ := os.ReadFile("/proc/self/status")
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, name+":"); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// readKey reads the gateway key from fd 3 to EOF (at most 4096 bytes) and closes it, as kete does.
func readKey() ([]byte, error) {
	f := os.NewFile(3, "gateway-key")
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	if err == nil && len(b) > 4096 {
		err = errors.New("gateway key too long")
	}
	return b, err
}

func printableKey(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	for _, c := range b {
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}

func checks(cwd string) []string {
	var failed []string
	fail := func(name string) { failed = append(failed, name) }
	if uid, ok := lookup("/etc/passwd", "kete"); !ok || os.Getuid() != uid || os.Geteuid() != uid {
		fail("uid")
	}
	gid, _ := lookup("/etc/group", "kete-job")
	groups, _ := os.Getgroups()
	if len(groups) != 1 || groups[0] != gid {
		fail("groups")
	}
	if statusField("NoNewPrivs") != "1" {
		fail("nnp")
	}
	if statusField("CapEff") != "0000000000000000" {
		fail("caps")
	}
	if b, _ := os.ReadFile("/proc/self/oom_score_adj"); strings.TrimSpace(string(b)) != "0" {
		fail("oom")
	}
	want := map[string]string{
		"KETE_JOB_MODE": "1", "KETE_JOB_TOOL_SOCKET": "/run/kete-helper/helper.sock", "KETE_JOB_MAX_OUTPUT_TOKENS": "32000",
		"KETE_RUNTIME_TYPE": "kete_cloud", "HTTPS_PROXY": "http://127.0.0.1:81", "NODE_EXTRA_CA_CERTS": "/run/kete-egress/ca.pem",
		"KETE_PLATFORM_URL": "https://platform.kete.test", "KETE_GATEWAY_URL": "https://gateway.kete.test",
		"KETE_DISABLE_MODELS_FETCH": "1",
	}
	for k, v := range want {
		if os.Getenv(k) != v {
			fail("env:" + k)
		}
	}
	// The gateway key arrives on fd 3, never in the environment.
	if _, ok := os.LookupEnv("KETE_GATEWAY_KEY"); ok {
		fail("env-leak:KETE_GATEWAY_KEY")
	}
	if os.Getenv("KETE_JOB_GATEWAY_KEY_FD") != "3" {
		fail("env:KETE_JOB_GATEWAY_KEY_FD")
	} else if key, err := readKey(); err != nil || !printableKey(key) {
		fail("fd3:gateway-key")
	}
	// The audit sink: fd 4 is a pipe (append-only for kete: no seek, no truncate).
	if os.Getenv("KETE_JOB_AUDIT_FD") != "4" {
		fail("env:KETE_JOB_AUDIT_FD")
	} else {
		var st unix.Stat_t
		if err := unix.Fstat(4, &st); err != nil || st.Mode&unix.S_IFMT != unix.S_IFIFO {
			fail("fd4:fifo")
		}
		if _, err := unix.Seek(4, 0, io.SeekStart); !errors.Is(err, unix.ESPIPE) {
			fail("fd4:seek")
		}
		if err := unix.Ftruncate(4, 0); !errors.Is(err, unix.EINVAL) {
			fail("fd4:truncate")
		}
	}
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if strings.Contains(name, "CLAIM") || strings.Contains(name, "CALLBACK") || name == "HTTP_PROXY" || name == "NO_PROXY" || strings.HasPrefix(name, "GIT_CONFIG") {
			fail("env-leak:" + name)
		}
	}
	if cwd != "/srv/kete-job/work/repo" {
		fail("cwd")
	}
	if _, err := os.Stat(filepath.Join(cwd, ".git")); err != nil {
		fail("dotgit")
	}
	if _, err := os.ReadFile("/run/kete-egress/ca.pem"); err != nil {
		fail("ca")
	}
	// The root-only places stay closed to kete.
	for _, p := range []string{"/var/lib/kete-root", "/var/log/kete-job", "/run/kete-job"} {
		if _, err := os.ReadDir(p); err == nil {
			fail("readable:" + p)
		}
	}
	return failed
}

// --- a minimal protocol v1 client (kete-root-helper README "Protocol v1") ---

func writeFrame(c net.Conn, typ byte, body []byte) error {
	h := make([]byte, 5)
	binary.BigEndian.PutUint32(h, uint32(len(body)))
	h[4] = typ
	_, err := c.Write(append(h, body...))
	return err
}

func readFrame(c net.Conn) (byte, []byte, error) {
	h := make([]byte, 5)
	if _, err := io.ReadFull(c, h); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(h)
	if n > 1<<20 {
		return 0, nil, errors.New("frame too large")
	}
	b := make([]byte, n)
	_, err := io.ReadFull(c, b)
	return h[4], b, err
}

func spawn(socket, cwd string, argv []string) (string, error) {
	c, err := net.DialTimeout("unix", socket, 5*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	if err := writeFrame(c, 0x01, []byte(`{"protocol":1}`)); err != nil {
		return "", err
	}
	if t, _, err := readFrame(c); err != nil || t != 0x41 {
		return "", fmt.Errorf("hello: %x %v", t, err)
	}
	body, _ := json.Marshal(map[string]any{"argv": argv, "env": [][2]string{}, "cwd": cwd, "stdin": "null", "stdout": "pipe", "stderr": "null"})
	if err := writeFrame(c, 0x02, body); err != nil {
		return "", err
	}
	t, b, err := readFrame(c)
	if err != nil || t != 0x42 {
		return "", fmt.Errorf("spawn: %x %s %v", t, b, err)
	}
	credit := make([]byte, 5)
	credit[0] = 1
	binary.BigEndian.PutUint32(credit[1:], 1<<20)
	if err := writeFrame(c, 0x05, credit); err != nil {
		return "", err
	}
	var out []byte
	exited, eof := false, false
	for !(exited && eof) {
		t, b, err := readFrame(c)
		if err != nil {
			return "", err
		}
		switch t {
		case 0x43:
			out = append(out, b...)
		case 0x45:
			eof = true
		case 0x46:
			exited = true
		case 0x47:
			return "", fmt.Errorf("helper error: %s", b)
		}
	}
	return string(out), nil
}

// PlanText is what the orchestration-plan scenario writes as the plan file (the test proposes its
// digest to the fake platform first).
const PlanText = "{\"plan\":\"itest\"}\n"

func randomID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	b := make([]byte, 26)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return "ses_" + string(b)
}

func main() {
	if len(os.Args) != 5 || os.Args[1] != "job" || os.Args[2] != "run" || os.Args[3] != "--json" {
		fmt.Fprintln(os.Stderr, "fakekete: usage: kete job run --json <spec>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[4])
	if err != nil {
		fmt.Fprintln(os.Stderr, "fakekete: spec:", err)
		os.Exit(2)
	}
	var spec struct {
		Prompt string `json:"prompt"`
		Branch string `json:"branch"`
		Policy struct {
			Timeout int `json:"timeout"`
		} `json:"policy"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		os.Exit(2)
	}
	cwd, _ := os.Getwd()
	scenario := spec.Prompt

	if scenario == "hang" {
		signal.Ignore(syscall.SIGTERM)
		for {
			time.Sleep(time.Hour)
		}
	}

	failed := checks(cwd)
	user, err := spawn(os.Getenv("KETE_JOB_TOOL_SOCKET"), cwd, []string{"id", "-un"})
	if err != nil {
		failed = append(failed, "spawn")
	}
	user = strings.TrimSpace(user)
	if user != "kete-tool" {
		failed = append(failed, "tool-user")
	}
	// F3: the helper runs at oom_score_adj -1000; its tools must not inherit that.
	if oom, err := spawn(os.Getenv("KETE_JOB_TOOL_SOCKET"), cwd, []string{"cat", "/proc/self/oom_score_adj"}); err != nil || strings.TrimSpace(oom) != "0" {
		failed = append(failed, "tool-oom")
	}
	readme := filepath.Join(cwd, "README.md")
	old, _ := os.ReadFile(readme)
	if err := os.WriteFile(readme, append(old, []byte("edited by the fake kete\n")...), 0o644); err != nil {
		failed = append(failed, "edit")
	}
	// Orchestrated jobs (the entrypoint's O6): refs/kete/* in the working copy, a node merge with the
	// real git as the tool user, the pinned base, and a plan file in a coordinator's tree.
	orch := func(script, name string) {
		out, err := spawn(os.Getenv("KETE_JOB_TOOL_SOCKET"), cwd, []string{"/bin/sh", "-c", script + " && echo ORCH_OK"})
		if err != nil || !strings.Contains(out, "ORCH_OK") {
			failed = append(failed, name)
		}
	}
	switch {
	case strings.HasPrefix(scenario, "orchestration-worker:"):
		orch("git rev-parse --verify -q refs/kete/plan && git rev-parse --verify -q refs/kete/nodes/sdk-core && test -f sdk-core.txt", "orchestration-refs")
	case scenario == "orchestration-merge":
		orch("git -c user.name=t -c user.email=t@kete.test merge -q --no-edit refs/kete/nodes/sdk-core && test -f sdk-core.txt", "orchestration-merge")
	case scenario == "orchestration-base":
		orch("test ! -f moved.txt && test -f README.md", "orchestration-base")
	case scenario == "orchestration-plan":
		if err := os.MkdirAll(filepath.Join(cwd, ".kete-orchestration"), 0o775); err != nil {
			failed = append(failed, "plan-dir")
		} else if err := os.WriteFile(filepath.Join(cwd, ".kete-orchestration", "plan.json"), []byte(PlanText), 0o644); err != nil {
			failed = append(failed, "plan-file")
		}
	}
	switch scenario {
	case "stray":
		// ADR 0019 rule 5: a process kete starts itself stays in the kete user's cgroup; the
		// entrypoint's heartbeat must report it. Wait out a few heartbeats; the reap kills it.
		stray := exec.Command("/bin/sleep", "30")
		if err := stray.Start(); err != nil {
			failed = append(failed, "stray")
		}
		time.Sleep(3 * time.Second)
	case "symlink":
		_ = os.Symlink("/etc/passwd", filepath.Join(cwd, "evil"))
	case "fifo":
		_ = os.Remove(filepath.Join(cwd, "src", "app.txt"))
		_ = syscall.Mkfifo(filepath.Join(cwd, "src", "app.txt"), 0o644)
	case "oversize":
		_ = os.WriteFile(filepath.Join(cwd, "big.txt"), []byte(strings.Repeat("a", 2<<20)), 0o644)
	}

	sid := randomID()
	sink := os.NewFile(4, "audit")
	audit := `{"v":1,"type":"run","event":"started","session_id":"` + sid + `","root_id":"` + sid + `"}` + "\n" +
		`{"v":1,"type":"run","event":"ended","session_id":"` + sid + `","root_id":"` + sid + `","reason":"completed"}` + "\n"
	if _, err := sink.Write([]byte(audit)); err != nil {
		failed = append(failed, "audit")
	}
	flood := ""
	if scenario == "audit-flood" {
		// More than the entrypoint's cap: it stops reading and closes the pipe, so a write fails.
		line := []byte(`{"v":1,"type":"tool","session_id":"` + sid + `","excerpt":"` + strings.Repeat("x", 4000) + `"}` + "\n")
		total := 0
		for total < 30_000_000 {
			n, err := sink.Write(line)
			total += n
			if err != nil {
				flood = "epipe"
				if !errors.Is(err, syscall.EPIPE) {
					flood = "other:" + err.Error()
				}
				break
			}
		}
		if flood == "" {
			flood = "no-error"
		}
	}
	sink.Close()
	// Never a file in kete's data dir.
	if _, err := os.Stat(filepath.Join(os.Getenv("XDG_DATA_HOME"), "kete", "audit")); err == nil {
		failed = append(failed, "audit-file")
	}

	text := "tool user: " + user + "; timeout: " + strconv.Itoa(spec.Policy.Timeout) + "; checks: ok"
	outcome, code := "completed", 0
	if len(failed) > 0 {
		text = "checks failed: " + strings.Join(failed, ",")
		outcome, code = "error", 1
	} else if scenario == "audit-flood" {
		text = "audit-flood: " + flood
		outcome, code = "audit_failed", 2
	}
	res, _ := json.Marshal(map[string]any{
		"version": 1, "outcome": outcome, "exit_code": code, "session_id": sid, "text": text,
		"isolated": true, "branch": spec.Branch, "worktree": cwd, "directory": cwd, "denied": []any{},
	})
	fmt.Fprintln(os.Stderr, "fakekete: done")
	fmt.Println(string(res))
	os.Exit(code)
}
