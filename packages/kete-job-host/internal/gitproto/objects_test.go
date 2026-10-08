package gitproto

import (
	"bytes"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestPackets(t *testing.T) {
	stream := append(append(append(append(pkts("abc\n"), "0000"...), "0001"...), "0002"...), pkts("x")...)
	p, ok := ParsePackets(stream)
	if !ok || len(p) != 5 || p[0].Kind != PacketData || string(p[0].Data) != "abc\n" || p[1].Kind != PacketFlush || p[2].Kind != PacketDelim || p[3].Kind != PacketEnd {
		t.Fatalf("%v %+v", ok, p)
	}
	for _, bad := range []string{"000", "0003", "00ZZ", "00A5abc", "0009abc"} {
		if _, ok := ParsePackets([]byte(bad)); ok {
			t.Errorf("accepted %q", bad)
		}
	}
	defer func() {
		if recover() == nil {
			t.Error("an oversized pkt-line was built")
		}
	}()
	Pkt(make([]byte, 65517))
}

func TestCutMessage(t *testing.T) {
	if got := CutMessage("a\x00\x01b​  c\n", 300); got != "a b c" {
		t.Errorf("%q", got)
	}
	if got := CutMessage(strings.Repeat("é", 400), 300); len([]rune(got)) != 300 || !strings.HasSuffix(got, "…") {
		t.Errorf("cut %d", len([]rune(got)))
	}
}

func TestTrees(t *testing.T) {
	sha := strings.Repeat("ab", 20)
	items := []TreeEntry{{"100644", "b", sha}, {"40000", "a", sha}, {"100755", "a.txt", sha}, {"120000", "a-", sha}}
	body := TreeBody(items)
	parsed, ok := ParseCanonicalTree(body)
	if !ok || len(parsed) != 4 || parsed[0].Name != "a-" || parsed[1].Name != "a.txt" || parsed[2].Name != "a" {
		t.Fatalf("order %+v", parsed)
	}
	// Unsorted, duplicate and non-UTF-8 names: parsable, not canonical.
	unsorted := append(append([]byte{}, body[len(body)/2:]...), body[:len(body)/2]...)
	if _, ok := ParseCanonicalTree(unsorted); ok && !bytes.Equal(unsorted, body) {
		t.Error("an unsorted tree was canonical")
	}
	dup := append(TreeBody([]TreeEntry{{"100644", "x", sha}}), TreeBody([]TreeEntry{{"100644", "x", sha}})...)
	if _, ok := ParseCanonicalTree(dup); ok {
		t.Error("duplicate names were canonical")
	}
	if _, ok := ParseCanonicalTree(TreeBody([]TreeEntry{{"100644", "\xff", sha}})); ok {
		t.Error("a non-UTF-8 name was canonical")
	}
	for _, bad := range [][]byte{[]byte("100644 a"), []byte("100644 a\x00short"), TreeBody([]TreeEntry{{"100666", "a", sha}}), TreeBody([]TreeEntry{{"100644", "a/b", sha}}), TreeBody([]TreeEntry{{"100644", "..", sha}})} {
		if _, ok := ParseTree(bad); ok {
			t.Errorf("parsed %q", bad)
		}
	}
	if tree, parents, ok := ParseCommit([]byte("tree " + sha + "\nparent " + sha + "\nparent " + sha + "\nauthor x\n\nmsg\nparent no\n")); !ok || tree != sha || len(parents) != 2 {
		t.Errorf("commit %s %v %v", tree, parents, ok)
	}
	if _, _, ok := ParseCommit([]byte("parent x\ntree y\n")); ok {
		t.Error("a malformed commit parsed")
	}
	if got := DirectoriesOf("a/b/c"); strings.Join(got, ",") != "a,a/b" || ParentOf("a/b/c") != "a/b" || BaseName("a/b/c") != "c" || ParentOf("c") != "" || len(DirectoriesOf("c")) != 0 {
		t.Errorf("path helpers %v", got)
	}
}

// git runs git in dir with a clean environment.
func git(t *testing.T, dir string, stdin []byte, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@e"}, args...)...)
	cmd.Dir = dir
	cmd.Env = []string{"GIT_CONFIG_NOSYSTEM=1", "HOME=" + dir, "PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func needGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
}

// TestResultTreesMatchGit checks ResultTrees' ids against git's own for the same change.
func TestResultTreesMatchGit(t *testing.T) {
	needGit(t)
	dir := t.TempDir()
	git(t, dir, nil, "init", "-q", "repo")
	repo := dir + "/repo"
	// Base tree: README, src/a.go, src/sub/b.go, docs/x.md (via the index).
	blob := func(content string) string { return git(t, repo, []byte(content), "hash-object", "-w", "--stdin") }
	files := map[string]string{"README": "r\n", "src/a.go": "a\n", "src/sub/b.go": "b\n", "docs/x.md": "x\n"}
	for p, c := range files {
		git(t, repo, nil, "update-index", "--add", "--cacheinfo", "100644,"+blob(c)+","+p)
	}
	baseTree := git(t, repo, nil, "write-tree")
	listings := map[string][]TreeEntry{}
	var list func(path, sha string)
	list = func(path, sha string) {
		out := git(t, repo, nil, "ls-tree", sha)
		var items []TreeEntry
		for _, l := range strings.Split(out, "\n") {
			meta, name, _ := strings.Cut(l, "\t")
			f := strings.Fields(meta)
			mode := f[0]
			if mode == "040000" {
				mode = "40000"
			}
			items = append(items, TreeEntry{mode, name, f[2]})
			if mode == "40000" {
				p := name
				if path != "" {
					p = path + "/" + name
				}
				list(p, f[2])
			}
		}
		listings[path] = items
	}
	list("", baseTree)
	if TreeSHA(listings[""]) != baseTree {
		t.Fatalf("root id differs from git's")
	}
	// Change: edit src/a.go (executable), delete docs/x.md (docs/ empties), add new/deep/f.txt.
	changes := []Change{
		{Path: "src/a.go", Mode: "100755", BlobSHA: blob("a2\n")},
		{Path: "docs/x.md", Deleted: true},
		{Path: "new/deep/f.txt", Mode: "100644", BlobSHA: blob("f\n")},
	}
	root, trees := ResultTrees(listings, changes)
	git(t, repo, nil, "update-index", "--chmod=+x", "--cacheinfo", "100755,"+changes[0].BlobSHA+",src/a.go")
	git(t, repo, nil, "update-index", "--force-remove", "docs/x.md")
	git(t, repo, nil, "update-index", "--add", "--cacheinfo", "100644,"+changes[2].BlobSHA+",new/deep/f.txt")
	if want := git(t, repo, nil, "write-tree"); root != want {
		t.Fatalf("root %s, git %s", root, want)
	}
	if _, ok := trees["docs"]; ok {
		t.Error("an emptied directory was kept")
	}
	for path, tr := range trees {
		if got := git(t, repo, TreeBody(tr.Items), "hash-object", "-t", "tree", "--stdin"); got != tr.SHA {
			t.Errorf("%q: %s vs git %s", path, tr.SHA, got)
		}
	}
	// A commit object as git writes it.
	when := time.Unix(1700000000, 0)
	c := CommitObject(root, strings.Repeat("1", 40), "Kete Code <jobs@noreply.ketecode.ai>", when, "msg [skip ci]\n\nJob: x")
	if !strings.Contains(string(c), "author Kete Code <jobs@noreply.ketecode.ai> 1700000000 +0000\n") || !strings.HasSuffix(string(c), "Job: x\n") {
		t.Errorf("%s", c)
	}
}
