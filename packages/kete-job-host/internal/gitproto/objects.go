package gitproto

import (
	"bytes"
	"encoding/hex"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// TreeEntry is one tree entry as git stores it: mode 100644, 100755, 120000, 160000 or 40000.
type TreeEntry struct {
	Mode, Name, SHA string
}

var treeModes = map[string]bool{"100644": true, "100755": true, "120000": true, "160000": true, "40000": true}

// ParseTree parses a tree object's entries; false when malformed (unknown mode, empty, `.`, `..`
// or `/`-bearing name, short SHA).
func ParseTree(data []byte) ([]TreeEntry, bool) {
	var out []TreeEntry
	i := 0
	for i < len(data) {
		sp := bytes.IndexByte(data[i:], ' ')
		if sp < 0 {
			return nil, false
		}
		sp += i
		mode := string(data[i:sp])
		nul := bytes.IndexByte(data[sp+1:], 0)
		if nul < 0 {
			return nil, false
		}
		nul += sp + 1
		if nul+21 > len(data) {
			return nil, false
		}
		name := string(data[sp+1 : nul])
		if !treeModes[mode] || name == "" || strings.Contains(name, "/") || name == "." || name == ".." {
			return nil, false
		}
		out = append(out, TreeEntry{Mode: mode, Name: name, SHA: hex.EncodeToString(data[nul+1 : nul+21])})
		i = nul + 21
	}
	return out, true
}

// ParseCanonicalTree returns a tree's entries only when they describe it exactly: valid UTF-8
// names, no duplicate, and re-encoding them in git's order gives back the very bytes of data. A
// tree rebuilt from these entries then copies every untouched entry byte for byte.
func ParseCanonicalTree(data []byte) ([]TreeEntry, bool) {
	parsed, ok := ParseTree(data)
	if !ok {
		return nil, false
	}
	seen := map[string]bool{}
	for _, e := range parsed {
		if seen[e.Name] || !utf8.ValidString(e.Name) {
			return nil, false
		}
		seen[e.Name] = true
	}
	if !bytes.Equal(TreeBody(parsed), data) {
		return nil, false
	}
	return parsed, true
}

func sortKey(e TreeEntry) string {
	if e.Mode == "40000" {
		return e.Name + "/"
	}
	return e.Name
}

// TreeBody is a tree object's body from items, in git's order (names compared as bytes, trees
// as `name/`).
func TreeBody(items []TreeEntry) []byte {
	sorted := append([]TreeEntry(nil), items...)
	sort.SliceStable(sorted, func(a, b int) bool { return sortKey(sorted[a]) < sortKey(sorted[b]) })
	var buf bytes.Buffer
	for _, e := range sorted {
		buf.WriteString(e.Mode + " " + e.Name + "\x00")
		raw, _ := hex.DecodeString(e.SHA)
		buf.Write(raw)
	}
	return buf.Bytes()
}

// TreeSHA is git's tree id of items.
func TreeSHA(items []TreeEntry) string { return ObjectID("tree", TreeBody(items)) }

var (
	commitTreeRe   = regexp.MustCompile(`^tree ([0-9a-f]{40})$`)
	commitParentRe = regexp.MustCompile(`^parent ([0-9a-f]{40})$`)
)

// ParseCommit returns a commit object's tree and parents; ok false when malformed.
func ParseCommit(data []byte) (tree string, parents []string, ok bool) {
	text := string(data)
	header := text
	if end := strings.Index(text, "\n\n"); end >= 0 {
		header = text[:end]
	}
	lines := strings.Split(header, "\n")
	m := commitTreeRe.FindStringSubmatch(lines[0])
	if m == nil {
		return "", nil, false
	}
	for _, l := range lines[1:] {
		p := commitParentRe.FindStringSubmatch(l)
		if p == nil {
			break
		}
		parents = append(parents, p[1])
	}
	return m[1], parents, true
}

// CommitObject is a commit object's body: tree, one parent, identity as author and committer at
// when (UTC, +0000), then message.
func CommitObject(tree, parent, identity string, when time.Time, message string) []byte {
	ts := strconv.FormatInt(when.Unix(), 10) + " +0000"
	return []byte("tree " + tree + "\nparent " + parent + "\nauthor " + identity + " " + ts + "\ncommitter " + identity + " " + ts + "\n\n" + message + "\n")
}

// ParentOf is a path's directory ("" for the root).
func ParentOf(path string) string {
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		return path[:i]
	}
	return ""
}

// BaseName is a path's last component.
func BaseName(path string) string { return path[strings.LastIndexByte(path, '/')+1:] }

// DirectoriesOf is every directory of path, outermost first, excluding the root (`a/b/c` → `a`,
// `a/b`).
func DirectoriesOf(path string) []string {
	parts := strings.Split(path, "/")
	out := make([]string, 0, len(parts)-1)
	for i := 1; i < len(parts); i++ {
		out = append(out, strings.Join(parts[:i], "/"))
	}
	return out
}

// Change is one validated bundle entry: a deletion, or a file with its mode and blob id.
type Change struct {
	Path    string
	Deleted bool
	Mode    string
	BlobSHA string
}

// Tree is a resulting tree object: its id and items.
type Tree struct {
	SHA   string
	Items []TreeEntry
}

// ResultTrees applies changes to the base listings of every touched directory ("" is the root; a
// directory missing from listings starts empty), recomputes the trees bottom-up and drops
// directories left empty. It returns the root tree's id and every non-empty touched tree (the
// platform's git-objects.ts resultTrees: same algorithm, same ids).
func ResultTrees(listings map[string][]TreeEntry, changes []Change) (string, map[string]Tree) {
	dirs := map[string]map[string]TreeEntry{}
	dirOf := func(path string) map[string]TreeEntry {
		d, ok := dirs[path]
		if !ok {
			d = map[string]TreeEntry{}
			for _, e := range listings[path] {
				d[e.Name] = e
			}
			dirs[path] = d
		}
		return d
	}
	dirOf("")
	for _, c := range changes {
		for _, d := range DirectoriesOf(c.Path) {
			dirOf(d)
		}
		parent := dirOf(ParentOf(c.Path))
		name := BaseName(c.Path)
		if c.Deleted {
			delete(parent, name)
		} else {
			parent[name] = TreeEntry{Mode: c.Mode, Name: name, SHA: c.BlobSHA}
		}
	}
	var order []string
	for d := range dirs {
		if d != "" {
			order = append(order, d)
		}
	}
	// Deepest first, so each directory's id is known before its parent's.
	sort.Slice(order, func(a, b int) bool {
		da, db := strings.Count(order[a], "/"), strings.Count(order[b], "/")
		if da != db {
			return da > db
		}
		return order[a] < order[b]
	})
	trees := map[string]Tree{}
	items := func(d map[string]TreeEntry) []TreeEntry {
		out := make([]TreeEntry, 0, len(d))
		for _, e := range d {
			out = append(out, e)
		}
		return out
	}
	for _, path := range order {
		d := dirs[path]
		parent := dirOf(ParentOf(path))
		if len(d) == 0 {
			delete(parent, BaseName(path))
			continue
		}
		it := items(d)
		sha := TreeSHA(it)
		trees[path] = Tree{SHA: sha, Items: it}
		parent[BaseName(path)] = TreeEntry{Mode: "40000", Name: BaseName(path), SHA: sha}
	}
	root := items(dirs[""])
	rootSHA := TreeSHA(root)
	trees[""] = Tree{SHA: rootSHA, Items: root}
	return rootSHA, trees
}
