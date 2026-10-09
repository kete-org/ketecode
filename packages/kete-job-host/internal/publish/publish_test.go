package publish

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakegitlab"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/repo/gitlab"
)

const (
	project  = "payments/api"
	repoName = "gitlab:payments/api"
	writer   = "glpat-writer0000000000000000000000"
	jobID    = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"
	branch   = "kete/job/0a1b2c3d"
)

type file struct {
	path, mode, data string
	deleted          bool
	tarType          byte
}

// makeBundle builds a bundle as the entrypoint writes it: manifest.json, then files/<path>.
func makeBundle(t *testing.T, files []file) []byte {
	t.Helper()
	var manifest []map[string]any
	for _, f := range files {
		if f.deleted {
			manifest = append(manifest, map[string]any{"path": f.path, "deleted": true})
		} else {
			manifest = append(manifest, map[string]any{"path": f.path, "mode": f.mode})
		}
	}
	if manifest == nil {
		manifest = []map[string]any{}
	}
	mj, _ := json.Marshal(manifest)
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	add := func(name string, typ byte, data []byte, link string) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), Typeflag: typ, Linkname: link, Format: tar.FormatUSTAR}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write(data)
	}
	add("manifest.json", tar.TypeReg, mj, "")
	for _, f := range files {
		switch {
		case f.deleted:
		case f.tarType == tar.TypeSymlink:
			add("files/"+f.path, tar.TypeSymlink, nil, "/etc/passwd")
		default:
			add("files/"+f.path, tar.TypeReg, []byte(f.data), "")
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

// outbox writes an outbox as the entrypoint does (manifest last) and returns its directory.
func outbox(t *testing.T, base string, bundle []byte, edit func(*Manifest)) string {
	t.Helper()
	dir := t.TempDir()
	m := Manifest{Version: 1, JobID: jobID, Repository: repoName, Ref: "main", BaseSHA: base, Branch: branch, Outcome: "completed",
		Files: map[string]ManifestFile{}, Notes: []string{}, WrittenAt: "2026-10-09T10:00:00Z"}
	if bundle != nil {
		sum := sha256.Sum256(bundle)
		m.Files["bundle"] = ManifestFile{Name: "bundle.tar.gz", Size: int64(len(bundle)), SHA256: hex.EncodeToString(sum[:])}
		if err := os.WriteFile(filepath.Join(dir, "bundle.tar.gz"), bundle, 0o640); err != nil {
			t.Fatal(err)
		}
	}
	if edit != nil {
		edit(&m)
	}
	b, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), b, 0o640); err != nil {
		t.Fatal(err)
	}
	return dir
}

type world struct {
	gl    *fakegitlab.Server
	base  string
	opts  Options
	cfg   Config
	srv   *httptest.Server
	clone string
}

func newWorld(t *testing.T) *world {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is required (git http-backend)")
	}
	gl, err := fakegitlab.New("example.com", t.TempDir())
	if err != nil {
		t.Skip(err)
	}
	if _, err := gl.AddProject(project, map[string]string{"README.md": "# api\n", "src/main.go": "package main\n", "docs/a.md": "a\n"}, ""); err != nil {
		t.Fatal(err)
	}
	gl.SetWriter("kete-bot", writer)
	srv := httptest.NewTLSServer(gl)
	t.Cleanup(srv.Close)
	tr := srv.Client().Transport.(*http.Transport).Clone()
	addr := srv.Listener.Addr().String()
	tr.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	}
	clone := "https://example.com/" + project + ".git"
	cfg, err := ParseConfig([]byte(`{"platform_url":"https://portal.kete.example","repositories":[{"name":"` + repoName + `","clone_url":"` + clone + `","writer_secret":"gitlab-writer","username":"kete-bot"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	wd := t.TempDir()
	_ = os.MkdirAll(filepath.Join(wd, "gitlab-writer"), 0o755)
	_ = os.WriteFile(filepath.Join(wd, "gitlab-writer", "token"), []byte(writer+"\n"), 0o440)
	w := &world{gl: gl, srv: srv, cfg: cfg, clone: clone}
	w.base = w.head(t, "main")
	w.opts = Options{Config: cfg, WriterDir: wd, HTTP: gitlab.NewHTTPClient(tr), Log: slog.New(slog.DiscardHandler), Retry: time.Millisecond,
		Now: func() time.Time { return time.Date(2026, 10, 9, 10, 0, 0, 0, time.UTC) }}
	return w
}

func (w *world) head(t *testing.T, b string) string {
	for _, l := range w.gl.State().Branches[project] {
		if name, sha, _ := strings.Cut(l, " "); name == b {
			return sha
		}
	}
	return ""
}

func (w *world) run(t *testing.T, dir string, openMR bool) contract.PublishOutcome {
	t.Helper()
	o := w.opts
	o.OutboxDir = dir
	return Run(context.Background(), o, Request{MachineID: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", JobID: jobID, Repository: repoName, BaseRef: "main", Branch: branch, OpenMR: openMR})
}

func TestPublishCreatesBranchAndDraftMR(t *testing.T) {
	w := newWorld(t)
	b := makeBundle(t, []file{{path: "README.md", mode: "100644", data: "# api, edited\n"}, {path: "tools/run.sh", mode: "100755", data: "#!/bin/sh\n"}, {path: "docs/a.md", deleted: true}})
	out := w.run(t, outbox(t, w.base, b, nil), true)
	if out.Status != contract.PublishCreated || out.Reason != "" || out.BaseSHA != w.base || out.MR == nil || out.MR.IID != 1 || out.Validate() != nil {
		t.Fatalf("outcome %+v", out)
	}
	if got := w.head(t, branch); got != out.CommitSHA {
		t.Fatalf("branch at %s, outcome %s", got, out.CommitSHA)
	}
	if c, _ := w.gl.File(project, branch, "README.md"); c != "# api, edited" {
		t.Errorf("README %q", c)
	}
	if _, err := w.gl.File(project, branch, "docs/a.md"); err == nil {
		t.Error("the deletion wasn't applied")
	}
	if c, _ := w.gl.File(project, branch, "src/main.go"); c != "package main" {
		t.Error("an untouched file changed")
	}
	st := w.gl.State()
	var line string
	for _, l := range st.Commits[project] {
		if strings.HasPrefix(l, out.CommitSHA) {
			line = l
		}
	}
	if !strings.Contains(line, " "+w.base+" ") || !strings.Contains(line, "[skip ci]") {
		t.Errorf("commit %q: one parent, the base, and [skip ci]", line)
	}
	mr := st.MergeRequests[0]
	if mr.Source != branch || mr.Target != "main" || !strings.HasPrefix(mr.Title, "Draft: Kete job 5e6f7a8b") || !strings.Contains(mr.Description, "https://portal.kete.example/jobs/"+jobID) {
		t.Errorf("merge request %+v", mr)
	}
	// The same publish again (an outcome lost): the branch already holds exactly this commit →
	// created, the same merge request, nothing pushed or opened twice.
	again := w.run(t, outbox(t, w.base, b, nil), true)
	if again.Status != contract.PublishCreated || again.CommitSHA != out.CommitSHA || again.MR == nil || again.MR.IID != 1 || len(w.gl.State().MergeRequests) != 1 {
		t.Fatalf("second run %+v", again)
	}
	// Another change for the same branch: it exists with another commit (create-only, never moved).
	other := w.run(t, outbox(t, w.base, makeBundle(t, []file{{path: "README.md", mode: "100644", data: "other\n"}}), nil), true)
	if other.Status != contract.PublishRefused || other.Reason != "branch_exists" || w.head(t, branch) != out.CommitSHA {
		t.Fatalf("third run %+v", other)
	}
}

func TestPublishRefusals(t *testing.T) {
	good := []file{{path: "README.md", mode: "100644", data: "changed\n"}}
	for _, tc := range []struct {
		name   string
		files  []file
		edit   func(*Manifest)
		setup  func(*world)
		status string
		reason string
	}{
		{name: "protected path", files: []file{{path: ".gitlab-ci.yml", mode: "100644", data: "x: 1\n"}}, status: "refused", reason: "bundle_invalid"},
		{name: "symlink entry", files: []file{{path: "link", mode: "100644", tarType: tar.TypeSymlink}}, status: "refused", reason: "bundle_invalid"},
		{name: "secret shape", files: []file{{path: "a.txt", mode: "100644", data: "token glpat-abcdefghijklmnopqrstuvwxyz\n"}}, status: "refused", reason: "bundle_invalid"},
		{name: "path under a base file", files: []file{{path: "README.md/x", mode: "100644", data: "x"}}, status: "refused", reason: "bundle_invalid"},
		{name: "deleting a directory", files: []file{{path: "src", deleted: true}}, status: "refused", reason: "bundle_invalid"},
		{name: "case collision with the base", files: []file{{path: "readme.md", mode: "100644", data: "x"}}, status: "refused", reason: "bundle_invalid"},
		{name: "unprotected base", files: good, setup: func(w *world) { w.gl.Protect(project, "main", false, true) }, status: "refused", reason: "base_unprotected"},
		{name: "writer may push the base", files: good, setup: func(w *world) { w.gl.Protect(project, "main", true, true) }, status: "refused", reason: "base_unprotected"},
		{name: "branch exists", files: good, setup: func(w *world) { _ = w.gl.CreateBranch(project, branch, "main") }, status: "refused", reason: "branch_exists"},
		{name: "server rule", files: good, setup: func(w *world) { _ = w.gl.RejectPushes(project, true) }, status: "refused", reason: "push_rejected"},
		{name: "entrypoint symlink", files: good, edit: func(m *Manifest) { m.PushError = "symlink" }, status: "refused", reason: "symlink"},
		{name: "entrypoint proxy failure", files: good, edit: func(m *Manifest) { m.PushError = "proxy_failed" }, status: "failed", reason: "proxy_failed"},
		{name: "manifest of another job", files: good, edit: func(m *Manifest) { m.JobID = "5e6f7a8b-9c0d-4e1f-8a2b-000000000000" }, status: "failed", reason: "publisher_failed"},
		{name: "bundle digest mismatch", files: good, edit: func(m *Manifest) { f := m.Files["bundle"]; f.SHA256 = strings.Repeat("0", 64); m.Files["bundle"] = f }, status: "refused", reason: "bundle_invalid"},
		{name: "no bundle", files: good, edit: func(m *Manifest) { delete(m.Files, "bundle") }, status: "refused", reason: "unreadable"},
		{name: "base not in the repository", files: good, edit: func(m *Manifest) { m.BaseSHA = strings.Repeat("ab", 20) }, status: "failed", reason: "provider_error"},
		{name: "a .gitlab/ path", files: []file{{path: ".gitlab/issue_templates/x.md", mode: "100644", data: "x"}}, status: "refused", reason: "bundle_invalid"},
		{name: "the custom CI configuration", files: []file{{path: "ci/Pipeline.yml", mode: "100644", data: "x: 1\n"}}, setup: func(w *world) { w.gl.SetCIConfigPath(project, "ci/pipeline.yml") }, status: "refused", reason: "bundle_invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld(t)
			if tc.setup != nil {
				tc.setup(w)
			}
			out := w.run(t, outbox(t, w.base, makeBundle(t, tc.files), tc.edit), true)
			if out.Status != tc.status || out.Reason != tc.reason || out.Validate() != nil {
				t.Fatalf("outcome %+v, want %s/%s", out, tc.status, tc.reason)
			}
			if tc.reason != "branch_exists" && w.head(t, branch) != "" {
				t.Fatal("a refused publish created the branch")
			}
		})
	}
}

func TestPublishBaseSymlinkAndNoChanges(t *testing.T) {
	w := newWorld(t)
	// No changes at all, and changes that leave the tree as it is.
	if out := w.run(t, outbox(t, w.base, makeBundle(t, nil), nil), true); out.Status != contract.PublishNoChanges {
		t.Fatalf("empty bundle: %+v", out)
	}
	same := makeBundle(t, []file{{path: "README.md", mode: "100644", data: "# api\n"}})
	if out := w.run(t, outbox(t, w.base, same, nil), true); out.Status != contract.PublishNoChanges {
		t.Fatalf("same content: %+v", out)
	}
	// A base that is an ancestor of main (main moved on) is accepted; a commit elsewhere isn't.
	old := w.base
	if err := w.gl.CreateBranch(project, "side", "main"); err != nil {
		t.Fatal(err)
	}
	side, err := w.gl.CommitFile(project, "side", "side.txt", "s\n")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.gl.CommitFile(project, "main", "moved.txt", "m\n"); err != nil {
		t.Fatal(err)
	}
	if out := w.run(t, outbox(t, side, makeBundle(t, []file{{path: "new.txt", mode: "100644", data: "n\n"}}), nil), false); out.Status != contract.PublishFailed || out.Reason != "provider_error" {
		t.Fatalf("a base off main: %+v", out)
	}
	out := w.run(t, outbox(t, old, makeBundle(t, []file{{path: "new.txt", mode: "100644", data: "n\n"}}), nil), false)
	if out.Status != contract.PublishCreated || out.MR != nil || out.BaseSHA != old {
		t.Fatalf("ancestor base: %+v", out)
	}
	if c, _ := w.gl.File(project, branch, "moved.txt"); c != "" {
		t.Fatal("the commit wasn't built on the recorded base")
	}
}

// The controller's resolved base binds the job's recorded one; a FIFO in the outbox is refused at
// once instead of blocking the publisher.
func TestPublishBaseSHAAndFIFO(t *testing.T) {
	w := newWorld(t)
	o := w.opts
	o.OutboxDir = outbox(t, w.base, makeBundle(t, []file{{path: "a.txt", mode: "100644", data: "a\n"}}), nil)
	req := Request{MachineID: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", JobID: jobID, Repository: repoName, BaseRef: "main", Branch: branch, BaseSHA: strings.Repeat("c", 40)}
	if out := Run(context.Background(), o, req); out.Status != contract.PublishFailed || out.Reason != "provider_error" {
		t.Fatalf("another base: %+v", out)
	}
	req.BaseSHA = w.base
	if out := Run(context.Background(), o, req); out.Status != contract.PublishCreated {
		t.Fatalf("the resolved base: %+v", out)
	}
	dir := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(dir, "manifest.json"), 0o640); err != nil {
		t.Skip(err)
	}
	done := make(chan contract.PublishOutcome, 1)
	go func() { done <- w.run(t, dir, true) }()
	select {
	case out := <-done:
		if out.Status != contract.PublishFailed || out.Reason != "publisher_failed" {
			t.Fatalf("fifo: %+v", out)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a FIFO blocked the publisher")
	}
}

// A merge request someone else opened from the same branch name (a fork's, another user's, or not
// a draft) is never reported as the job's: the publisher opens its own.
func TestPublishIgnoresSpoofedMergeRequests(t *testing.T) {
	w := newWorld(t)
	pid := w.gl.State().Projects[project].ID
	w.gl.AddMergeRequest(project, branch, "main", pid+1000, fakegitlab.WriterID, true) // from a fork
	w.gl.AddMergeRequest(project, branch, "main", pid, 99, true)                       // another user
	w.gl.AddMergeRequest(project, branch, "other", pid, fakegitlab.WriterID, true)     // another target
	w.gl.AddMergeRequest(project, branch, "main", pid, fakegitlab.WriterID, false)     // not a draft
	out := w.run(t, outbox(t, w.base, makeBundle(t, []file{{path: "README.md", mode: "100644", data: "x\n"}}), nil), true)
	if out.Status != contract.PublishCreated || out.MR == nil || out.MR.IID != 5 {
		t.Fatalf("%+v", out)
	}
}

func TestPublishGitLabUnavailable(t *testing.T) {
	w := newWorld(t)
	w.srv.Close()
	out := w.run(t, outbox(t, w.base, makeBundle(t, []file{{path: "a", mode: "100644", data: "a"}}), nil), true)
	if out.Status != contract.PublishFailed || out.Reason != "provider_unavailable" {
		t.Fatalf("%+v", out)
	}
}

func TestPublishNeverLogsTheWriter(t *testing.T) {
	w := newWorld(t)
	var buf bytes.Buffer
	w.opts.Log = slog.New(slog.NewJSONHandler(&buf, nil))
	_ = w.run(t, outbox(t, w.base, makeBundle(t, []file{{path: "README.md", mode: "100644", data: "x"}}), nil), true)
	w.gl.Protect(project, "main", false, true)
	_ = w.run(t, outbox(t, w.base, makeBundle(t, []file{{path: "README.md", mode: "100644", data: "y"}}), nil), true)
	if strings.Contains(buf.String(), writer) || strings.Contains(buf.String(), "glpat-") {
		t.Fatal("the writer token reached the log")
	}
}

func TestParseConfig(t *testing.T) {
	ok := `{"platform_url":"https://portal.kete.example","repositories":[{"name":"gitlab:a/b","clone_url":"https://gitlab.corp.example/gitlab/a/b.git","api_url":"https://gitlab.corp.example/gitlab","writer_secret":"w"}],"proxy":"http://10.0.0.5:3128","no_proxy":[".corp.example"]}`
	c, err := ParseConfig([]byte(ok))
	if err != nil || c.Repos["gitlab:a/b"].Project != "a/b" || c.Repos["gitlab:a/b"].APIBase != "https://gitlab.corp.example/gitlab" || c.Identity != DefaultIdentity {
		t.Fatalf("%+v %v", c, err)
	}
	for name, bad := range map[string]string{
		"unknown field":   strings.Replace(ok, `"proxy"`, `"proxi"`, 1),
		"http clone":      strings.Replace(ok, `https://gitlab.corp.example/gitlab/a/b.git`, `http://gitlab.corp.example/gitlab/a/b.git`, 1),
		"userinfo":        strings.Replace(ok, `https://gitlab.corp.example/gitlab/a/b.git`, `https://u:p@gitlab.corp.example/gitlab/a/b.git`, 1),
		"other api host":  strings.Replace(ok, `"api_url":"https://gitlab.corp.example/gitlab"`, `"api_url":"https://evil.example/gitlab"`, 1),
		"no writer":       strings.Replace(ok, `,"writer_secret":"w"`, ``, 1),
		"proxy with user": strings.Replace(ok, `http://10.0.0.5:3128`, `http://u:p@10.0.0.5:3128`, 1),
		"bad identity":    strings.Replace(ok, `"no_proxy"`, `"commit_identity":"evil\nx <a@b>","no_proxy"`, 1),
		"trailing data":   ok + "{}",
	} {
		if _, err := ParseConfig([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
