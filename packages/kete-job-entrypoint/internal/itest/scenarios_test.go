//go:build integration && linux

package itest

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
)

func readTar(t *testing.T, gz []byte) (map[string][]byte, []*tar.Header) {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(zr)
	files := map[string][]byte{}
	var hdrs []*tar.Header
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		files[h.Name] = b
		hdrs = append(hdrs, h)
	}
	return files, hdrs
}

type event struct {
	Phase   string `json:"phase"`
	Message string `json:"message"`
	Eff     *int   `json:"effective_timeout_minutes"`
	Extra   *int   `json:"kete_cgroup_extra"`
}

// assertLifecycle checks a complete, clean GitHub job (AC1 up to the fake kete).
func assertLifecycle(t *testing.T, r run) {
	t.Helper()
	assertLifecycleVia(t, r, "revoke clone-done", "revoke", fakeplatform.GitHost)
}

// assertLifecycleVia checks a complete, clean job whose clone token is released by the calls
// revokeSeq (in order, after events(clone)); revokeKind's first accepted call must come before
// the agent phase, and gitHost is the clone host root reached.
func assertLifecycleVia(t *testing.T, r run, revokeSeq, revokeKind, gitHost string) {
	t.Helper()
	if r.code != 0 {
		t.Fatalf("exit %d; stdout:\n%s", r.code, r.stdout)
	}
	calls := FP.Calls()
	// Order: claim → git… → events(clone) … revoke → events(agent, eff) → … → result →
	// events(report) → uploads → 3 PUTs → events(done) → finish.
	var seq []string
	var last time.Time
	var revokeAt, firstAgentAt time.Time
	for _, c := range calls {
		k := c.Kind
		if k == "events" {
			var e event
			_ = json.Unmarshal(c.Body, &e)
			if e.Phase == "agent" && firstAgentAt.IsZero() {
				firstAgentAt = c.Time
				if e.Eff == nil || *e.Eff < 1 {
					t.Errorf("first agent event without effective_timeout_minutes: %s", c.Body)
				}
			}
			if e.Extra != nil && *e.Extra != 0 {
				t.Errorf("kete_cgroup_extra = %d", *e.Extra)
			}
			if e.Message != "" {
				t.Errorf("unexpected events message %q", e.Message)
			}
			k += "(" + e.Phase + ")"
		}
		if k == revokeKind && c.Status/100 == 2 && revokeAt.IsZero() {
			revokeAt = c.Time
		}
		if !last.IsZero() && c.Time.Sub(last) > 60*time.Second {
			t.Errorf("a gap of %v between callbacks", c.Time.Sub(last))
		}
		last = c.Time
		// Heartbeats: every events(clone) after the first (one may land between clone-done's
		// retries), and repeated events(agent).
		if k == "git" || k == "events(clone)" && strings.Contains(" "+strings.Join(seq, " ")+" ", " events(clone) ") || k == "events(agent)" && len(seq) > 0 && seq[len(seq)-1] == k {
			continue
		}
		seq = append(seq, k)
	}
	got := strings.Join(seq, " ")
	want := "claim events(clone) " + revokeSeq + " events(agent) result events(report) uploads put:audit put:bundle put:proxy_log events(done) finish"
	if got != want {
		t.Errorf("call sequence:\n got %s\nwant %s", got, want)
	}
	if revokeAt.IsZero() || !revokeAt.Before(firstAgentAt) {
		t.Error("the clone token was not revoked before the agent phase")
	}
	res := resultOf(t)
	if res["outcome"] != "completed" || res["branch"] != r.job.Branch || res["isolated"] != true {
		t.Errorf("result = %v", res)
	}
	if text, _ := res["text"].(string); !strings.Contains(text, "tool user: kete-tool") || !strings.Contains(text, "checks: ok") {
		t.Errorf("fake kete's checks: %q", text)
	}
	if pe := finishPushError(t); pe != "" {
		t.Errorf("push_error = %q", pe)
	}
	// The bundle: exactly README.md, with the edit.
	b, ok := FP.Uploaded("bundle")
	if !ok {
		t.Fatal("no bundle uploaded")
	}
	files, hdrs := readTar(t, b)
	var manifest []map[string]any
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest) != 1 || manifest[0]["path"] != "README.md" || manifest[0]["mode"] != "100644" {
		t.Errorf("manifest = %v", manifest)
	}
	if want := fakeplatform.RepoFiles["README.md"].Content + "edited by the fake kete\n"; string(files["files/README.md"]) != want {
		t.Errorf("files/README.md = %q", files["files/README.md"])
	}
	for _, h := range hdrs {
		if h.Uid != 0 || h.Gid != 0 || h.Mode != 0o644 || h.ModTime.Unix() != 0 || h.Uname != "" {
			t.Errorf("tar header %+v", h)
		}
	}
	// The audit log (piece A3): exactly the lines the fake kete wrote to its audit pipe, copied into
	// a root-owned 0600 file; nothing in kete's data dir.
	audit, ok := FP.Uploaded("audit")
	sid, _ := res["session_id"].(string)
	wantAudit := `{"v":1,"type":"run","event":"started","session_id":"` + sid + `","root_id":"` + sid + `"}` + "\n" +
		`{"v":1,"type":"run","event":"ended","session_id":"` + sid + `","root_id":"` + sid + `","reason":"completed"}` + "\n"
	if !ok || string(audit) != wantAudit {
		t.Errorf("audit upload = %q, want %q", audit, wantAudit)
	}
	cfg := layout.Default()
	if info, err := os.Lstat(cfg.KeteAudit()); err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 ||
		info.Sys().(*syscall.Stat_t).Uid != 0 {
		t.Errorf("root audit file: %v %v", info, err)
	} else if b, _ := os.ReadFile(cfg.KeteAudit()); string(b) != string(audit) {
		t.Errorf("root audit file differs from the upload")
	}
	if _, err := os.Lstat(filepath.Join(cfg.KeteDataHome(), "kete", "audit")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("kete's data dir has an audit directory: %v", err)
	}
	// The proxy log: JSONL v1, with root's platform and git requests.
	plog, ok := FP.Uploaded("proxy_log")
	if !ok {
		t.Fatal("no proxy log uploaded")
	}
	sawPlatform, sawGit := false, false
	for _, line := range strings.Split(strings.TrimSpace(string(plog)), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil || m["v"] != 1.0 {
			t.Errorf("proxy log line %q", line)
			continue
		}
		if m["user"] == "root" && m["host"] == fakeplatform.PlatformHost {
			sawPlatform = true
		}
		if m["user"] == "root" && m["host"] == gitHost {
			sawGit = true
		}
	}
	if !sawPlatform || !sawGit {
		t.Errorf("proxy log lacks root's platform (%v) or git (%v) requests", sawPlatform, sawGit)
	}
	jobCgroupsEmpty(t)
}

// TestLifecycle is AC1 with the fake kete: claim, clone, a tool call as the tool user through the
// real helper, an edit, heartbeats, result, uploads, finish; the bundle holds exactly the edit.
func TestLifecycle(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, nil)
	assertLifecycle(t, r)
}

// TestHarnessCodeLifecycle is TestLifecycle against a harness_code claim (jobs-v1 additive,
// 2026-10-05; the shared test vector's shape): the claim announces clone_revoke_callback; the
// clone authenticates with basic auth for the claim's username; the git host's API is never
// called (the fake records any call as a contract error); the token is released by clone-done,
// retried once after a 500, before the agent phase; no phase after the clone reaches the git host.
func TestHarnessCodeLifecycle(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle", Provider: fakeplatform.ProviderHarnessCode, CloneDoneFailures: 1}, nil)
	assertLifecycleVia(t, r, "clone-done clone-done", "clone-done", fakeplatform.HarnessGitHost)
	if countCalls("revoke") != 0 || countCalls("harness-api") != 0 {
		t.Error("the git host's API was called")
	}
	if !r.job.CloneDeleted {
		t.Error("clone-done did not delete the token")
	}
	if strings.Join(r.job.Features, ",") != "clone_revoke_callback" {
		t.Errorf("claim features %v", r.job.Features)
	}
	// After clone-done, root reached the git host no more; the agent and report phases never did.
	var doneAt time.Time
	for _, c := range FP.Calls() {
		if c.Kind == "clone-done" && c.Status == 204 {
			doneAt = c.Time
			break
		}
	}
	for _, c := range FP.Calls() {
		if c.Kind == "git" && c.Time.After(doneAt) {
			t.Errorf("a git request after clone-done: %s", c.Body)
		}
	}
	plog, _ := FP.Uploaded("proxy_log")
	for _, line := range strings.Split(strings.TrimSpace(string(plog)), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil && m["host"] == fakeplatform.HarnessGitHost && m["user"] != "root" {
			t.Errorf("a job user reached the git host: %s", line)
		}
	}
}

// TestHarnessCodeWrongCommit: HEAD ≠ base_sha on a Harness Code job calls clone-done before the
// refused result; kete never starts.
func TestHarnessCodeWrongCommit(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle", Provider: fakeplatform.ProviderHarnessCode, BaseSHAOverride: strings.Repeat("1", 40)}, nil)
	if r.code != 0 {
		t.Errorf("exit %d", r.code)
	}
	if res := resultOf(t); res["outcome"] != "refused" || res["exit_code"] != 2.0 {
		t.Errorf("result = %v", res)
	}
	var doneAt, resultAt time.Time
	for _, c := range FP.Calls() {
		switch {
		case c.Kind == "clone-done" && c.Status == 204:
			doneAt = c.Time
		case c.Kind == "result":
			resultAt = c.Time
		}
	}
	if doneAt.IsZero() || !doneAt.Before(resultAt) || !r.job.CloneDeleted {
		t.Errorf("clone-done not before the result: %v", FP.Kinds())
	}
	if _, err := os.Stat("/var/log/kete-job/kete.stdout"); err == nil {
		t.Error("kete started")
	}
}

// TestAuditOverLimit (piece A3, N5): kete writes more than 20,000,000 bytes to its audit pipe; the
// entrypoint stops reading and closes it, so kete's write fails (EPIPE), and nothing is uploaded.
func TestAuditOverLimit(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "audit-flood"}, nil)
	if r.code != 0 {
		t.Fatalf("exit %d; stdout:\n%s", r.code, r.stdout)
	}
	res := resultOf(t)
	if res["outcome"] != "audit_failed" || res["text"] != "audit-flood: epipe" {
		t.Errorf("result = %v", res)
	}
	if _, ok := FP.Uploaded("audit"); ok {
		t.Error("an over-limit audit log was uploaded")
	}
	noted := false
	for _, c := range FP.Calls() {
		var e event
		if c.Kind == "events" && json.Unmarshal(c.Body, &e) == nil && e.Message == "audit log not uploaded: too large" {
			noted = true
		}
	}
	if !noted {
		t.Error("no `too large` note")
	}
	jobCgroupsEmpty(t)
}

func zeroClaims(t *testing.T, r run) {
	t.Helper()
	if r.code != 1 {
		t.Errorf("exit %d", r.code)
	}
	if n := countCalls("claim"); n != 0 {
		t.Errorf("%d claim requests", n)
	}
}

// AC2: no claim without the firewall, the proxy, or the helper.
func TestRefuseClaimWithoutFirewall(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(c *layout.Config) { c.NftBin = "/bin/false" })
	zeroClaims(t, r)
}

func TestRefuseClaimWithoutProxy(t *testing.T) {
	wrapper := filepath.Join(stateDir, "egress-no-serve")
	script := "#!/bin/sh\nif [ \"$1\" = serve ]; then echo refused >&2; exit 2; fi\nexec /usr/local/libexec/kete/kete-egress \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(c *layout.Config) { c.EgressBin = wrapper })
	zeroClaims(t, r)
}

func TestRefuseClaimWithoutHelper(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(c *layout.Config) { c.HelperBin = "/bin/false" })
	zeroClaims(t, r)
}

// AC2: a clone at the wrong commit is refused (2) and kete never starts.
func TestCloneWrongCommit(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle", BaseSHAOverride: strings.Repeat("1", 40)}, nil)
	if r.code != 0 {
		t.Errorf("exit %d", r.code)
	}
	res := resultOf(t)
	if res["outcome"] != "refused" || res["exit_code"] != 2.0 {
		t.Errorf("result = %v", res)
	}
	if countCalls("revoke") != 0 {
		t.Error("revoke after a wrong commit")
	}
	if _, err := os.Stat("/var/log/kete-job/kete.stdout"); err == nil {
		t.Error("kete started")
	}
	if uploadsAsked(t) {
		t.Error("a bundle was asked for")
	}
}

// AC2: a process of the tool user that survives (here, outside the job cgroups) → processes_alive;
// the proxy is not restarted while it lives, so nothing is uploaded (result and finish only).
func TestProcessesAlive(t *testing.T) {
	uid, gid := lookupID(t, "/etc/passwd", "kete-tool"), lookupID(t, "/etc/group", "kete-job")
	stray := exec.Command("/bin/sleep", "120")
	stray.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}}
	if err := stray.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stray.Process.Kill(); _ = stray.Wait() }()
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle"}, nil)
	if r.code != 0 {
		t.Errorf("exit %d", r.code)
	}
	if pe := finishPushError(t); pe != "processes_alive" {
		t.Errorf("push_error = %q", pe)
	}
	if countCalls("uploads") != 0 {
		t.Errorf("uploads while a job process is alive: %v", FP.Kinds())
	}
	if resultOf(t)["outcome"] != "completed" {
		t.Error("kete's own result was not sent")
	}
}

// ADR 0019 rule 5 (jobs.md §10 item 12): a process started in the kete user's cgroup shows up on
// an agent-phase heartbeat as kete_cgroup_extra > 0, which the platform records as a job error.
func TestKeteCgroupStray(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "stray"}, nil)
	if r.code != 0 {
		t.Fatalf("exit %d; stdout:\n%s", r.code, r.stdout)
	}
	reported := false
	for _, c := range FP.Calls() {
		if c.Kind != "events" {
			continue
		}
		var e event
		_ = json.Unmarshal(c.Body, &e)
		if e.Phase == "agent" && e.Extra != nil && *e.Extra >= 1 {
			reported = true
		}
	}
	if !reported {
		t.Errorf("no agent heartbeat reported the stray process: %v", FP.Kinds())
	}
	if resultOf(t)["outcome"] != "completed" {
		t.Error("kete's own result was not sent")
	}
}

// AC2: the proxy dies mid-agent → proxy_failed; a restarted proxy reports; no bundle.
func TestProxyFailed(t *testing.T) {
	var wg sync.WaitGroup
	var killed atomic.Int32
	wg.Add(1)
	go func() {
		defer wg.Done()
		// Keep trying until a proxy process was actually killed: returning after one attempt that
		// found no process (e.g. a scan between instances) let the job run to its time limit.
		deadline := time.Now().Add(60 * time.Second)
		for time.Now().Before(deadline) {
			if hasAgentEvent() {
				for _, pid := range pidsOf("/usr/local/libexec/kete/kete-egress", "serve") {
					if syscall.Kill(pid, syscall.SIGKILL) == nil {
						killed.Add(1)
					}
				}
				if killed.Load() > 0 {
					return
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
	}()
	r := runJob(t, fakeplatform.Knobs{Prompt: "hang"}, nil)
	wg.Wait()
	if killed.Load() == 0 {
		t.Fatal("never found a running proxy to kill during the agent phase")
	}
	if r.code != 0 {
		t.Errorf("exit %d", r.code)
	}
	if res := resultOf(t); res["outcome"] != "proxy_failed" {
		t.Errorf("result = %v", res)
	}
	if pe := finishPushError(t); pe != "proxy_failed" {
		t.Errorf("push_error = %q", pe)
	}
	if uploadsAsked(t) {
		t.Error("a bundle was asked for")
	}
	if _, ok := FP.Uploaded("proxy_log"); !ok {
		t.Error("no proxy log uploaded")
	}
	jobCgroupsEmpty(t)
}

func hasAgentEvent() bool {
	for _, c := range FP.Calls() {
		if c.Kind == "events" && strings.Contains(string(c.Body), `"agent"`) {
			return true
		}
	}
	return false
}

// AC2: the hard deadline ends the job even with kete hung and uploads hanging.
func TestHardDeadline(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "hang", Deadline: 15 * time.Second, HangUploads: true}, nil)
	if r.code != 1 {
		t.Errorf("exit %d", r.code)
	}
	if time.Now().After(r.job.Deadline.Add(2 * time.Second)) {
		t.Errorf("returned %v after the deadline", time.Since(r.job.Deadline))
	}
	if countCalls("finish") != 0 {
		t.Error("finish after the deadline")
	}
	if res := resultOf(t); res["outcome"] != "time_limit" || res["exit_code"] != 3.0 {
		t.Errorf("result = %v", res)
	}
	jobCgroupsEmpty(t)
	if len(pidsOf("/usr/local/bin/kete", "")) != 0 {
		t.Error("kete still running")
	}
}

// A 404 on events (cancelled) kills everything and stops calling back.
func TestCancelled(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "hang", EventsGoneAfter: 2}, nil)
	if r.code != 0 {
		t.Errorf("exit %d", r.code)
	}
	calls := FP.Calls()
	if last := calls[len(calls)-1]; last.Kind != "events" || last.Status != 404 {
		t.Errorf("calls after the 404: %v", FP.Kinds())
	}
	if countCalls("result") != 0 || countCalls("finish") != 0 {
		t.Errorf("calls %v", FP.Kinds())
	}
	jobCgroupsEmpty(t)
}

// Not enough time before the deadline: outcome deadline, kete never starts.
func TestDeadlineTooShort(t *testing.T) {
	r := runJob(t, fakeplatform.Knobs{Prompt: "lifecycle", Deadline: 30 * time.Second}, func(c *layout.Config) { c.Minute = time.Minute })
	if r.code != 0 {
		t.Errorf("exit %d", r.code)
	}
	if res := resultOf(t); res["outcome"] != "deadline" {
		t.Errorf("result = %v", res)
	}
	if _, err := os.Stat("/var/log/kete-job/kete.stdout"); err == nil {
		t.Error("kete started")
	}
}

// AC3: the bundle reader refuses a symlink, a special file and an oversized file.
func TestBundleRefusals(t *testing.T) {
	for scenario, want := range map[string]string{"symlink": "symlink", "fifo": "unreadable", "oversize": "unreadable"} {
		t.Run(scenario, func(t *testing.T) {
			r := runJob(t, fakeplatform.Knobs{Prompt: scenario}, nil)
			if r.code != 0 {
				t.Errorf("exit %d", r.code)
			}
			if pe := finishPushError(t); pe != want {
				t.Errorf("push_error = %q, want %q", pe, want)
			}
			if uploadsAsked(t) {
				t.Error("a bundle was asked for")
			}
			if _, err := os.Stat("/etc/passwd"); err != nil {
				t.Error("passwd")
			}
		})
	}
}

// AC4: no token in any cmdline; no token in any environment — the gateway key reaches kete on fd 3
// (job mode piece A1), so it is in no environ, kete's included; no claim, callback or clone token on
// disk after the run (outside /proc, /sys, /dev and the sources); none in the logs or on stdout.
func TestCredentials(t *testing.T) {
	stop := make(chan struct{})
	var mu sync.Mutex
	var leaks []string
	var tokens []string
	done := make(chan struct{})
	ready := make(chan struct{})
	go func() {
		defer close(done)
		<-ready
		for {
			select {
			case <-stop:
				return
			default:
			}
			ents, _ := os.ReadDir("/proc")
			for _, e := range ents {
				if _, err := strconv.Atoi(e.Name()); err != nil {
					continue
				}
				cmd, _ := os.ReadFile("/proc/" + e.Name() + "/cmdline")
				status, _ := os.ReadFile("/proc/" + e.Name() + "/status")
				nonRoot := !strings.Contains(string(status), "\nUid:\t0\t0\t0\t0")
				env, envErr := os.ReadFile("/proc/" + e.Name() + "/environ")
				// Root must be able to read every non-root environ (a vanished process is fine);
				// an unreadable one would make the scan below pass without looking.
				if envErr != nil && nonRoot && len(status) > 0 && errors.Is(envErr, os.ErrPermission) {
					mu.Lock()
					leaks = append(leaks, "root cannot read the environ of pid "+e.Name()+" ("+strings.SplitN(string(cmd), "\x00", 2)[0]+"): "+envErr.Error())
					mu.Unlock()
				}
				if len(tokens) == 4 && (bytes.Contains(env, []byte(tokens[3])) || bytes.Contains(env, []byte("KETE_GATEWAY_KEY="))) {
					mu.Lock()
					leaks = append(leaks, "the gateway key in an environ: "+strings.SplitN(string(cmd), "\x00", 2)[0])
					mu.Unlock()
				}
				if !nonRoot {
					env = nil
				}
				mu.Lock()
				for i, tok := range tokens {
					if bytes.Contains(cmd, []byte(tok)) {
						leaks = append(leaks, "cmdline holds token "+strconv.Itoa(i))
					}
					if bytes.Contains(env, []byte(tok)) {
						leaks = append(leaks, "a non-root environ holds token "+strconv.Itoa(i))
					}
				}
				mu.Unlock()
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	r := runJobWithHook(t, fakeplatform.Knobs{Prompt: "lifecycle"}, func(j *fakeplatform.Job) {
		mu.Lock()
		tokens = []string{j.ClaimToken, j.CallbackToken, j.CloneToken, j.GatewayKey}
		mu.Unlock()
		close(ready)
	})
	close(stop)
	<-done
	assertLifecycle(t, r)
	for _, l := range leaks {
		t.Error(l)
	}
	// The stderr logs (proxy, helper, kete) carry no token.
	stderrs, _ := filepath.Glob("/var/log/kete-job/*.stderr")
	if len(stderrs) < 3 {
		t.Errorf("stderr logs = %v", stderrs)
	}
	for _, p := range stderrs {
		b, _ := os.ReadFile(p)
		for i, tok := range []string{r.job.ClaimToken, r.job.CallbackToken, r.job.CloneToken, r.job.GatewayKey} {
			if bytes.Contains(b, []byte(tok)) {
				t.Errorf("token %d in %s", i, p)
			}
		}
	}
	// On disk, before cleanup: the job's directories, /tmp, /etc, /root, /var, /run, /srv.
	secret := []string{r.job.ClaimToken, r.job.CallbackToken, r.job.CloneToken}
	for _, dir := range []string{"/run", "/var", "/srv", "/tmp", "/etc", "/root", "/home"} {
		for i, tok := range secret {
			out, _ := exec.Command("grep", "-rlF", "--exclude-dir=proc", "--", tok, dir).Output()
			if len(bytes.TrimSpace(out)) > 0 {
				t.Errorf("token %d on disk: %s", i, out)
			}
		}
	}
}

// runJobWithHook is runJob with a hook that sees the job before the entrypoint starts.
func runJobWithHook(t *testing.T, k fakeplatform.Knobs, hook func(*fakeplatform.Job)) run {
	t.Helper()
	orig := newJobHook
	newJobHook = hook
	defer func() { newJobHook = orig }()
	return runJob(t, k, nil)
}

var newJobHook func(*fakeplatform.Job)

// AC4: the built binary, run as a real process: after its re-exec, its own environment no longer
// holds the claim token, and the job completes.
func TestBinaryBoot(t *testing.T) {
	t.Cleanup(func() { cleanup(t) })
	prepareRoot(t)
	// The environment path is Fly's (module README "Host profiles"): with no profile named, a Fly
	// signal makes it fly, so the binary runs with a world-open /.fly/api the guard then locks
	// (the shape of a Fly machine; TestFlyGuardLocks). Without one it exits 2:
	// TestBinaryBootNoProfile.
	worldSocket(t, "/.fly/api", 0o777)
	j := FP.NewJob(fakeplatform.Knobs{Prompt: "lifecycle", Deadline: 10 * time.Minute})
	boot := filepath.Join(cgroupRoot, "bin-boot")
	if err := os.Mkdir(boot, 0o755); err != nil {
		t.Fatal(err)
	}
	cgfd, err := syscall.Open(boot, syscall.O_DIRECTORY|syscall.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(cgfd)
	cmd := exec.Command(entrypoint)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "KETE_JOB_ID=" + j.ID, "KETE_JOB_PLATFORM_URL=https://" + fakeplatform.PlatformHost, "KETE_JOB_CLAIM_TOKEN=" + j.ClaimToken, "KETE_JOB_STORAGE_HOST=" + fakeplatform.StorageHost}
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: cgfd}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := strconv.Itoa(cmd.Process.Pid)
	sawRun := false
	waitFor(t, 30*time.Second, "the __run re-exec", func() bool {
		cmdline, _ := os.ReadFile("/proc/" + pid + "/cmdline")
		if !bytes.Contains(cmdline, []byte("__run")) {
			return false
		}
		sawRun = true
		env, err := os.ReadFile("/proc/" + pid + "/environ")
		if err != nil {
			t.Fatalf("environ: %v", err)
		}
		if bytes.Contains(env, []byte(j.ClaimToken)) || bytes.Contains(env, []byte("KETE_JOB_CLAIM_TOKEN")) {
			t.Fatal("the claim token is still in the entrypoint's environment after the re-exec")
		}
		return true
	})
	errc := make(chan error, 1)
	go func() { errc <- cmd.Wait() }()
	select {
	case err := <-errc:
		if err != nil {
			t.Fatalf("entrypoint: %v; stdout:\n%s", err, out.String())
		}
	case <-time.After(3 * time.Minute):
		_ = cmd.Process.Kill()
		t.Fatal("entrypoint did not finish")
	}
	if !sawRun {
		t.Fatal("never saw __run")
	}
	checkPhaseLines(t, out.String(), j)
	if res := resultOf(t); res["outcome"] != "completed" {
		t.Errorf("result = %v", res)
	}
	if pe := finishPushError(t); pe != "" {
		t.Errorf("push_error = %q", pe)
	}
	if _, ok := FP.Uploaded("bundle"); !ok {
		t.Error("no bundle")
	}
}

func lookupID(t *testing.T, file, name string) int {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		p := strings.Split(line, ":")
		if len(p) >= 3 && p[0] == name {
			n, _ := strconv.Atoi(p[2])
			return n
		}
	}
	t.Fatalf("%s not in %s", name, file)
	return 0
}
