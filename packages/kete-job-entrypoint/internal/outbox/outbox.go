// Package outbox writes a kubevm job's outputs into the Kubernetes runner's per-job outbox volume
// (module README "Outbox"; enterprise runtime spec §4.1 and §4.5): the full result, the audit log,
// the proxy log and the change bundle, then manifest.json naming them with sizes and SHA-256 —
// written last, atomically, so a reader that finds a manifest finds every file it names. The
// runner's publisher (piece P3) reads the volume after the job pod has ended and treats every
// file, the manifest included, as hostile.
//
// Files are root-owned, group layout.OutboxGID, 0640, in a directory 0750: the publisher's
// non-root user can read them, no job user can. Nothing here follows a symlink or overwrites a
// file.
package outbox

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/job"
)

// ManifestName is the outbox's index.
const ManifestName = "manifest.json"

var nameRe = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)

// Dir is one outbox directory.
type Dir struct {
	Path     string
	UID, GID int // the files' owner: root and layout.OutboxGID in the entrypoint
}

// Put copies at most max bytes of r into name (created exclusively) and returns its size and
// SHA-256. More than max bytes is an error and leaves no file.
func (d Dir) Put(name string, r io.Reader, max int64) (job.OutboxFile, error) {
	if !nameRe.MatchString(name) || name == ManifestName {
		return job.OutboxFile{}, fmt.Errorf("outbox: bad name %q", name)
	}
	path := filepath.Join(d.Path, name)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|noFollow, 0o600)
	if err != nil {
		return job.OutboxFile{}, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, max+1))
	if err == nil && n > max {
		err = fmt.Errorf("outbox: %s is larger than %d bytes", name, max)
	}
	if err == nil {
		err = d.finish(f)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(path)
		return job.OutboxFile{}, err
	}
	return job.OutboxFile{Name: name, Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}

// finish sets the owner and mode and flushes the file.
func (d Dir) finish(f *os.File) error {
	if err := f.Chown(d.UID, d.GID); err != nil {
		return err
	}
	if err := f.Chmod(0o640); err != nil {
		return err
	}
	return f.Sync()
}

// Commit writes manifest.json atomically (a temporary file, then a rename) after checking that
// every file it names exists with that size.
func (d Dir) Commit(m job.OutboxManifest) error {
	for key, f := range m.Files {
		st, err := os.Lstat(filepath.Join(d.Path, f.Name))
		if err != nil || !st.Mode().IsRegular() || st.Size() != f.Size {
			return fmt.Errorf("outbox: %s is not as written", key)
		}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp := filepath.Join(d.Path, ".manifest.tmp")
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|noFollow, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if err == nil {
		err = d.finish(f)
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(d.Path, ManifestName))
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	dir, err := os.Open(d.Path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// ErrNotEmpty: the outbox volume already holds something (only `lost+found`, which a fresh ext4
// volume has, is tolerated).
var ErrNotEmpty = errors.New("outbox: the volume is not empty")

// Prepare checks the outbox directory before any job process exists: a directory, empty but for
// lost+found, then owned by uid (root) and gid, mode 0750.
func Prepare(path string, uid, gid int) error {
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return errors.New("outbox: not a directory")
	}
	ents, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, e := range ents {
		if e.Name() != "lost+found" {
			return ErrNotEmpty
		}
	}
	if err := os.Chown(path, uid, gid); err != nil {
		return err
	}
	return os.Chmod(path, 0o750)
}
