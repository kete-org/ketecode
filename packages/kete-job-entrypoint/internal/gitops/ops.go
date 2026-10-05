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
