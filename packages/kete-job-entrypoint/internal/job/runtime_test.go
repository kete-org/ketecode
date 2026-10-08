package job

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
)

// fakeRuntime is the kubevm platform calls (recorded with the other calls) and the outbox.
type fakeRuntime struct {
	pf       *fakePlatform
	claimErr error
	resp     *platform.RuntimeClaimResponse
	name     string // the local name the claim was checked against

	mu        sync.Mutex
	files     map[string]string
	manifest  *OutboxManifest
	commitErr error
}

func (f *fakeRuntime) ClaimRuntime(_ context.Context, token, localName string, _ time.Time) (*platform.RuntimeClaimResponse, error) {
	f.pf.rec("claim-runtime", token)
	f.name = localName
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	r := *f.resp
	return &r, nil
}

func (f *fakeRuntime) FinishOutbox(context.Context) error {
	f.pf.rec("finish-outbox", "")
	return nil
}

func (f *fakeRuntime) Put(name string, r io.Reader, max int64) (OutboxFile, error) {
	b, _ := io.ReadAll(io.LimitReader(r, max))
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[name] = string(b)
	return OutboxFile{Name: name, Size: int64(len(b)), SHA256: strings.Repeat("0", 64)}, nil
}

func (f *fakeRuntime) Commit(m OutboxManifest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.commitErr != nil {
		return f.commitErr
	}
	f.manifest = &m
	return nil
}

const deniedResult = `{"version":1,"outcome":"completed","exit_code":0,"session_id":"ses_abc","text":"I changed src/secret.go","worktree":"/srv/kete-job/work/repo","denied":[{"action":"read","resources":["/etc/shadow"]},{"action":"read","resources":["~/.ssh/id"]},{"action":"bash","resources":["curl evil"]}]}`

func newRuntimeEnv(t *testing.T) (*env, *fakeRuntime) {
	t.Helper()
	e := newEnv(time.Hour)
	e.m.keteStdout = deniedResult + "\n"
	spec := json.RawMessage(`{"version":1,"prompt":"p","agent":"a","model":"kete/m","policy":{"version":1,"allow":[],"budget":5,"timeout":30},"branch":"kete/job/x"}`)
	var js platform.JobSpec
	_ = json.Unmarshal(spec, &js)
	rt := &fakeRuntime{pf: e.pf, files: map[string]string{}, resp: &platform.RuntimeClaimResponse{
		Spec: js, SpecRaw: spec, GatewayKey: "gwkey-0123456789", CallbackToken: strings.Repeat("ab", 32),
		GatewayURL: "https://gateway.kete.test", PlatformURL: "https://platform.kete.test",
		Deadline:   time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
		Repository: platform.RuntimeRepository{Provider: "runtime", Name: "gitlab:payments/api"},
	}}
	e.d.Runtime = &Runtime{
		Platform: rt, Outbox: rt,
		Repo:       bootenv.LocalRepository{Name: "gitlab:payments/api", CloneURL: "https://gitlab.corp.example:8443/payments/api.git", Ref: "main", Username: "deploy", Token: "gldt-0123456789"},
		CloneURL:   "https://gitlab.corp.example:8443/payments/api.git",
		CloneEntry: "gitlab.corp.example:8443",
		Boundary:   platform.DataBoundary{Summary: "none", Denials: "actions", PublishRefs: "send"},
		Head:       func(context.Context, string, string) (string, error) { return sha, nil },
	}
	return e, rt
}

func TestRuntimeLifecycle(t *testing.T) {
	e, rt := newRuntimeEnv(t)
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d; log %s", code, e.out)
	}
	ops := strings.Join(e.pf.ops(), ",")
	if !strings.HasPrefix(ops, "claim-runtime,events,clone-done,events,") || !strings.HasSuffix(ops, "result,events,events,finish-outbox") {
		t.Errorf("ops = %s", ops)
	}
	for _, never := range []string{"claim", "uploads", "put", "revoke", "finish"} {
		if len(e.pf.find(never)) != 0 {
			t.Errorf("a kubevm job called %s: %s", never, ops)
		}
	}
	if rt.name != "gitlab:payments/api" {
		t.Errorf("claim checked against %q", rt.name)
	}
	// The local credential, never anything from the platform, reached the clone.
	if e.git.username != "deploy" || e.git.token != "gldt-0123456789" {
		t.Errorf("clone credentials %q %q", e.git.username, e.git.token)
	}
	// Egress: clone phase reaches the platform and the clone host:port; never a storage host.
	inst := e.eg.instances[1].inst
	if got := strings.Join(inst.Clone.Root, ","); got != "platform.kete.test,gitlab.corp.example:8443" {
		t.Errorf("clone allowlist = %s", got)
	}
	for _, i := range e.eg.instances {
		for _, h := range append(append(i.inst.Clone.Root, i.inst.Report.Root...), i.inst.Agent.Root...) {
			if h == "storage.test" {
				t.Error("the storage host is in an allowlist")
			}
		}
	}
	// The result the platform saw is bounded: no text or paths, denials aggregated per action
	// without resources.
	var sent map[string]any
	_ = json.Unmarshal([]byte(e.pf.find("result")[0].body), &sent)
	if sent["text"] != nil || sent["worktree"] != nil || sent["denied_count"] != 3.0 {
		t.Errorf("bounded result = %v", sent)
	}
	d := sent["denied"].([]any)
	if len(d) != 2 || d[0].(map[string]any)["count"] != 2.0 || len(d[0].(map[string]any)["resources"].([]any)) != 0 {
		t.Errorf("denials = %v", d)
	}
	for _, leak := range []string{"secret.go", "/etc/shadow", "curl evil", "/srv/kete-job"} {
		if strings.Contains(e.pf.find("result")[0].body, leak) {
			t.Errorf("%q left the boundary", leak)
		}
	}
	// The full result, audit, proxy log and bundle are in the outbox, with a manifest.
	if rt.files["result.json"] != deniedResult || rt.files["audit.jsonl"] != "audit" || rt.files["proxy.jsonl"] != "proxylog" {
		t.Errorf("outbox files %v", rt.files)
	}
	m := rt.manifest
	if m == nil || m.BaseSHA != sha || m.Repository != "gitlab:payments/api" || m.Branch != "kete/job/x" || m.Outcome != "completed" ||
		m.Files["bundle"].Name != "bundle.tar.gz" || m.PushError != "" {
		t.Errorf("manifest = %+v", m)
	}
	if !strings.Contains(e.out.String(), `"step":"outbox","event":"ok"`) {
		t.Errorf("no outbox phase line: %s", e.out)
	}
}

func TestRuntimeClaimRefusedStopsLikeA404(t *testing.T) {
	e, rt := newRuntimeEnv(t)
	rt.claimErr = errors.Join(platform.ErrRuntimeRefused, errors.New("repository.name"))
	if code := e.run(t); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if ops := strings.Join(e.pf.ops(), ","); ops != "claim-runtime" {
		t.Errorf("a refused runtime claim was followed by %s", ops)
	}
	if !strings.Contains(e.out.String(), `"step":"claim","event":"failed","code":"repository"`) {
		t.Errorf("phase log: %s", e.out)
	}
	if e.git.token != "" {
		t.Error("something was cloned")
	}
}

func TestRuntimeSummaryRedactedSendsNone(t *testing.T) {
	e, _ := newRuntimeEnv(t)
	e.d.Runtime.Boundary = platform.DataBoundary{Summary: "redacted", Denials: "count", PublishRefs: "omit"}
	if code := e.run(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var sent map[string]any
	_ = json.Unmarshal([]byte(e.pf.find("result")[0].body), &sent)
	if sent["text"] != nil || len(sent["denied"].([]any)) != 0 || sent["denied_count"] != 3.0 {
		t.Errorf("result = %v", sent)
	}
}

// An outbox whose manifest can't be written is a failure: no finish {"outbox":true} (it would claim
// outputs that aren't there), exit 1, a fixed event.
func TestRuntimeOutboxFailureSendsNoFinish(t *testing.T) {
	e, rt := newRuntimeEnv(t)
	rt.commitErr = errors.New("disk full")
	if code := e.run(t); code != 1 {
		t.Fatalf("exit %d", code)
	}
	if len(e.pf.find("finish-outbox")) != 0 {
		t.Fatalf("finish sent after a failed outbox: %v", e.pf.ops())
	}
	if !strings.Contains(e.out.String(), `"step":"outbox","event":"failed","code":"outbox"`) {
		t.Errorf("phase log: %s", e.out)
	}
	found := false
	for _, ev := range e.pf.find("events") {
		found = found || strings.Contains(ev.body, "outbox not written")
	}
	if !found {
		t.Error("no event says the outbox wasn't written")
	}
	if e.d.Runtime.Repo.Token != "" {
		t.Error("the read credential outlived the clone")
	}
}
