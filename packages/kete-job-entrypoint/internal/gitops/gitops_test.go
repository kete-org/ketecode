package gitops

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeGit writes a script that records its argv and environment, then exits with code.
func fakeGit(t *testing.T, code int) (string, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "log")
	script := filepath.Join(dir, "git")
	body := "#!/bin/sh\necho \"ARGS $*\" >> " + log + "\nenv >> " + log + "\necho 'fatal: Authorization: Basic abc' >&2\necho 'fatal: token SECRETTOKEN0123456789 rejected' >&2\nexit " + string(rune('0'+code)) + "\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, log
}

func runner(git string) Runner {
	return Runner{Git: git, Home: "/var/lib/kete-root/home", ProxyURL: "http://127.0.0.1:83", CAPath: "/run/kete-egress/ca.pem", Timeout: 10 * time.Second, CloneTimeout: 10 * time.Second, MaxStdout: 1 << 20, MaxStderr: 1 << 16}
}

func TestCloneEnvironment(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	t.Setenv("GIT_TRACE", "1")
	t.Setenv("GIT_DIR", "/evil")
	git, log := fakeGit(t, 0)
	r := runner(git)
	token := "SECRETTOKEN0123456789"
	if err := r.Clone(context.Background(), "https://github.com/org/repo.git", "main", "x-access-token", token, "/var/lib/kete-root/pristine.git"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(log)
	out := string(data)
	if !strings.Contains(out, "ARGS clone --bare --depth=1 --single-branch --no-tags --branch main -- https://github.com/org/repo.git /var/lib/kete-root/pristine.git") {
		t.Errorf("argv: %s", out)
	}
	argsLine := strings.SplitN(out, "\n", 2)[0]
	if strings.Contains(argsLine, token) {
		t.Error("token in argv")
	}
	for _, want := range []string{"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "GIT_NO_REPLACE_OBJECTS=1", "GIT_LFS_SKIP_SMUDGE=1", "GIT_PROTOCOL_FROM_USER=0", "LC_ALL=C", "HOME=/var/lib/kete-root/home", "=core.hooksPath", "=/dev/null", "=core.fsmonitor", "=protocol.allow", "=never", "=http.proxy", "=http://127.0.0.1:83", "=http.sslCAInfo", "=http.extraHeader"} {
		if !strings.Contains(out, want) {
			t.Errorf("env lacks %q", want)
		}
	}
	if !strings.Contains(out, "Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))) {
		t.Error("extraHeader value")
	}
	for _, bad := range []string{"GIT_TRACE", "GIT_DIR=/evil", "GIT_INDEX_FILE"} {
		if strings.Contains(out, bad) {
			t.Errorf("env leaks %q", bad)
		}
	}
}

func TestScrubAndError(t *testing.T) {
	git, _ := fakeGit(t, 3)
	_, err := runner(git).Run(context.Background(), Call{Args: []string{"status"}})
	ge, ok := err.(*Error)
	if !ok || ge.ExitCode != 3 {
		t.Fatalf("err = %v", err)
	}
	s := Scrub(ge.Stderr, "", "SECRETTOKEN0123456789")
	if strings.Contains(s, "SECRETTOKEN") || strings.Contains(s, "Basic") || !strings.Contains(s, "[redacted]") {
		t.Errorf("scrubbed = %q", s)
	}
	if len(Scrub([]byte(strings.Repeat("x", 1000)), "")) != 300 {
		t.Error("not cut to 300")
	}
}

func TestIndexFileOnlyWhenAsked(t *testing.T) {
	r := runner("/usr/bin/git")
	env := strings.Join(r.Env(Call{IndexFile: "/tmp/i"}), "\n")
	if !strings.Contains(env, "GIT_INDEX_FILE=/tmp/i") {
		t.Error("index file missing")
	}
	if strings.Contains(strings.Join(r.Env(Call{}), "\n"), "GIT_INDEX_FILE") {
		t.Error("index file set without being asked")
	}
}

func TestParseLsTree(t *testing.T) {
	out := []byte("100644 blob ce013625030ba8dba906f756967f9e9ca394464a       6\tREADME.md\x00160000 commit 0123456789abcdef0123456789abcdef01234567       -\tsub\x00")
	e, err := ParseLsTree(out)
	if err != nil || len(e) != 2 || e[0].Size != 6 || e[0].Path != "README.md" || e[1].Size != -1 {
		t.Fatalf("entries = %+v, %v", e, err)
	}
	if _, err := ParseLsTree([]byte("garbage\x00")); err == nil {
		t.Error("garbage accepted")
	}
}

func TestCapAndTimeout(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "git")
	_ = os.WriteFile(script, []byte("#!/bin/sh\nhead -c 2000 /dev/zero\n"), 0o755)
	r := runner(script)
	r.MaxStdout = 1000
	if _, err := r.Run(context.Background(), Call{}); err != ErrOutputTooLarge {
		t.Errorf("err = %v", err)
	}
	_ = os.WriteFile(script, []byte("#!/bin/sh\nsleep 30\n"), 0o755)
	start := time.Now()
	if _, err := r.Run(context.Background(), Call{Timeout: 200 * time.Millisecond}); err == nil {
		t.Error("timeout not reported")
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("timeout took %v", time.Since(start))
	}
}

// The test vector's basic_authorization (kete-code-platform
// docs/contracts/test-vectors/jobs-v1/claim-harness-code.json).
func TestBasicHeader(t *testing.T) {
	got := BasicHeader("kete_code_clone", "sat.acct_Example1.kete_job_6f9619ff8b86_1a2b3c4d.EXAMPLEexampleEXAMPLE")
	want := "Authorization: Basic a2V0ZV9jb2RlX2Nsb25lOnNhdC5hY2N0X0V4YW1wbGUxLmtldGVfam9iXzZmOTYxOWZmOGI4Nl8xYTJiM2M0ZC5FWEFNUExFZXhhbXBsZUVYQU1QTEU="
	if got != want {
		t.Errorf("BasicHeader = %q", got)
	}
	if BasicHeader("x-access-token", "t") != "Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:t")) {
		t.Error("GitHub header")
	}
}

// The clone's username reaches the header.
func TestCloneUsername(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	git, log := fakeGit(t, 0)
	if err := runner(git).Clone(context.Background(), "https://git.harness.io/a/b/c/d.git", "main", "kete_code_clone", "TOK", "/tmp/p.git"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(log)
	if !strings.Contains(string(data), "Authorization: Basic "+base64.StdEncoding.EncodeToString([]byte("kete_code_clone:TOK"))) {
		t.Errorf("extraHeader for the claim's username missing")
	}
}

// Scrub redacts the token, base64(username:token) for the claim's username and the default one,
// and drops every line naming Authorization, whatever its case.
func TestScrubBasicValue(t *testing.T) {
	tok := "sat.acct.kete_job_SECRET"
	b64 := base64.StdEncoding.EncodeToString([]byte("kete_code_clone:" + tok))
	gh := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + tok))
	in := "fatal: unable to access: " + tok + "\nsent " + b64 + "\nalso " + gh + "\n> AUTHORIZATION: Basic " + b64 + "\nauthorization: bearer x\nremote: done\n"
	s := Scrub([]byte(in), "kete_code_clone", tok)
	for _, bad := range []string{tok, b64, gh, "AUTHORIZATION", "bearer", "SECRET"} {
		if strings.Contains(s, bad) {
			t.Errorf("scrubbed output still holds %q: %q", bad, s)
		}
	}
	if !strings.Contains(s, "remote: done") || strings.Count(s, "[redacted]") != 3 {
		t.Errorf("scrubbed = %q", s)
	}
}
