//go:build linux

package bundle

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/gitops"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/setup"
)

// Lister is the git the reader needs; every call names the pristine git-dir.
type Lister interface {
	LsTree(ctx context.Context, gitDir, sha string) ([]gitops.TreeEntry, error)
	ReadTree(ctx context.Context, gitDir, workTree, index, sha string) error
	Untracked(ctx context.Context, gitDir, workTree, index string) ([]string, error)
	CatBlob(ctx context.Context, gitDir, sha string, max int64) ([]byte, error)
}

// Options describe one build.
type Options struct {
	Git        Lister
	GitDir     string // the pristine git-dir
	WorkParent string // root-owned (AnchorUID), the anchor
	AnchorUID  uint32 // the owner WorkParent must have: 0 in the entrypoint
	RepoName   string
	TmpDir     string // root 0700; a mkdtemp under it holds the index and the bundle
	BaseSHA    string
	Limits     Limits
	Kind       Kind // the orchestrations-v1 rule (KindOther for every plain job)
}

type outcome int

const (
	opened outcome = iota
	missing
	isSymlink
	unreadable
)

// walk opens every directory component of rel beneath repoFD with O_NOFOLLOW and returns the
// parent fd of the leaf.
func walk(repoFD int, rel string) (int, string, outcome) {
	parts := strings.Split(rel, "/")
	cur, err := unix.Dup(repoFD)
	if err != nil {
		return -1, "", unreadable
	}
	for _, c := range parts[:len(parts)-1] {
		next, err := unix.Openat(cur, c, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			var st unix.Stat_t
			serr := unix.Fstatat(cur, c, &st, unix.AT_SYMLINK_NOFOLLOW)
			unix.Close(cur)
			switch {
			case errors.Is(serr, unix.ENOENT):
				return -1, "", missing
			case serr != nil:
				return -1, "", unreadable
			case st.Mode&unix.S_IFMT == unix.S_IFLNK:
				return -1, "", isSymlink
			case st.Mode&unix.S_IFMT != unix.S_IFDIR:
				// Something that isn't a directory where one was: the tracked path is gone (the
				// new file there is listed as untracked on its own).
				return -1, "", missing
			}
			return -1, "", unreadable
		}
		unix.Close(cur)
		cur = next
	}
	return cur, parts[len(parts)-1], opened
}

// openFile opens a regular file beneath repoFD, never following a symlink; a FIFO can't block
// (O_NONBLOCK).
func openFile(repoFD int, rel string) (*os.File, int64, uint32, outcome) {
	dir, leaf, oc := walk(repoFD, rel)
	if oc != opened {
		return nil, 0, 0, oc
	}
	defer unix.Close(dir)
	fd, err := unix.Openat(dir, leaf, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		switch {
		case errors.Is(err, unix.ELOOP), errors.Is(err, unix.EMLINK):
			return nil, 0, 0, isSymlink
		case errors.Is(err, unix.ENOENT), errors.Is(err, unix.ENOTDIR):
			return nil, 0, 0, missing
		}
		var st unix.Stat_t
		if unix.Fstatat(dir, leaf, &st, unix.AT_SYMLINK_NOFOLLOW) == nil && st.Mode&unix.S_IFMT == unix.S_IFLNK {
			return nil, 0, 0, isSymlink
		}
		return nil, 0, 0, unreadable
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil || st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fd)
		return nil, 0, 0, unreadable
	}
	return os.NewFile(uintptr(fd), rel), st.Size, st.Mode, opened
}

// hashFile streams the whole file into git's blob hash (bounded by want+1 bytes).
// Every read checks ctx, so a huge file can't run past the deadline.
func hashFile(ctx context.Context, f io.Reader, want int64) (string, bool, error) {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", want)
	n, err := io.Copy(h, io.LimitReader(ctxReader{ctx: ctx, r: f}, want+1))
	if err != nil {
		return "", false, err
	}
	if n != want {
		return "", false, nil
	}
	return hex.EncodeToString(h.Sum(nil)), true, nil
}

func readContent(f *os.File, lim Limits) ([]byte, bool, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, false, refuse(RefuseUnreadable, "a file could not be read")
	}
	data, err := io.ReadAll(io.LimitReader(f, lim.MaxFile+1))
	if err != nil {
		return nil, false, refuse(RefuseUnreadable, "a file could not be read")
	}
	binary, err := checkContent(data, lim)
	return data, binary, err
}

func fail(oc outcome, tracked bool) error {
	switch oc {
	case isSymlink:
		return refuse(RefuseSymlink, "a symlink in the worktree")
	case missing:
		if tracked {
			return nil // deletion
		}
		return refuse(RefuseUnreadable, "a listed file disappeared")
	}
	return refuse(RefuseUnreadable, "a special or unreadable file in the worktree")
}

// Build reads the worktree and writes the bundle. A refusal is returned as an error AsRefusal
// recognises; any other error is internal (the caller treats it as unreadable).
func Build(ctx context.Context, o Options) (*Result, error) {
	if err := os.MkdirAll(o.TmpDir, 0o700); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(o.TmpDir, "bundle-")
	if err != nil {
		return nil, err
	}
	res := &Result{dir: dir}
	ok := false
	defer func() {
		if !ok {
			res.Cleanup()
		}
	}()

	// Anchor: the root-owned parent (not writable by the job users), then the repository.
	parentFD, err := setup.OpenDirNoFollow(o.WorkParent, unix.O_PATH)
	if err != nil {
		return nil, refuse(RefuseUnreadable, "the worktree parent can't be opened")
	}
	defer unix.Close(parentFD)
	var st unix.Stat_t
	if err := unix.Fstat(parentFD, &st); err != nil || st.Uid != o.AnchorUID || st.Mode&0o022 != 0 {
		return nil, refuse(RefuseUnreadable, "the worktree parent is not root-owned")
	}
	repoFD, err := unix.Openat(parentFD, o.RepoName, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		if unix.Fstatat(parentFD, o.RepoName, &st, unix.AT_SYMLINK_NOFOLLOW) == nil && st.Mode&unix.S_IFMT == unix.S_IFLNK {
			return nil, refuse(RefuseSymlink, "the worktree is a symlink")
		}
		return nil, refuse(RefuseUnreadable, "the worktree can't be opened")
	}
	defer unix.Close(repoFD)
	workTree := filepath.Join(o.WorkParent, o.RepoName)

	// List, against the pristine git-dir only.
	index := filepath.Join(dir, "index")
	if err := o.Git.ReadTree(ctx, o.GitDir, workTree, index, o.BaseSHA); err != nil {
		return nil, refuse(RefuseUnreadable, "git read-tree failed")
	}
	base, err := o.Git.LsTree(ctx, o.GitDir, o.BaseSHA)
	if err != nil {
		return nil, refuse(RefuseUnreadable, "git ls-tree failed")
	}
	untracked, err := o.Git.Untracked(ctx, o.GitDir, workTree, index)
	if err != nil {
		return nil, refuse(RefuseUnreadable, "git ls-files failed")
	}
	if len(untracked) > o.Limits.MaxUntracked {
		return nil, refuse(RefuseUnreadable, "too many untracked files")
	}

	var entries []entry
	var content int64
	add := func(e entry) error {
		entries = append(entries, e)
		content += int64(len(e.data))
		if len(entries) > o.Limits.MaxEntries || content > o.Limits.MaxTar {
			return limitChecks(entries, o.Limits)
		}
		return nil
	}
	for _, b := range base {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if b.Mode == "160000" {
			continue // gitlink: no submodule is ever cloned
		}
		if err := CheckPath(b.Path); err != nil {
			return nil, err
		}
		switch b.Mode {
		case "120000":
			target, err := o.Git.CatBlob(ctx, o.GitDir, b.SHA, 4096)
			if err != nil {
				return nil, refuse(RefuseUnreadable, "a base symlink can't be read")
			}
			d, leaf, oc := walk(repoFD, b.Path)
			if oc != opened {
				return nil, refuse(RefuseSymlink, "a base symlink was changed")
			}
			var lst unix.Stat_t
			serr := unix.Fstatat(d, leaf, &lst, unix.AT_SYMLINK_NOFOLLOW)
			buf := make([]byte, 4097)
			n := -1
			if serr == nil && lst.Mode&unix.S_IFMT == unix.S_IFLNK {
				n, _ = unix.Readlinkat(d, leaf, buf)
			}
			unix.Close(d)
			if n < 0 || n > 4096 || string(buf[:n]) != string(target) {
				return nil, refuse(RefuseSymlink, "a base symlink was changed")
			}
		case "100644", "100755":
			f, size, mode, oc := openFile(repoFD, b.Path)
			if oc != opened {
				if err := fail(oc, true); err != nil {
					return nil, err
				}
				if err := add(entry{ManifestEntry: ManifestEntry{Path: b.Path, Deleted: true}}); err != nil {
					return nil, err
				}
				continue
			}
			gotMode := modeOf(mode&unix.S_IXUSR != 0)
			if size == b.Size {
				sum, whole, err := hashFile(ctx, f, size)
				if err != nil {
					f.Close()
					if ctx.Err() != nil {
						return nil, ctx.Err()
					}
					return nil, refuse(RefuseUnreadable, "a file could not be read")
				}
				if whole && sum == b.SHA && gotMode == b.Mode {
					f.Close()
					continue
				}
			}
			data, binary, err := readContent(f, o.Limits)
			f.Close()
			if err != nil {
				return nil, err
			}
			if err := add(entry{ManifestEntry: ManifestEntry{Path: b.Path, Mode: gotMode}, data: data, binary: binary}); err != nil {
				return nil, err
			}
		default:
			return nil, refuse(RefuseUnreadable, "an unknown base entry type")
		}
	}
	for _, p := range untracked {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if strings.HasSuffix(p, "/") {
			res.Notes = append(res.Notes, "a nested repository in the worktree was skipped")
			continue
		}
		if err := CheckPath(p); err != nil {
			return nil, err
		}
		f, _, mode, oc := openFile(repoFD, p)
		if oc != opened {
			return nil, fail(oc, false)
		}
		data, binary, err := readContent(f, o.Limits)
		f.Close()
		if err != nil {
			return nil, err
		}
		if err := add(entry{ManifestEntry: ManifestEntry{Path: p, Mode: modeOf(mode&unix.S_IXUSR != 0)}, data: data, binary: binary}); err != nil {
			return nil, err
		}
	}
	entries, notes, err := applyOrchestration(entries, o.Kind)
	if err != nil {
		return nil, err
	}
	res.Notes = append(res.Notes, notes...)
	if err := limitChecks(entries, o.Limits); err != nil {
		return nil, err
	}

	res.Path = filepath.Join(dir, "bundle.tar.gz")
	out, err := os.OpenFile(res.Path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	manifest, err := writeTar(out, entries, o.Limits)
	cerr := out.Close()
	if err != nil {
		return nil, err
	}
	if cerr != nil {
		return nil, cerr
	}
	info, err := os.Stat(res.Path)
	if err != nil {
		return nil, err
	}
	res.Size = info.Size()
	res.Manifest = manifest
	ok = true
	return res, nil
}
