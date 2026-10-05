// Package gitops runs every git command root runs (step 4 and the bundle's listing), always with
// an environment built from scratch (module README "Hardened git"): no system or global config,
// no hooks, no fsmonitor, no replace objects, no LFS smudge, https only (plus file:// for the local
// agent copy), through the proxy's port R with only the proxy's CA. Nothing is inherited, so no
// GIT_TRACE* or other variable can leak in. stderr is scrubbed of the clone token and any
// Authorization line before it reaches a message.
package gitops

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Runner runs git.
type Runner struct {
	Git          string
	Home         string // root's git HOME
	ProxyURL     string // http://127.0.0.1:<port R>
	CAPath       string // /run/kete-egress/ca.pem
	Timeout      time.Duration
	CloneTimeout time.Duration
	MaxStdout    int64
	MaxStderr    int64
}

// Call is one git invocation.
type Call struct {
	Dir       string
	Args      []string
	Config    [][2]string // extra GIT_CONFIG_* pairs
	IndexFile string      // GIT_INDEX_FILE, only when set
	Timeout   time.Duration
}

// BaseConfig is set on every call.
func (r Runner) BaseConfig() [][2]string {
	return [][2]string{
		{"core.hooksPath", "/dev/null"},
		{"core.fsmonitor", "false"},
		{"core.untrackedCache", "false"},
		{"core.quotePath", "false"},
		{"protocol.allow", "never"},
		{"protocol.https.allow", "always"},
		{"submodule.recurse", "false"},
		{"http.proxy", r.ProxyURL},
		{"http.sslCAInfo", r.CAPath},
	}
}

// Env builds the complete environment of a call.
func (r Runner) Env(c Call) []string {
	env := []string{
		"PATH=/usr/bin:/bin",
		"HOME=" + r.Home,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_ATTR_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_NO_REPLACE_OBJECTS=1",
		"GIT_LFS_SKIP_SMUDGE=1",
		"GIT_PROTOCOL_FROM_USER=0",
		"LC_ALL=C",
	}
	if c.IndexFile != "" {
		env = append(env, "GIT_INDEX_FILE="+c.IndexFile)
	}
	cfg := append(r.BaseConfig(), c.Config...)
	env = append(env, "GIT_CONFIG_COUNT="+strconv.Itoa(len(cfg)))
	for i, kv := range cfg {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, kv[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, kv[1]))
	}
	return env
}

// capWriter keeps at most max bytes and remembers an overflow.
type capWriter struct {
	buf      bytes.Buffer
	max      int64
	overflow bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	room := w.max - int64(w.buf.Len())
	if int64(len(p)) > room {
		w.overflow = true
		if room > 0 {
			w.buf.Write(p[:room])
		}
		return len(p), nil
	}
	w.buf.Write(p)
	return len(p), nil
}

// Error is a failed git call; Stderr is raw (scrub before use).
type Error struct {
	ExitCode int
	Stderr   []byte
	Cause    error
}

func (e *Error) Error() string { return fmt.Sprintf("git exited %d", e.ExitCode) }

// ErrorClass is the fixed phase-log class ("git", the exit code).
func (e *Error) ErrorClass() (string, int) { return "git", e.ExitCode }

// ErrOutputTooLarge is a call whose stdout passed the cap.
var ErrOutputTooLarge = errors.New("git: output too large")

// Run runs one call and returns its stdout.
func (r Runner) Run(ctx context.Context, c Call) ([]byte, error) {
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = r.Timeout
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, r.Git, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = r.Env(c)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
	cmd.WaitDelay = 5 * time.Second
	stdout := &capWriter{max: r.MaxStdout}
	stderr := &capWriter{max: r.MaxStderr}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err := cmd.Run()
	if err != nil {
		code := -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		return nil, &Error{ExitCode: code, Stderr: stderr.buf.Bytes(), Cause: err}
	}
	if stdout.overflow {
		return nil, ErrOutputTooLarge
	}
	return stdout.buf.Bytes(), nil
}

// DefaultUsername is the basic-auth username of a GitHub installation token.
const DefaultUsername = "x-access-token"

func basicValue(username, token string) string {
	return base64.StdEncoding.EncodeToString([]byte(username + ":" + token))
}

// BasicHeader is the clone's Authorization header: Basic base64(username + ":" + token). The
// username is the claim's clone.username (x-access-token for GitHub; validated: no `:`).
func BasicHeader(username, token string) string {
	return "Authorization: Basic " + basicValue(username, token)
}

// Scrub removes every secret, the basic-auth value of username with each secret (and of the
// default username, in case git or a server echoes either), and any line mentioning
// Authorization from git's stderr, and cuts it to 300 bytes, so it can go into a result message.
// An empty username means DefaultUsername.
func Scrub(stderr []byte, username string, secrets ...string) string {
	if username == "" {
		username = DefaultUsername
	}
	var redact []string
	for _, s := range secrets {
		if s != "" {
			// The encodings first, so replacing the raw text can't break one before it is matched.
			redact = append(redact, basicValue(username, s), basicValue(DefaultUsername, s), s)
		}
	}
	var lines []string
	for _, line := range strings.Split(string(stderr), "\n") {
		if strings.Contains(strings.ToLower(line), "authorization") {
			continue
		}
		for _, r := range redact {
			line = strings.ReplaceAll(line, r, "[redacted]")
		}
		lines = append(lines, line)
	}
	out := strings.TrimSpace(strings.Join(lines, "\n"))
	if len(out) > 300 {
		out = out[:300]
	}
	return strings.ToValidUTF8(out, "")
}
