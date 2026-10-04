// Package fsutil holds the agent's file-safety helpers: private directories, atomic private
// writes and permission checks for the key, state and configuration files (ADR 0023 rule 6: root
// `0700` state, `0600` files).
//
// Every check opens the path with O_NOFOLLOW|O_CLOEXEC and inspects the open descriptor (fstat),
// so a path can't be swapped between the check and the use. Ancestors of a private directory must
// be root-owned directories (not symlinks) that neither group nor others can write, so nobody but
// root can rename or replace anything on the way to it. Private paths must be owned by uid 0: the
// agent is a root service, and its tests run as root (Docker or sudo).
package fsutil

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// RootUID is the owner every private path and ancestor must have.
const RootUID = 0

// CheckAncestors refuses an ancestor of path (from its parent up to "/") that is a symlink, not a
// directory, not owned by root, or writable by group or others.
func CheckAncestors(path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("%s: must be an absolute path", path)
	}
	p := filepath.Clean(path)
	for {
		parent := filepath.Dir(p)
		if parent == p {
			return nil
		}
		p = parent
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
			return fmt.Errorf("%s: ancestor is a symlink or not a directory", p)
		}
		if fi.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("%s: ancestor mode %04o is writable by group or others", p, fi.Mode().Perm())
		}
		if uid, ok := owner(fi); !ok || uid != RootUID {
			return fmt.Errorf("%s: ancestor is not owned by root", p)
		}
	}
}

func owner(fi os.FileInfo) (uint32, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return st.Uid, true
}

// EnsurePrivateDir creates dir (and missing parents, 0700) if needed, then checks its ancestors
// and the directory itself.
func EnsurePrivateDir(dir string) error {
	if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir {
		return fmt.Errorf("%s: must be a clean absolute path", dir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return CheckPrivate(dir, true)
}

// OpenPrivate opens path without following a final symlink and checks the open descriptor: the
// right kind, owned by root, no group or other access (mode 0700/0600 or stricter). For a
// directory the ancestors are checked too; for a file, its directory (and its ancestors).
func OpenPrivate(path string, wantDir bool) (*os.File, error) {
	if wantDir {
		if err := CheckAncestors(path); err != nil {
			return nil, err
		}
	} else {
		if err := CheckPrivate(filepath.Dir(path), true); err != nil {
			return nil, err
		}
	}
	flags := os.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
	if wantDir {
		flags |= syscall.O_DIRECTORY
	}
	f, err := os.OpenFile(path, flags, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return nil, fmt.Errorf("%s: is a symlink", path)
		}
		return nil, err
	}
	if err := checkFD(f, path, wantDir, 0o077); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// checkFD checks an open descriptor's kind, owner (root) and that none of the forbidden mode
// bits are set.
func checkFD(f *os.File, path string, wantDir bool, forbidden os.FileMode) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if fi.IsDir() != wantDir || (!wantDir && !fi.Mode().IsRegular()) {
		return fmt.Errorf("%s: unexpected file type", path)
	}
	if fi.Mode().Perm()&forbidden != 0 {
		return fmt.Errorf("%s: mode %04o is too open", path, fi.Mode().Perm())
	}
	if uid, ok := owner(fi); !ok || uid != RootUID {
		return fmt.Errorf("%s: not owned by root", path)
	}
	return nil
}

// CheckPrivate is OpenPrivate without keeping the descriptor.
func CheckPrivate(path string, wantDir bool) error {
	f, err := OpenPrivate(path, wantDir)
	if err != nil {
		return err
	}
	return f.Close()
}

// OpenRootFile opens a root-owned regular file that group and others can't write (the
// configuration: it may be world-readable), without following a final symlink, with root-owned,
// non-writable ancestors.
func OpenRootFile(path string) (*os.File, error) {
	if err := CheckAncestors(path); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, syscall.ELOOP) {
			return nil, fmt.Errorf("%s: is a symlink", path)
		}
		return nil, err
	}
	if err := checkFD(f, path, false, 0o022); err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// WritePrivate writes data to path atomically: a new 0600 temporary file in the same (private)
// directory, fsync, rename over path, fsync the directory.
func WritePrivate(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	d, err := OpenPrivate(dir, true)
	if err != nil {
		return err
	}
	defer d.Close()
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = os.Remove(tmp)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return SyncDir(d)
}

// SyncDir fsyncs an open directory (EINVAL from filesystems that don't support it is ignored).
func SyncDir(d *os.File) error {
	if err := d.Sync(); err != nil && !errors.Is(err, syscall.EINVAL) {
		return err
	}
	return nil
}

// ReadPrivate reads a private regular file of at most limit bytes from the checked descriptor.
func ReadPrivate(path string, limit int64) ([]byte, error) {
	f, err := OpenPrivate(path, false)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s: larger than %d bytes", path, limit)
	}
	return data, nil
}
