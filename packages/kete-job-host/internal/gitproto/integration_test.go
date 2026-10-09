package gitproto

import (
	"context"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// backend serves root's bare repositories with git http-backend behind basic auth u:p.
func backend(t *testing.T, root string) *httptest.Server {
	t.Helper()
	needGit(t)
	out, err := exec.Command("git", "--exec-path").Output()
	if err != nil {
		t.Skip("git --exec-path failed")
	}
	path := filepath.Join(strings.TrimSpace(string(out)), "git-http-backend")
	if _, err := os.Stat(path); err != nil {
		t.Skip("git-http-backend not available")
	}
	h := &cgi.Handler{Path: path, Env: []string{
		"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "HOME=" + root,
		"PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
	}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "u" || p != "p" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/redirect/repo.git/info/refs" {
			http.Redirect(w, r, "/repo.git/info/refs?"+r.URL.RawQuery, http.StatusFound)
			return
		}
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// fixture builds root/repo.git with nested directories over several commits, repacked with deltas.
// It returns the bare path and the commits, oldest first.
func fixture(t *testing.T, root string) (string, []string) {
	work := filepath.Join(root, "work")
	git(t, root, nil, "init", "-q", work)
	var commits []string
	for i := range 6 {
		for _, p := range []string{"src/sub/b.go", "src/a.go", "docs/deep/x.md", "README"} {
			full := filepath.Join(work, p)
			_ = os.MkdirAll(filepath.Dir(full), 0o755)
			content := strings.Repeat(p+" line\n", 50) + strings.Repeat("v", i) + "\n"
			if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		_ = os.WriteFile(filepath.Join(work, "src", "f"+string(rune('a'+i))), []byte("x\n"), 0o644)
		git(t, work, nil, "add", "-A")
		git(t, work, nil, "commit", "-q", "-m", "c")
		commits = append(commits, git(t, work, nil, "rev-parse", "HEAD"))
	}
	bare := filepath.Join(root, "repo.git")
	git(t, root, nil, "clone", "-q", "--bare", work, bare)
	git(t, bare, nil, "repack", "-adfq", "--depth=10", "--window=50")
	git(t, bare, nil, "config", "http.receivepack", "true")
	return bare, commits
}

func TestSmartHTTP(t *testing.T) {
	root := t.TempDir()
	bare, commits := fixture(t, root)
	srv := backend(t, root)
	ctx := context.Background()
	ep := Endpoint{URL: srv.URL + "/repo.git", Username: "u", Password: "p", Timeout: 30 * time.Second}

	// Without allowFilter the server lacks fetch filter: unsupported (no fallback).
	if _, err := FetchBase(ctx, ep, commits[1], BasePackLimits); ErrorCode(err) != CodeUnsupported {
		t.Fatalf("no filter: %v", err)
	}
	git(t, bare, nil, "config", "uploadpack.allowFilter", "true")

	// Finding: a want for a reachable non-tip commit without uploadpack.allowAnySHA1InWant.
	_, err := FetchBase(ctx, ep, commits[1], BasePackLimits)
	t.Logf("FINDING: v2 want of a non-tip reachable SHA without allowAnySHA1InWant: err=%v", err)
	git(t, bare, nil, "config", "uploadpack.allowAnySHA1InWant", "true")

	base := commits[1]
	bf, err := FetchBase(ctx, ep, base, BasePackLimits)
	if err != nil {
		t.Fatal(err)
	}
	if bf.Tree != git(t, bare, nil, "rev-parse", base+"^{tree}") || len(bf.Parents) != 1 || bf.Parents[0] != commits[0] {
		t.Fatalf("base %+v", bf.Tree)
	}
	for _, o := range bf.Objects {
		if o.Type == "blob" {
			t.Fatal("blob:none sent a blob")
		}
	}
	// Listings along every directory, from the fetched trees only.
	listings := map[string][]TreeEntry{}
	var walk func(path, sha string)
	walk = func(path, sha string) {
		o, ok := bf.Objects[sha]
		if !ok || o.Type != "tree" {
			t.Fatalf("tree %s missing", path)
		}
		items, ok := ParseCanonicalTree(o.Data)
		if !ok {
			t.Fatalf("tree %s not canonical", path)
		}
		listings[path] = items
		for _, e := range items {
			if e.Mode == "40000" {
				p := e.Name
				if path != "" {
					p = path + "/" + e.Name
				}
				walk(p, e.SHA)
			}
		}
	}
	walk("", bf.Tree)

	refs, err := LsRefs(ctx, ep, "refs/heads/")
	if err != nil || refs["refs/heads/main"] != commits[len(commits)-1] {
		t.Fatalf("ls-refs %v %v", refs, err)
	}

	// Build one commit on the base: an edit, a deletion, a new nested file.
	newBlob := []byte("edited\n")
	addBlob := []byte("added\n")
	changes := []Change{
		{Path: "src/sub/b.go", Mode: "100644", BlobSHA: ObjectID("blob", newBlob)},
		{Path: "docs/deep/x.md", Deleted: true},
		{Path: "new/dir/f.txt", Mode: "100755", BlobSHA: ObjectID("blob", addBlob)},
	}
	rootSHA, trees := ResultTrees(listings, changes)
	objs := []Object{{"blob", newBlob}, {"blob", addBlob}}
	for _, tr := range trees {
		objs = append(objs, Object{"tree", TreeBody(tr.Items)})
	}
	commit := CommitObject(rootSHA, base, "Kete Code <jobs@noreply.ketecode.ai>", time.Unix(1700000000, 0), "Kete job 12345678 [skip ci]\n\nJob: x")
	commitID := ObjectID("commit", commit)
	objs = append(objs, Object{"commit", commit})
	pack := WritePack(objs)

	adv, err := ReceivePackRefs(ctx, ep)
	if err != nil || adv.Refs["refs/heads/main"] == "" || !has(adv.Capabilities, "report-status") {
		t.Fatalf("receive-pack refs %+v %v", adv, err)
	}
	ref := "refs/heads/kete/job/abc"
	if out := PushCreateRef(ctx, ep, ref, commitID, pack, adv); out.Status != PushCreated {
		t.Fatalf("push %+v", out)
	}
	if got := git(t, bare, nil, "rev-parse", ref); got != commitID {
		t.Fatalf("ref %s", got)
	}
	if got := git(t, bare, nil, "rev-parse", ref+"^{tree}"); got != rootSHA {
		t.Fatalf("tree %s vs %s", got, rootSHA)
	}
	git(t, bare, nil, "fsck", "--no-progress")
	if got := git(t, bare, nil, "show", ref+":new/dir/f.txt"); got != "added" {
		t.Fatalf("content %q", got)
	}

	// Again: the advertisement names the ref.
	fresh, _ := ReceivePackRefs(ctx, ep)
	if out := PushCreateRef(ctx, ep, ref, commitID, pack, fresh); out.Status != PushBranchExists {
		t.Fatalf("advertised: %+v", out)
	}
	// With the stale advertisement the server refuses the zero-old command itself.
	other := CommitObject(rootSHA, base, "Kete Code <jobs@noreply.ketecode.ai>", time.Unix(1700000001, 0), "other")
	pack2 := WritePack(append(objs[:len(objs)-1:len(objs)-1], Object{"commit", other}))
	out := PushCreateRef(ctx, ep, ref, ObjectID("commit", other), pack2, adv)
	t.Logf("FINDING: server answer to a zero-old command on an existing ref: %+v", out)
	if out.Status != PushBranchExists && out.Status != PushUnknown {
		t.Fatalf("stale advertisement: %+v", out)
	}
	if got := git(t, bare, nil, "rev-parse", ref); got != commitID {
		t.Fatal("the existing ref was overwritten")
	}

	// A pre-receive hook that refuses.
	hook := filepath.Join(bare, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\necho 'GL-HOOK-ERR: protected by policy' >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if out := PushCreateRef(ctx, ep, "refs/heads/kete/job/hooked", commitID, pack, fresh); out.Status != PushRuleViolation {
		t.Fatalf("hook: %+v", out)
	}

	// Credentials, redirects, missing base, bad inputs.
	bad := ep
	bad.Password = "wrong"
	if _, err := ReceivePackRefs(ctx, bad); ErrorCode(err) != CodeUnauthorized || strings.Contains(err.Error(), "wrong") {
		t.Errorf("unauthorized: %v", err)
	}
	redir := ep
	redir.URL = srv.URL + "/redirect/repo.git"
	if _, err := LsRefs(ctx, redir, "refs/heads/"); ErrorCode(err) != CodeUnavailable {
		t.Errorf("redirect followed: %v", err)
	}
	if _, err := FetchBase(ctx, ep, strings.Repeat("e", 40), BasePackLimits); ErrorCode(err) != CodeBaseNotFound {
		t.Errorf("missing base: %v", err)
	}
	if _, err := FetchBase(ctx, ep, "HEAD", BasePackLimits); ErrorCode(err) != CodeInvalidResponse {
		t.Errorf("bad sha: %v", err)
	}
	if out := PushCreateRef(ctx, ep, "refs/tags/x", commitID, pack, fresh); out.Status != PushFailed || out.Code != "invalid_request" {
		t.Errorf("tag ref: %+v", out)
	}
	small := BasePackLimits
	small.MaxPackBytes = 64
	if _, err := FetchBase(ctx, ep, base, small); ErrorCode(err) != CodeTooLarge {
		t.Errorf("pack cap: %v", err)
	}
	missing := ep
	missing.URL = srv.URL + "/nope.git"
	if _, err := LsRefs(ctx, missing, "refs/heads/"); ErrorCode(err) != CodeNotFound {
		t.Errorf("missing repo: %v", err)
	}
}

func TestNoAnySHA1InWantFinding(t *testing.T) {
	root := t.TempDir()
	bare, commits := fixture(t, root)
	git(t, bare, nil, "config", "uploadpack.allowFilter", "true")
	srv := backend(t, root)
	ep := Endpoint{URL: srv.URL + "/repo.git", Username: "u", Password: "p"}
	_, errOld := FetchBase(context.Background(), ep, commits[0], BasePackLimits)
	_, errTip := FetchBase(context.Background(), ep, commits[len(commits)-1], BasePackLimits)
	t.Logf("FINDING (defaults + allowFilter): non-tip reachable want err=%v; tip want err=%v", errOld, errTip)
	if errTip != nil {
		t.Fatalf("tip fetch: %v", errTip)
	}
}
