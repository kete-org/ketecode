package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Clone makes the pristine copy: a bare, shallow, single-branch clone of ref with username and
// token in an http.extraHeader (never in the URL, argv or on disk).
func (r Runner) Clone(ctx context.Context, url, ref, username, token, dest string) error {
	_, err := r.Run(ctx, Call{
		Args:    []string{"clone", "--bare", "--depth=1", "--single-branch", "--no-tags", "--branch", ref, "--", url, dest},
		Config:  [][2]string{{"http.extraHeader", BasicHeader(username, token)}},
		Timeout: r.CloneTimeout,
	})
	return err
}

// CloneAt makes the pristine copy at exactly sha (kubevm: the commit the runner resolved ref to):
// an empty bare repository, then a shallow fetch of that one commit into refs/heads/<ref>, with the
// credential in an http.extraHeader. It fails when the server no longer has the commit.
func (r Runner) CloneAt(ctx context.Context, url, ref, sha, username, token, dest string) error {
	if len(sha) != 40 || strings.Trim(sha, "0123456789abcdef") != "" {
		return ErrMismatch
	}
	if _, err := r.Run(ctx, Call{Args: []string{"init", "--bare", "-q", "--", dest}}); err != nil {
		return err
	}
	_, err := r.Run(ctx, Call{
		Args:    []string{"--git-dir=" + dest, "fetch", "--depth=1", "--no-tags", "--", url, "+" + sha + ":refs/heads/" + ref},
		Config:  [][2]string{{"http.extraHeader", BasicHeader(username, token)}},
		Timeout: r.CloneTimeout,
	})
	return err
}

// ErrMismatch is a pristine copy that isn't at base_sha (or isn't what was asked for).
var ErrMismatch = errors.New("git: clone does not match base_sha")

// Verify checks the pristine copy: refs/heads/<ref> is base_sha, SHA-1, no alternates, no
// shallow boundary other than base_sha.
func (r Runner) Verify(ctx context.Context, gitDir, ref, baseSHA string) error {
	out, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + gitDir, "rev-parse", "--verify", "refs/heads/" + ref + "^{commit}"}})
	if err != nil {
		return ErrMismatch
	}
	if strings.TrimSpace(string(out)) != baseSHA {
		return ErrMismatch
	}
	out, err = r.Run(ctx, Call{Args: []string{"--git-dir=" + gitDir, "rev-parse", "--show-object-format"}})
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(out)) != "sha1" {
		return ErrMismatch
	}
	if _, err := os.Lstat(filepath.Join(gitDir, "objects", "info", "alternates")); err == nil {
		return ErrMismatch
	}
	shallow, err := os.ReadFile(filepath.Join(gitDir, "shallow"))
	if err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(shallow)), "\n") {
			if line != "" && line != baseSHA {
				return ErrMismatch
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Head returns the commit refs/heads/<ref> names in a bare copy (kubevm records it as the job's
// base: the runner gives a ref, not a commit).
func (r Runner) Head(ctx context.Context, gitDir, ref string) (string, error) {
	out, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + gitDir, "rev-parse", "--verify", "refs/heads/" + ref + "^{commit}"}})
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(string(out))
	if len(sha) != 40 || strings.Trim(sha, "0123456789abcdef") != "" {
		return "", ErrMismatch
	}
	return sha, nil
}

// AgentCopy makes the agent's working copy: its own objects (no hardlinks, no alternates), the
// job's branch at base_sha, no remote. The working copy's own index is used here (no
// GIT_INDEX_FILE), so the agent's git sees a clean checkout.
func (r Runner) AgentCopy(ctx context.Context, pristine, repo, branch, baseSHA string) error {
	file := [][2]string{{"protocol.file.allow", "always"}}
	if _, err := r.Run(ctx, Call{Args: []string{"clone", "--no-hardlinks", "--no-checkout", "--", pristine, repo}, Config: file}); err != nil {
		return err
	}
	if _, err := os.Lstat(filepath.Join(repo, ".git", "objects", "info", "alternates")); err == nil {
		return errors.New("git: agent copy has alternates")
	}
	if _, err := r.Run(ctx, Call{Args: []string{"-C", repo, "checkout", "-q", "-b", branch, baseSHA}}); err != nil {
		return err
	}
	if _, err := r.Run(ctx, Call{Args: []string{"-C", repo, "remote", "remove", "origin"}}); err != nil {
		return err
	}
	return nil
}

// CheckBranch is `git check-ref-format --branch`.
func (r Runner) CheckBranch(ctx context.Context, name string) bool {
	if strings.HasPrefix(name, "-") || strings.Contains(name, "@{") {
		return false
	}
	out, err := r.Run(ctx, Call{Args: []string{"check-ref-format", "--branch", name}})
	return err == nil && strings.TrimSpace(string(out)) == name
}

// ChownWalk hands the working copy to the tool user and the job group: directories 2775,
// regular files g+w (exec bits kept), symlinks re-owned but never followed. It runs before any
// job process exists.
func ChownWalk(root string, uid, gid int) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := os.Lchown(path, uid, gid); err != nil {
			return err
		}
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			return nil
		case d.IsDir():
			return os.Chmod(path, 0o2775)
		case d.Type().IsRegular():
			info, err := d.Info()
			if err != nil {
				return err
			}
			return os.Chmod(path, info.Mode().Perm()|0o060)
		default:
			return fmt.Errorf("unexpected file type at %s", path)
		}
	})
}

// TreeEntry is one `ls-tree -r -l` line.
type TreeEntry struct {
	Mode string
	Type string
	SHA  string
	Size int64 // -1 for gitlinks
	Path string
}

// ParseLsTree parses `ls-tree -r -z -l --full-tree` output.
func ParseLsTree(out []byte) ([]TreeEntry, error) {
	var entries []TreeEntry
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		meta, path, ok := bytes.Cut(rec, []byte{'\t'})
		if !ok {
			return nil, errors.New("ls-tree: malformed record")
		}
		f := strings.Fields(string(meta))
		if len(f) != 4 {
			return nil, errors.New("ls-tree: malformed record")
		}
		e := TreeEntry{Mode: f[0], Type: f[1], SHA: f[2], Size: -1, Path: string(path)}
		if f[3] != "-" {
			n, err := strconv.ParseInt(f[3], 10, 64)
			if err != nil {
				return nil, errors.New("ls-tree: bad size")
			}
			e.Size = n
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// LsTree lists base_sha's tree from the pristine git-dir.
func (r Runner) LsTree(ctx context.Context, gitDir, sha string) ([]TreeEntry, error) {
	out, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + gitDir, "ls-tree", "-r", "-z", "-l", "--full-tree", sha}})
	if err != nil {
		return nil, err
	}
	return ParseLsTree(out)
}

// ReadTree loads base_sha into a fresh index file (writes nothing else).
func (r Runner) ReadTree(ctx context.Context, gitDir, workTree, index, sha string) error {
	_, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + gitDir, "--work-tree=" + workTree, "read-tree", sha}, IndexFile: index})
	return err
}

// Untracked lists untracked, not-ignored paths of workTree against the pristine git-dir and the
// fresh index: git lstats and never follows a symlinked directory, and never reads the agent's
// own .git.
func (r Runner) Untracked(ctx context.Context, gitDir, workTree, index string) ([]string, error) {
	out, err := r.Run(ctx, Call{
		Dir:       workTree,
		Args:      []string{"--git-dir=" + gitDir, "--work-tree=" + workTree, "ls-files", "-z", "--others", "--exclude-standard"},
		IndexFile: index,
	})
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, p := range bytes.Split(out, []byte{0}) {
		if len(p) > 0 {
			paths = append(paths, string(p))
		}
	}
	return paths, nil
}

// CatBlob reads a blob from the pristine git-dir (≤ max bytes).
func (r Runner) CatBlob(ctx context.Context, gitDir, sha string, max int64) ([]byte, error) {
	out, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + gitDir, "cat-file", "blob", sha}})
	if err != nil {
		return nil, err
	}
	if int64(len(out)) > max {
		return nil, ErrOutputTooLarge
	}
	return out, nil
}

// --- orchestrated jobs (jobs-v1 "Orchestrated jobs") ---

// ResolveCommit returns the commit a full ref (refs/heads/…, refs/kete/…) names in a git-dir.
func (r Runner) ResolveCommit(ctx context.Context, gitDir, ref string) (string, error) {
	out, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + gitDir, "rev-parse", "--verify", "--quiet", ref + "^{commit}"}})
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(string(out))
	if len(sha) != 40 || strings.Trim(sha, "0123456789abcdef") != "" {
		return "", ErrMismatch
	}
	return sha, nil
}

// PinBase remakes the pristine copy at exactly baseSHA when the ref has moved on since the
// orchestration pinned it: a fresh bare repository, the one commit fetched by its id (depth 1, the
// same credential header as the clone), and refs/heads/<ref> pointing at it — so Verify's rules
// (the ref at base_sha, no shallow boundary but base_sha) hold as for any clone.
func (r Runner) PinBase(ctx context.Context, url, ref, username, token, baseSHA, dest string) error {
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	if _, err := r.Run(ctx, Call{Args: []string{"init", "--bare", "-q", "--", dest}}); err != nil {
		return err
	}
	if _, err := r.Run(ctx, Call{
		Args:    []string{"--git-dir=" + dest, "fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", "--", url, "+" + baseSHA + ":refs/heads/" + ref},
		Config:  [][2]string{{"http.extraHeader", BasicHeader(username, token)}},
		Timeout: r.CloneTimeout,
	}); err != nil {
		return err
	}
	_, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + dest, "symbolic-ref", "HEAD", "refs/heads/" + ref}})
	return err
}

// RefSpec is one extra ref of an orchestrated claim: refs/heads/<Branch> fetched into
// refs/kete/<Name>.
type RefSpec struct {
	Name   string
	Branch string
}

// FetchRefs fetches every ref in one call, always as refs/heads/<branch> (never a bare name a tag
// could shadow) into refs/kete/<name>, with the clone's credential header. depth1 fetches only the
// tips (a worker reads them for reference); without it the history down to commits the pristine
// copy already has comes along (a coordinator merges node branches, which all grow from the pinned
// base), and git refuses anything that would move the shallow boundary.
func (r Runner) FetchRefs(ctx context.Context, gitDir, url, username, token string, refs []RefSpec, depth1 bool) error {
	if len(refs) == 0 {
		return nil
	}
	args := []string{"--git-dir=" + gitDir, "fetch", "--no-tags", "--no-write-fetch-head"}
	if depth1 {
		args = append(args, "--depth=1")
	}
	args = append(args, "--", url)
	for _, s := range refs {
		args = append(args, "+refs/heads/"+s.Branch+":refs/kete/"+s.Name)
	}
	_, err := r.Run(ctx, Call{Args: args, Config: [][2]string{{"http.extraHeader", BasicHeader(username, token)}}, Timeout: r.CloneTimeout})
	return err
}

// CopyKeteRefs makes the pristine copy's refs/kete/* (fetched and checked in the clone phase)
// available in the agent's working copy, from the local pristine copy only (no network).
func (r Runner) CopyKeteRefs(ctx context.Context, pristine, repo string) error {
	_, err := r.Run(ctx, Call{
		Args:   []string{"-C", repo, "fetch", "--no-tags", "--no-write-fetch-head", "--update-shallow", "--", pristine, "+refs/kete/*:refs/kete/*"},
		Config: [][2]string{{"protocol.file.allow", "always"}},
	})
	return err
}

// --- pull request review jobs (jobs-v1 "Pull request review") ---

// ErrNoMergeBase is a review whose head and base share no commit in the fetched history.
var ErrNoMergeBase = errors.New("git: no merge base in the fetched history")

func reviewRefspecs(headRef, branch, baseBranch string) []string {
	return []string{"+" + headRef + ":refs/heads/" + branch, "+refs/heads/" + baseBranch + ":refs/heads/" + baseBranch}
}

// ReviewClone makes a review job's pristine copy: a fresh bare repository, then one fetch of the
// pull request's head ref (refs/pull/<n>/head, which the base repository serves for a fork's pull
// request too) into refs/heads/<branch> (the job's branch) and of the base branch (always as
// refs/heads/<baseBranch>, never a bare name a tag could shadow) into refs/heads/<baseBranch>, depth
// commits deep each, with the clone's credential header. HEAD names the base branch, as after any
// job's clone, so the agent copy's `checkout -b <branch>` makes the job's branch itself.
func (r Runner) ReviewClone(ctx context.Context, url, username, token, headRef, branch, baseBranch string, depth int, dest string) error {
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	if _, err := r.Run(ctx, Call{Args: []string{"init", "--bare", "-q", "--", dest}}); err != nil {
		return err
	}
	args := append([]string{"--git-dir=" + dest, "fetch", "--depth=" + strconv.Itoa(depth), "--no-tags", "--no-write-fetch-head", "--", url}, reviewRefspecs(headRef, branch, baseBranch)...)
	if _, err := r.Run(ctx, Call{Args: args, Config: [][2]string{{"http.extraHeader", BasicHeader(username, token)}}, Timeout: r.CloneTimeout}); err != nil {
		return err
	}
	_, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + dest, "symbolic-ref", "HEAD", "refs/heads/" + baseBranch}})
	return err
}

// ReviewDeepen fetches the same two refs again, deepen commits further back (when the first fetch
// held no merge base). The caller checks the head again afterwards: the refs may have moved.
func (r Runner) ReviewDeepen(ctx context.Context, gitDir, url, username, token, headRef, branch, baseBranch string, deepen int) error {
	args := append([]string{"--git-dir=" + gitDir, "fetch", "--deepen=" + strconv.Itoa(deepen), "--no-tags", "--no-write-fetch-head", "--", url}, reviewRefspecs(headRef, branch, baseBranch)...)
	_, err := r.Run(ctx, Call{Args: args, Config: [][2]string{{"http.extraHeader", BasicHeader(username, token)}}, Timeout: r.CloneTimeout})
	return err
}

// MergeBase is `git merge-base a b` in a git-dir: the commit, or ErrNoMergeBase when the fetched
// history holds none.
func (r Runner) MergeBase(ctx context.Context, gitDir, a, b string) (string, error) {
	out, err := r.Run(ctx, Call{Args: []string{"--git-dir=" + gitDir, "merge-base", a, b}})
	if err != nil {
		var ge *Error
		if errors.As(err, &ge) && ge.ExitCode == 1 {
			return "", ErrNoMergeBase
		}
		return "", err
	}
	sha := strings.TrimSpace(string(out))
	if len(sha) != 40 || strings.Trim(sha, "0123456789abcdef") != "" {
		return "", ErrMismatch
	}
	return sha, nil
}

// ReviewDiff is what the reviewing agent is shown: the changed files (`--name-status`, renames
// found) and the unified diff from base to head, each cut at its cap (cut reports which were). No
// external diff driver or textconv runs (the repository's attributes can name neither: no driver
// is configured).
type ReviewDiff struct {
	Files, Diff       []byte
	FilesCut, DiffCut bool
}

// Diff computes ReviewDiff from a git-dir, read-only.
func (r Runner) Diff(ctx context.Context, gitDir, base, head string, maxFiles, maxDiff int64) (ReviewDiff, error) {
	common := []string{"--git-dir=" + gitDir, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames"}
	var d ReviewDiff
	out, err := r.Run(ctx, Call{Args: append(append([]string{}, common...), "--name-status", base, head, "--"), MaxStdout: maxFiles})
	switch {
	case errors.Is(err, ErrOutputTooLarge):
		d.FilesCut = true
	case err != nil:
		return ReviewDiff{}, err
	}
	d.Files = out
	out, err = r.Run(ctx, Call{Args: append(append([]string{}, common...), "--unified=3", base, head, "--"), MaxStdout: maxDiff})
	switch {
	case errors.Is(err, ErrOutputTooLarge):
		d.DiffCut = true
	case err != nil:
		return ReviewDiff{}, err
	}
	d.Diff = out
	return d, nil
}
