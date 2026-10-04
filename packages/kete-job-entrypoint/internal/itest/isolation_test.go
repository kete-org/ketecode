//go:build integration && linux

package itest

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/setup"
)

// bootHook, when set, edits the machine configuration runJob passes (e.g. OnFly).
var bootHook func(*bootenv.Values)

func withBoot(t *testing.T, hook func(*bootenv.Values)) {
	t.Helper()
	orig := bootHook
	bootHook = hook
	t.Cleanup(func() { bootHook = orig })
}

func phaseLine(stdout, want string) bool { return strings.Contains(stdout, want) }

// worldSocket listens on a unix socket anyone may connect to (the shape of a misplaced Fly API
// socket): mode 0666 in a 0755 (or given) directory, accepting and closing connections.
func worldSocket(t *testing.T, path string, dirMode os.FileMode) {
	t.Helper()
	if !strings.HasPrefix(path, "@") {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Dir(path), dirMode); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(path)) })
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	if !strings.HasPrefix(path, "@") {
		if err := os.Chmod(path, 0o666); err != nil {
			t.Fatal(err)
		}
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
}

func toolProbe(t *testing.T) isolation.Options {
	t.Helper()
	return isolation.Options{
		Exe: "/proc/self/exe", UID: uint32(lookupID(t, "/etc/passwd", "kete-tool")),
		GID: uint32(lookupID(t, "/etc/group", "kete-job")), Timeout: 20 * time.Second,
	}
}

func reasonOf(err error) phaselog.Code {
	if err == nil {
		return isolation.OK
	}
	var f *isolation.Failure
	if errors.As(err, &f) {
		return f.Reason
	}
	return "not a Failure: " + phaselog.Code(err.Error())
}

// TestIsolationProbeDetects runs the real probe as the tool user with no firewall, against real
// listeners and directories, and checks each reachable target yields its reason (and the control
// is enforced). The firewall-on runs below show the same targets refused.
func TestIsolationProbeDetects(t *testing.T) {
	ctl, err := isolation.Listen()
	if err != nil {
		t.Fatal(err)
	}
	defer ctl.Close()
	control, unixControl := ctl.TCPAddr(), ctl.UnixName()
	lo, err := net.Listen("tcp", "127.0.0.1:700")
	if err != nil {
		t.Fatal(err)
	}
	defer lo.Close()
	go func() {
		for {
			c, err := lo.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	openDir := filepath.Join(stateDir, "kete-open-dir")
	if err := os.MkdirAll(openDir, 0o755); err != nil {
		t.Fatal(err)
	}
	closedDir := filepath.Join(stateDir, "kete-closed-dir")
	if err := os.MkdirAll(closedDir, 0o700); err != nil {
		t.Fatal(err)
	}
	stray := "/run/kete-it-stray/api.sock"
	worldSocket(t, stray, 0o755)
	worldSocket(t, "@kete-it-abstract", 0)
	hidden := "/run/kete-it-hidden/api.sock"
	worldSocket(t, hidden, 0o700)

	cases := map[string]struct {
		in   isolation.Inputs
		want phaselog.Code
	}{
		"nothing reachable": {isolation.Inputs{Control: control, UnixControl: unixControl, PortTool: 700, KeteDirs: []string{closedDir}, UnixSockets: []string{hidden}}, isolation.OK},
		"loopback":          {isolation.Inputs{Control: control, UnixControl: unixControl, PortTool: 82}, phaselog.CodeLoopback},
		"kete dir":          {isolation.Inputs{Control: control, UnixControl: unixControl, PortTool: 700, KeteDirs: []string{openDir}}, phaselog.CodeKeteDir},
		"stray socket":      {isolation.Inputs{Control: control, UnixControl: unixControl, PortTool: 700, UnixSockets: []string{stray}}, phaselog.CodeUnixSocket},
		"abstract socket":   {isolation.Inputs{Control: control, UnixControl: unixControl, PortTool: 700, UnixSockets: []string{"@kete-it-abstract"}}, phaselog.CodeUnixSocket},
		"fly socket":        {isolation.Inputs{Control: control, UnixControl: unixControl, PortTool: 700, FlySockets: []string{stray}}, phaselog.CodeFlyAPI},
		"resolver":          {isolation.Inputs{Control: control, UnixControl: unixControl, PortTool: 700, Resolvers: []string{dnsAddr}}, phaselog.CodeResolver},
		"control":           {isolation.Inputs{Control: "127.0.0.1:1", UnixControl: unixControl, PortTool: 700}, phaselog.CodeControl},
		"unix control":      {isolation.Inputs{Control: control, UnixControl: "@kete-it-no-such-listener", PortTool: 700}, phaselog.CodeControl},
	}
	for name, c := range cases {
		start := time.Now()
		got := reasonOf(isolation.Run(context.Background(), toolProbe(t), isolation.NewRequest(isolation.Build(c.in))))
		if got != c.want {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
		t.Logf("%s: %q in %v", name, got, time.Since(start))
	}
}

// TestFlyGuardMissingAPISocket: on Fly (OnFly) with no /.fly/api, setup fails closed before
// claim with setup_fly "missing".
func TestFlyGuardMissingAPISocket(t *testing.T) {
	withBoot(t, func(v *bootenv.Values) { v.OnFly = true })
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(c *layout.Config) { c.FlyDir = "/run/kete-it-nofly/.fly" })
	zeroClaims(t, r)
	if !phaseLine(r.stdout, `"step":"setup_fly","event":"failed","code":"missing"`) {
		t.Errorf("no setup_fly missing line:\n%s", r.stdout)
	}
	// A Fly directory without its socket fails the same way, even without Fly's variables.
	withBoot(t, nil)
	dir := "/run/kete-it-fly-nosock/.fly"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(filepath.Dir(dir)) })
	r = runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(c *layout.Config) { c.FlyDir = dir })
	zeroClaims(t, r)
	if !phaseLine(r.stdout, `"step":"setup_fly","event":"failed","code":"missing"`) {
		t.Errorf("no setup_fly missing line:\n%s", r.stdout)
	}
}

// TestFlyGuardLocks: a world-open Fly directory and API socket are reachable by the tool user
// before the guard (the probe sees it), locked by it (root 0700 / 0600), and the job then runs.
func TestFlyGuardLocks(t *testing.T) {
	dir := "/run/kete-it-fly/.fly"
	api := filepath.Join(dir, "api")
	worldSocket(t, api, 0o777)
	// The controls are closed before the job runs: their abstract unix listener is
	// world-connectable, so the job's own check would (rightly) stop at unix_socket.
	ctl, err := isolation.Listen()
	if err != nil {
		t.Fatal(err)
	}
	got := reasonOf(isolation.Run(context.Background(), toolProbe(t), isolation.NewRequest(isolation.FlyProbes(ctl.TCPAddr(), ctl.UnixName(), setup.FlySocketPaths(dir)))))
	ctl.Close()
	if got != phaselog.CodeFlyAPI {
		t.Fatalf("before the guard the tool user should reach the socket: %q", got)
	}
	withBoot(t, func(v *bootenv.Values) { v.OnFly = true })
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(c *layout.Config) { c.FlyDir = dir })
	if r.code != 0 {
		t.Fatalf("exit %d; stdout:\n%s", r.code, r.stdout)
	}
	for _, want := range []string{`"step":"setup_fly","event":"ok"`, `"step":"isolation","event":"ok"`} {
		if !phaseLine(r.stdout, want) {
			t.Errorf("no %s line", want)
		}
	}
	if res := resultOf(t); res["outcome"] != "completed" {
		t.Errorf("result = %v", res)
	}
	var st syscall.Stat_t
	if err := syscall.Lstat(dir, &st); err != nil || st.Uid != 0 || st.Mode&0o7777 != 0o700 {
		t.Errorf("fly dir mode %o (%v)", st.Mode&0o7777, err)
	}
	if err := syscall.Lstat(api, &st); err != nil || st.Mode&0o7777 != 0o600 {
		t.Errorf("fly socket mode %o (%v)", st.Mode&0o7777, err)
	}
}

// TestIsolationStraySocket is the review finding's scenario: the machine API (or anything else)
// listening on a unix socket the guard doesn't know about, connectable by anyone. The isolation
// check finds it in /proc/net/unix, reaches it as the tool user, and refuses to claim.
func TestIsolationStraySocket(t *testing.T) {
	for _, path := range []string{"/run/kete-it-stray/api.sock", "@kete-it-stray"} {
		t.Run(strings.TrimPrefix(path, "@"), func(t *testing.T) {
			worldSocket(t, path, 0o755)
			r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, nil)
			zeroClaims(t, r)
			if !phaseLine(r.stdout, `"step":"isolation","event":"failed","code":"unix_socket"`) {
				t.Errorf("no isolation unix_socket line:\n%s", r.stdout)
			}
		})
	}
}

// TestIsolationReadableKeteDir: kete's home readable by the tool user (a broken layout) is
// refused before claim.
func TestIsolationReadableKeteDir(t *testing.T) {
	// The layout step resets kete's home to 0700, so loosen it between setup and the check: a
	// helper wrapper does it just before exec'ing the real helper.
	wrapper := filepath.Join(stateDir, "helper-loosen")
	script := "#!/bin/sh\nchmod 0755 /var/lib/kete-job/kete\nexec /usr/local/libexec/kete/kete-root-helper \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(c *layout.Config) { c.HelperBin = wrapper })
	zeroClaims(t, r)
	if !phaseLine(r.stdout, `"step":"isolation","event":"failed","code":"kete_dir"`) {
		t.Errorf("no isolation kete_dir line:\n%s", r.stdout)
	}
}

// TestBinaryBootOnFly: the built binary with FLY_MACHINE_ID set and no /.fly: the Fly variable
// survives the scrubbed re-exec (as OnFly only) and setup fails closed before claim.
func TestBinaryBootOnFly(t *testing.T) {
	t.Cleanup(func() { cleanup(t) })
	j := FP.NewJob(fakeplatform.Knobs{Prompt: "lifecycle", Deadline: 10 * time.Minute})
	if _, err := os.Lstat("/.fly"); err == nil {
		t.Skip("/.fly exists in this container")
	}
	cmd := exec.Command(entrypoint)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "FLY_MACHINE_ID=148e21ea7e3289", "KETE_JOB_ID=" + j.ID, "KETE_JOB_PLATFORM_URL=https://" + fakeplatform.PlatformHost, "KETE_JOB_CLAIM_TOKEN=" + j.ClaimToken, "KETE_JOB_STORAGE_HOST=" + fakeplatform.StorageHost}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 1 {
		t.Fatalf("entrypoint: %v; stdout:\n%s", err, out.String())
	}
	checkPhaseLines(t, out.String(), j)
	if !phaseLine(out.String(), `"step":"setup_fly","event":"failed","code":"missing"`) {
		t.Errorf("no setup_fly missing line:\n%s", out.String())
	}
	if n := countCalls("claim"); n != 0 {
		t.Errorf("%d claim requests", n)
	}
}

// TestIsolationFirewallRefuses: root listeners on privileged loopback ports (reachable by the tool
// user without the firewall: TestIsolationProbeDetects "loopback") are refused once the job's
// firewall is up, so the check passes and the job runs.
func TestIsolationFirewallRefuses(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:700", "[::1]:700"} {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
	}
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, nil)
	if r.code != 0 || !phaseLine(r.stdout, `"step":"isolation","event":"ok"`) {
		t.Fatalf("exit %d; stdout:\n%s", r.code, r.stdout)
	}
}
