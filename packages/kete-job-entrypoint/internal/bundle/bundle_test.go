//go:build linux

package bundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/gitops"
)

var testLimits = Limits{MaxFile: 1_000_000, MaxBinaryFile: 256_000, MaxBinaries: 50, MaxEntries: 1000, MaxTar: 20_000_000, MaxGzip: 10_000_000, MaxUntracked: 100_000}

type fixture struct {
	t        *testing.T
	root     string
	pristine string
	parent   string
	repo     string
	sha      string
	gitLog   string
	runner   gitops.Runner
	marker   string
}

func sh(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t", "GIT_CONFIG_NOSYSTEM=1", "HOME="+dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, path string, data string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	f := &fixture{t: t, root: root, pristine: filepath.Join(root, "pristine.git"), parent: filepath.Join(root, "work"), marker: filepath.Join(root, "MARKER")}
	f.repo = filepath.Join(f.parent, "repo")
	src := filepath.Join(root, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	sh(t, src, "init", "-q", "-b", "main")
	write(t, filepath.Join(src, "README.md"), "hello\n", 0o644)
	write(t, filepath.Join(src, "src/app.txt"), "app\n", 0o644)
	write(t, filepath.Join(src, "run.sh"), "#!/bin/sh\necho hi\n", 0o755)
	write(t, filepath.Join(src, ".gitignore"), "*.log\n", 0o644)
	write(t, filepath.Join(src, "big.bin"), strings.Repeat("\x00x", 1<<20), 0o644) // a large unchanged file
	if err := os.Symlink("README.md", filepath.Join(src, "link")); err != nil {
		t.Fatal(err)
	}
	sh(t, src, "add", "-A")
	sh(t, src, "commit", "-q", "-m", "base")
	f.sha = sh(t, src, "rev-parse", "HEAD")
	sh(t, root, "clone", "-q", "--bare", src, f.pristine)
	if err := os.Mkdir(f.parent, 0o755); err != nil {
		t.Fatal(err)
	}
	sh(t, root, "clone", "-q", f.pristine, f.repo)
	// A hostile worktree config: if git ever read it, the fsmonitor or a hook would create MARKER.
	hook := "#!/bin/sh\ntouch " + f.marker + "\n"
	write(t, filepath.Join(f.repo, ".git/hooks/post-checkout"), hook, 0o755)
	write(t, filepath.Join(f.repo, ".git/hooks/fsmonitor"), hook, 0o755)
	cfg, _ := os.ReadFile(filepath.Join(f.repo, ".git/config"))
	write(t, filepath.Join(f.repo, ".git/config"), string(cfg)+"[core]\n\tfsmonitor = "+filepath.Join(f.repo, ".git/hooks/fsmonitor")+"\n\thooksPath = .git/hooks\n", 0o644)

	// A git wrapper that records every argv, so the test can check --git-dir on every call.
	f.gitLog = filepath.Join(root, "git.log")
	wrapper := filepath.Join(root, "git-wrapper")
	write(t, wrapper, "#!/bin/sh\necho \"$@\" >> "+f.gitLog+"\nexec /usr/bin/git \"$@\"\n", 0o755)
	f.runner = gitops.Runner{Git: wrapper, Home: root, ProxyURL: "http://127.0.0.1:1", CAPath: "/dev/null", Timeout: time.Minute, MaxStdout: 64 << 20, MaxStderr: 64 << 10}
	return f
}

func (f *fixture) build() (*Result, error) {
	return Build(context.Background(), Options{
		Git: f.runner, GitDir: f.pristine, WorkParent: f.parent, AnchorUID: uint32(os.Getuid()), RepoName: "repo",
		TmpDir: filepath.Join(f.root, "tmp"), BaseSHA: f.sha, Limits: testLimits,
	})
}

func (f *fixture) check() {
	f.t.Helper()
	if _, err := os.Stat(f.marker); err == nil {
		f.t.Fatal("git ran the worktree's hook or fsmonitor")
	}
	log, _ := os.ReadFile(f.gitLog)
	for _, line := range strings.Split(strings.TrimSpace(string(log)), "\n") {
		if line != "" && !strings.HasPrefix(line, "--git-dir="+f.pristine+" ") {
			f.t.Errorf("git call without the pristine --git-dir: %s", line)
		}
	}
}

type tarEntry struct {
	hdr  *tar.Header
	data []byte
}

func readBundle(t *testing.T, path string) ([]ManifestEntry, map[string]tarEntry, []string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	files := map[string]tarEntry{}
	var order []string
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(tr)
		files[h.Name] = tarEntry{h, data}
		order = append(order, h.Name)
	}
	var m []ManifestEntry
	if err := json.Unmarshal(files["manifest.json"].data, &m); err != nil {
		t.Fatalf("manifest: %v", err)
	}
	return m, files, order
}

func TestBundleChanges(t *testing.T) {
	f := newFixture(t)
	write(t, filepath.Join(f.repo, "README.md"), "hello, edited\n", 0o664)  // modified (g+w doesn't matter)
	write(t, filepath.Join(f.repo, "new/file.txt"), "new\n", 0o644)         // new
	write(t, filepath.Join(f.repo, "debug.log"), "ignored\n", 0o644)        // ignored
	if err := os.Remove(filepath.Join(f.repo, "src/app.txt")); err != nil { // deleted
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(f.repo, "run.sh"), 0o644); err != nil { // mode change only
		t.Fatal(err)
	}
	long := strings.Repeat("d", 120) + "/x.txt" // a path that needs PAX
	write(t, filepath.Join(f.repo, long), "long\n", 0o755)
	sh(t, f.repo, "init", "-q", "nested") // a nested repository
	write(t, filepath.Join(f.repo, "nested/inner.txt"), "x", 0o644)

	res, err := f.build()
	if err != nil {
		t.Fatal(err)
	}
	defer res.Cleanup()
	f.check()
	m, files, order := readBundle(t, res.Path)
	want := []ManifestEntry{
		{Path: "README.md", Mode: "100644"},
		{Path: long, Mode: "100755"},
		{Path: "new/file.txt", Mode: "100644"},
		{Path: "run.sh", Mode: "100644"},
		{Path: "src/app.txt", Deleted: true},
	}
	if len(m) != len(want) {
		t.Fatalf("manifest = %+v", m)
	}
	for i := range want {
		if m[i] != want[i] {
			t.Errorf("manifest[%d] = %+v, want %+v", i, m[i], want[i])
		}
	}
	if order[0] != "manifest.json" || len(order) != 5 {
		t.Errorf("tar order = %v", order)
	}
	if string(files["files/README.md"].data) != "hello, edited\n" {
		t.Errorf("README content = %q", files["files/README.md"].data)
	}
	if _, ok := files["files/src/app.txt"]; ok {
		t.Error("a deleted file has content")
	}
	if len(res.Notes) != 1 || !strings.Contains(res.Notes[0], "nested repository") {
		t.Errorf("notes = %v", res.Notes)
	}
	for name, e := range files {
		h := e.hdr
		if h.Typeflag != tar.TypeReg || h.Mode != 0o644 || h.Uid != 0 || h.Gid != 0 || h.Uname != "" || h.Gname != "" || !h.ModTime.Equal(time.Unix(0, 0)) || !h.AccessTime.IsZero() || !h.ChangeTime.IsZero() {
			t.Errorf("%s: header %+v", name, h)
		}
		if h.Format != tar.FormatUSTAR && h.Format != tar.FormatPAX {
			t.Errorf("%s: format %v", name, h.Format)
		}
		for k := range h.PAXRecords {
			if k != "path" {
				t.Errorf("%s: PAX record %q", name, k)
			}
		}
		if h.Format == tar.FormatPAX && name != "files/"+long {
			t.Errorf("%s: PAX without need", name)
		}
	}
}

func TestBundleNoChanges(t *testing.T) {
	f := newFixture(t)
	res, err := f.build()
	if err != nil {
		t.Fatal(err)
	}
	defer res.Cleanup()
	m, _, order := readBundle(t, res.Path)
	if len(m) != 0 || len(order) != 1 {
		t.Errorf("manifest = %v order = %v", m, order)
	}
	f.check()
}

func expectRefusal(t *testing.T, f *fixture, want Refusal) {
	t.Helper()
	_, err := f.build()
	kind, _, ok := AsRefusal(err)
	if !ok || kind != want {
		t.Fatalf("err = %v, want refusal %s", err, want)
	}
	f.check()
}

func TestBundleRefusesNewSymlink(t *testing.T) {
	f := newFixture(t)
	if err := os.Symlink("/etc/passwd", filepath.Join(f.repo, "evil")); err != nil {
		t.Fatal(err)
	}
	expectRefusal(t, f, RefuseSymlink)
}

func TestBundleRefusesSymlinkedTrackedFile(t *testing.T) {
	f := newFixture(t)
	p := filepath.Join(f.repo, "README.md")
	_ = os.Remove(p)
	if err := os.Symlink("/etc/passwd", p); err != nil {
		t.Fatal(err)
	}
	expectRefusal(t, f, RefuseSymlink)
}

func TestBundleRefusesSymlinkedComponent(t *testing.T) {
	f := newFixture(t)
	outside := filepath.Join(f.root, "outside")
	write(t, filepath.Join(outside, "app.txt"), "secret", 0o644)
	if err := os.RemoveAll(filepath.Join(f.repo, "src")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(f.repo, "src")); err != nil {
		t.Fatal(err)
	}
	expectRefusal(t, f, RefuseSymlink)
}

func TestBundleRefusesChangedBaseSymlink(t *testing.T) {
	f := newFixture(t)
	p := filepath.Join(f.repo, "link")
	_ = os.Remove(p)
	if err := os.Symlink("/etc/shadow", p); err != nil {
		t.Fatal(err)
	}
	expectRefusal(t, f, RefuseSymlink)

	f = newFixture(t)
	p = filepath.Join(f.repo, "link")
	_ = os.Remove(p)
	write(t, p, "now a file", 0o644)
	expectRefusal(t, f, RefuseSymlink)
}

// A FIFO in place of a tracked file is refused without blocking (O_NONBLOCK). An untracked FIFO is
// invisible to git (ls-files lists regular files and symlinks only), so it is never read and never
// bundled.
func TestBundleRefusesFIFO(t *testing.T) {
	f := newFixture(t)
	p := filepath.Join(f.repo, "README.md")
	_ = os.Remove(p)
	if err := syscall.Mkfifo(p, 0o644); err != nil {
		t.Fatal(err)
	}
	expectRefusal(t, f, RefuseUnreadable)

	f = newFixture(t)
	if err := syscall.Mkfifo(filepath.Join(f.repo, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := f.build()
	if err != nil {
		t.Fatalf("untracked FIFO: %v", err)
	}
	defer res.Cleanup()
	if m, _, _ := readBundle(t, res.Path); len(m) != 0 {
		t.Errorf("manifest = %v", m)
	}
}

func TestBundleRefusesDirectoryForFile(t *testing.T) {
	f := newFixture(t)
	p := filepath.Join(f.repo, "README.md")
	_ = os.Remove(p)
	write(t, filepath.Join(p, "inner.txt"), "x", 0o644)
	expectRefusal(t, f, RefuseUnreadable)
}

func TestBundleRefusesOversized(t *testing.T) {
	f := newFixture(t)
	write(t, filepath.Join(f.repo, "huge.txt"), strings.Repeat("a", 1_000_001), 0o644)
	expectRefusal(t, f, RefuseUnreadable)

	f = newFixture(t)
	write(t, filepath.Join(f.repo, "blob.bin"), "\x00"+strings.Repeat("b", 256_000), 0o644)
	expectRefusal(t, f, RefuseUnreadable)

	f = newFixture(t)
	for i := 0; i < 51; i++ {
		write(t, filepath.Join(f.repo, "bins", strings.Repeat("b", i+1)), "\x00bin", 0o644)
	}
	expectRefusal(t, f, RefuseUnreadable)
}

func TestBundleRefusesNonUTF8Path(t *testing.T) {
	f := newFixture(t)
	write(t, filepath.Join(f.repo, "bad\xff.txt"), "x", 0o644)
	expectRefusal(t, f, RefuseUnreadable)
}

func TestBundleRefusesSymlinkedWorktree(t *testing.T) {
	f := newFixture(t)
	if err := os.Rename(f.repo, f.repo+".real"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(f.repo+".real", f.repo); err != nil {
		t.Fatal(err)
	}
	expectRefusal(t, f, RefuseSymlink)
}

func TestHelpers(t *testing.T) {
	if BlobSHA([]byte("hello\n")) != "ce013625030ba8dba906f756967f9e9ca394464a" {
		t.Error("blob sha")
	}
	if !IsBinary([]byte("a\x00b")) || IsBinary([]byte("text")) {
		t.Error("binary heuristic")
	}
	for _, bad := range []string{"", "/abs", "a//b", "a/./b", "../x", "a\x00b", strings.Repeat("a", 256)} {
		if CheckPath(bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if CheckPath("a/b.txt") != nil {
		t.Error("good path refused")
	}
}

// hashFile stops at the deadline even mid-file.
func TestHashFileHonoursContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	r := &slowReader{n: 1 << 30, after: 3, cancel: cancel}
	start := time.Now()
	_, _, err := hashFile(ctx, r, 1<<30)
	if err == nil || ctx.Err() == nil {
		t.Fatalf("err = %v", err)
	}
	if r.reads > 10 || time.Since(start) > 2*time.Second {
		t.Errorf("kept reading after cancel: %d reads, %v", r.reads, time.Since(start))
	}
}

type slowReader struct {
	n, reads, after int
	cancel          func()
}

func (s *slowReader) Read(p []byte) (int, error) {
	s.reads++
	if s.reads == s.after {
		s.cancel()
	}
	if len(p) > s.n {
		p = p[:s.n]
	}
	s.n -= len(p)
	return len(p), nil
}

func TestCheckPathControlAndBackslash(t *testing.T) {
	for _, bad := range []string{"a\tb", "a\nb", "a\\b", "a\x7fb", "\x1b[31m"} {
		if CheckPath(bad) == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
