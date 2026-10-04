package image

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/types"
	"golang.org/x/sys/unix"
)

// Store fetches allowlisted images by digest and turns each into a read-only ext4 root file
// system, cached per platform manifest digest (ADR 0023 rule 7: "converted once per image digest
// to a read-only ext4 image and shared by VMs"). Every blob is downloaded whole and checked
// against its descriptor's size and digest, and every layer's uncompressed content against the
// config's diff_id, before anything of it is used.
type Store struct {
	// Dir is the cache directory (root 0700), e.g. <state>/images.
	Dir string
	// Arch is the host architecture (amd64, arm64).
	Arch string
	// Mkfs is mkfs.ext4 (default: from PATH).
	Mkfs string
	// MaxBytes bounds the image's unpacked size (default 16 GiB).
	MaxBytes int64
	// Remote and Name are go-containerregistry options (tests: a plain-HTTP local registry).
	Remote []remote.Option
	Name   []name.Option

	mu    sync.Mutex
	locks map[string]*sync.Mutex
	paths map[string]string // ref -> built root file system (so Start needs no registry)
}

const (
	defaultMaxBytes = 16 << 30
	maxEntries      = 2_000_000
	maxManifest     = 4 << 20
	maxConfig       = 4 << 20
	rootfsLabel     = "kete-root"
)

// Rootfs returns the path of ref's read-only ext4 root file system, building it if needed. Errors
// wrap ErrUnavailable (fetch) or ErrSignature (a blob that doesn't match its digest).
func (s *Store) Rootfs(ctx context.Context, ref string) (string, error) {
	s.mu.Lock()
	known := s.paths[ref]
	s.mu.Unlock()
	if known != "" {
		if fi, err := os.Lstat(known); err == nil && fi.Mode().IsRegular() {
			return known, nil
		}
	}
	d, err := name.NewDigest(ref, s.Name...)
	if err != nil {
		return "", fmt.Errorf("image: %w", err)
	}
	opts := append([]remote.Option{remote.WithContext(ctx), remote.WithTransport(defaultTransport())}, s.Remote...)
	desc, err := remote.Get(d, opts...)
	if err != nil {
		return "", fmt.Errorf("%w: manifest: %v", ErrUnavailable, err)
	}
	if err := checkManifest(desc.Manifest, d.DigestStr()); err != nil {
		return "", err
	}
	manifestDigest := d.DigestStr()
	raw := desc.Manifest
	if desc.MediaType.IsIndex() {
		var idx v1.IndexManifest
		if err := json.Unmarshal(desc.Manifest, &idx); err != nil {
			return "", fmt.Errorf("%w: index: %v", ErrSignature, err)
		}
		var pick []v1.Descriptor
		for _, m := range idx.Manifests {
			if m.Platform != nil && m.Platform.OS == "linux" && m.Platform.Architecture == s.Arch && m.MediaType.IsImage() {
				pick = append(pick, m)
			}
		}
		if len(pick) != 1 {
			return "", fmt.Errorf("%w: the index has %d linux/%s images, want 1", ErrUnavailable, len(pick), s.Arch)
		}
		manifestDigest = pick[0].Digest.String()
		md := d.Context().Digest(manifestDigest)
		raw, err = s.getManifest(ctx, md, opts)
		if err != nil {
			return "", err
		}
	} else if !desc.MediaType.IsImage() {
		return "", fmt.Errorf("%w: unsupported media type %s", ErrUnavailable, desc.MediaType)
	}
	h, _ := v1.NewHash(manifestDigest)
	key := h.Hex

	lock := s.lock(key)
	lock.Lock()
	defer lock.Unlock()
	out := filepath.Join(s.Dir, "rootfs", key+".ext4")
	if fi, err := os.Lstat(out); err != nil || !fi.Mode().IsRegular() {
		var mf v1.Manifest
		if err := json.Unmarshal(raw, &mf); err != nil {
			return "", fmt.Errorf("%w: manifest: %v", ErrSignature, err)
		}
		if err := s.build(ctx, d.Context(), mf, ref, key, opts); err != nil {
			return "", err
		}
	}
	s.mu.Lock()
	if s.paths == nil {
		s.paths = map[string]string{}
	}
	s.paths[ref] = out
	s.mu.Unlock()
	return out, nil
}

func (s *Store) getManifest(ctx context.Context, d name.Digest, opts []remote.Option) ([]byte, error) {
	desc, err := remote.Get(d, opts...)
	if err != nil {
		return nil, fmt.Errorf("%w: manifest: %v", ErrUnavailable, err)
	}
	if err := checkManifest(desc.Manifest, d.DigestStr()); err != nil {
		return nil, err
	}
	if !desc.MediaType.IsImage() {
		return nil, fmt.Errorf("%w: unsupported media type %s", ErrUnavailable, desc.MediaType)
	}
	return desc.Manifest, nil
}

func checkManifest(raw []byte, want string) error {
	if len(raw) > maxManifest {
		return fmt.Errorf("%w: manifest too large", ErrUnavailable)
	}
	sum := sha256.Sum256(raw)
	if "sha256:"+hex.EncodeToString(sum[:]) != want {
		return fmt.Errorf("%w: manifest digest mismatch", ErrSignature)
	}
	return nil
}

func (s *Store) lock(key string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.locks == nil {
		s.locks = map[string]*sync.Mutex{}
	}
	if s.locks[key] == nil {
		s.locks[key] = &sync.Mutex{}
	}
	return s.locks[key]
}

type cacheMeta struct {
	Ref     string    `json:"ref"`
	BuiltAt time.Time `json:"built_at"`
}

// build downloads, verifies and unpacks the image into a temporary directory and turns it into
// <Dir>/rootfs/<key>.ext4 (root 0444), removing everything else it wrote.
func (s *Store) build(ctx context.Context, repo name.Repository, mf v1.Manifest, ref, key string, opts []remote.Option) error {
	for _, d := range []string{s.Dir, filepath.Join(s.Dir, "rootfs")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	tmp, err := os.MkdirTemp(s.Dir, "build-"+key[:12]+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	cfgRaw, err := s.blob(ctx, repo, mf.Config, opts, filepath.Join(tmp, "config"), maxConfig)
	if err != nil {
		return err
	}
	var cfg v1.ConfigFile
	if err := json.Unmarshal(cfgRaw, &cfg); err != nil {
		return fmt.Errorf("%w: image config: %v", ErrSignature, err)
	}
	if cfg.OS != "linux" || cfg.Architecture != s.Arch {
		return fmt.Errorf("%w: image is %s/%s, host is linux/%s", ErrUnavailable, cfg.OS, cfg.Architecture, s.Arch)
	}
	if len(cfg.RootFS.DiffIDs) != len(mf.Layers) {
		return fmt.Errorf("%w: %d layers, %d diff_ids", ErrSignature, len(mf.Layers), len(cfg.RootFS.DiffIDs))
	}
	var total int64
	for _, l := range mf.Layers {
		if l.Size <= 0 {
			return fmt.Errorf("%w: layer size", ErrSignature)
		}
		total += l.Size
	}
	if err := checkFree(s.Dir, total*4+(1<<30)); err != nil {
		return err
	}
	root := filepath.Join(tmp, "root")
	if err := os.Mkdir(root, 0o755); err != nil {
		return err
	}
	u := &unpacker{max: s.maxBytes()}
	if u.root, err = os.OpenRoot(root); err != nil {
		return err
	}
	defer u.root.Close()
	for i, l := range mf.Layers {
		file := filepath.Join(tmp, "layer-"+strconv.Itoa(i))
		if _, err := s.blob(ctx, repo, l, opts, file, 0); err != nil {
			return err
		}
		if err := u.applyFile(ctx, file, l.MediaType, cfg.RootFS.DiffIDs[i]); err != nil {
			return err
		}
		if err := os.Remove(file); err != nil {
			return err
		}
	}
	img := filepath.Join(tmp, "rootfs.ext4")
	if err := s.mkfs(ctx, root, img, u.bytes, u.entries); err != nil {
		return err
	}
	if err := os.Chmod(img, 0o444); err != nil {
		return err
	}
	meta, err := json.Marshal(cacheMeta{Ref: ref, BuiltAt: time.Now().UTC()})
	if err != nil {
		return err
	}
	dst := filepath.Join(s.Dir, "rootfs", key)
	if err := os.WriteFile(dst+".json.tmp", meta, 0o600); err != nil {
		return err
	}
	if err := os.Rename(dst+".json.tmp", dst+".json"); err != nil {
		return err
	}
	return os.Rename(img, dst+".ext4")
}

func (s *Store) maxBytes() int64 {
	if s.MaxBytes > 0 {
		return s.MaxBytes
	}
	return defaultMaxBytes
}

// blob downloads desc whole into file, checking size and digest; with keep > 0 it also returns
// the content (at most keep bytes).
func (s *Store) blob(ctx context.Context, repo name.Repository, desc v1.Descriptor, opts []remote.Option, file string, keep int64) ([]byte, error) {
	if keep > 0 && desc.Size > keep {
		return nil, fmt.Errorf("%w: blob too large", ErrUnavailable)
	}
	if desc.Digest.Algorithm != "sha256" {
		return nil, fmt.Errorf("%w: blob digest algorithm", ErrSignature)
	}
	l, err := remote.Layer(repo.Digest(desc.Digest.String()), opts...)
	if err != nil {
		return nil, fmt.Errorf("%w: blob: %v", ErrUnavailable, err)
	}
	rc, err := l.Compressed()
	if err != nil {
		return nil, fmt.Errorf("%w: blob: %v", ErrUnavailable, err)
	}
	defer rc.Close()
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	hw := sha256.New()
	// One byte more than the descriptor says, so an oversized blob is caught. The blob is read to
	// its end and hashed here (go-containerregistry checks digests only at EOF, which a tar reader
	// may never reach), so nothing unverified is ever unpacked.
	n, err := io.Copy(io.MultiWriter(f, hw), io.LimitReader(rc, desc.Size+1))
	if err != nil {
		return nil, fmt.Errorf("%w: blob: %v", ErrUnavailable, err)
	}
	if n != desc.Size {
		return nil, fmt.Errorf("%w: blob %s is %d bytes, want %d", ErrSignature, desc.Digest, n, desc.Size)
	}
	if "sha256:"+hex.EncodeToString(hw.Sum(nil)) != desc.Digest.String() {
		return nil, fmt.Errorf("%w: blob %s digest mismatch", ErrSignature, desc.Digest)
	}
	if err := f.Sync(); err != nil {
		return nil, err
	}
	if keep > 0 {
		return os.ReadFile(file)
	}
	return nil, nil
}

func checkFree(dir string, need int64) error {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return err
	}
	if free := int64(st.Bavail) * int64(st.Bsize); free < need {
		return fmt.Errorf("%w: %d bytes free in %s, the image needs about %d", ErrUnavailable, free, dir, need)
	}
	return nil
}

func (s *Store) mkfs(ctx context.Context, dir, img string, used int64, entries int) error {
	mkfs := s.Mkfs
	if mkfs == "" {
		mkfs = "mkfs.ext4"
	}
	// Room for metadata and block rounding: 20 % + 4 KiB per entry + 256 MiB.
	size := used + used/5 + int64(entries)*4096 + 256<<20
	size = (size + 4095) / 4096 * 4096
	inodes := entries + entries/5 + 1024
	f, err := os.OpenFile(img, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := f.Truncate(size); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, mkfs, "-q", "-F", "-t", "ext4", "-L", rootfsLabel, "-m", "0", "-b", "4096",
		"-N", strconv.Itoa(inodes), "-O", "^has_journal", "-E", "root_owner=0:0,lazy_itable_init=0,nodiscard", "-d", dir, img)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	var stderr bytes.Buffer
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("image: mkfs.ext4: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := min(len(p), l.n)
		l.n -= k
		_, _ = l.w.Write(p[:k])
	}
	return len(p), nil
}

// Prune removes cached root file systems whose image reference is no longer allowlisted, and any
// leftover build directory. In-use files stay valid for running VMs (they hold hard links).
func (s *Store) Prune(allow Allowlist) error {
	entries, err := os.ReadDir(s.Dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "build-") {
			if err := os.RemoveAll(filepath.Join(s.Dir, e.Name())); err != nil {
				return err
			}
		}
	}
	dir := filepath.Join(s.Dir, "rootfs")
	files, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, f := range files {
		n := f.Name()
		if !strings.HasSuffix(n, ".ext4") && !strings.HasSuffix(n, ".json") {
			_ = os.RemoveAll(filepath.Join(dir, n))
			continue
		}
		key := strings.TrimSuffix(strings.TrimSuffix(n, ".ext4"), ".json")
		keep := false
		if b, err := os.ReadFile(filepath.Join(dir, key+".json")); err == nil {
			var m cacheMeta
			keep = json.Unmarshal(b, &m) == nil && allow.Allowed(m.Ref)
		}
		if !keep {
			if err := os.Remove(filepath.Join(dir, n)); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------- unpacking

// unpacker applies layers in order onto a directory through os.Root (no path, symlink or hard
// link can reach outside it), with OCI whiteouts: `.wh.<name>` removes <name> from the layers
// below, `.wh..wh..opq` empties its directory of the layers below. Device nodes and FIFOs are
// skipped (kete-job-init mounts devtmpfs); extended attributes are not carried.
type unpacker struct {
	root    *os.Root
	max     int64
	bytes   int64
	entries int
	skipped int
}

const (
	whPrefix = ".wh."
	whOpaque = ".wh..wh..opq"
)

func (u *unpacker) applyFile(ctx context.Context, file string, mt types.MediaType, diffID v1.Hash) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	var r io.Reader = f
	switch mt {
	case types.OCILayer, types.DockerLayer, types.OCIRestrictedLayer, types.DockerForeignLayer:
		zr, err := gzip.NewReader(f)
		if err != nil {
			return fmt.Errorf("%w: layer: %v", ErrSignature, err)
		}
		defer zr.Close()
		r = zr
	case types.OCIUncompressedLayer, types.OCIUncompressedRestrictedLayer, types.DockerUncompressedLayer:
	default:
		return fmt.Errorf("%w: unsupported layer media type %s", ErrUnavailable, mt)
	}
	hw := sha256.New()
	if err := u.apply(ctx, io.TeeReader(r, hw)); err != nil {
		return err
	}
	// Read to the end so the diff_id covers the whole layer, not just up to tar's end marker.
	if _, err := io.Copy(hw, r); err != nil {
		return fmt.Errorf("%w: layer: %v", ErrSignature, err)
	}
	if diffID.Algorithm != "sha256" || hex.EncodeToString(hw.Sum(nil)) != diffID.Hex {
		return fmt.Errorf("%w: layer diff_id mismatch", ErrSignature)
	}
	return nil
}

func cleanName(n string) (string, bool) {
	for _, part := range strings.Split(n, "/") {
		if part == ".." {
			return "", false // refused, not normalised: no layer has a reason to name one
		}
	}
	n = strings.TrimPrefix(n, "./")
	n = path.Clean("/" + n)
	if n == "/" {
		return ".", true
	}
	n = strings.TrimPrefix(n, "/")
	if n == "" || strings.Contains(n, "\x00") || len(n) > 4096 {
		return "", false
	}
	for _, part := range strings.Split(n, "/") {
		if part == ".." {
			return "", false
		}
	}
	return n, true
}

func (u *unpacker) apply(ctx context.Context, r io.Reader) error {
	tr := tar.NewReader(r)
	written := map[string]bool{} // paths this layer wrote (whiteouts only affect lower layers)
	type dirMode struct {
		name string
		mode os.FileMode
	}
	var dirs []dirMode
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("%w: layer tar: %v", ErrSignature, err)
		}
		u.entries++
		if u.entries > maxEntries {
			return fmt.Errorf("%w: too many entries", ErrUnavailable)
		}
		n, ok := cleanName(h.Name)
		if !ok {
			return fmt.Errorf("%w: unsafe path %q", ErrSignature, h.Name)
		}
		dir, base := path.Split(n)
		dir = strings.TrimSuffix(dir, "/")
		if dir == "" {
			dir = "."
		}
		if base == whOpaque {
			if err := u.emptyDir(dir, written); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(base, whPrefix) {
			name := strings.TrimPrefix(base, whPrefix)
			if name == "" || name == "." || name == ".." || strings.HasPrefix(name, whPrefix) {
				return fmt.Errorf("%w: malformed whiteout %q", ErrSignature, h.Name)
			}
			target := path.Join(dir, name)
			if !written[target] {
				if err := u.root.RemoveAll(target); err != nil {
					return fmt.Errorf("image: whiteout %s: %w", target, err)
				}
			}
			continue
		}
		if n != "." {
			if err := u.root.MkdirAll(dir, 0o755); err != nil {
				return fmt.Errorf("image: %s: %w", dir, err)
			}
		}
		mode := os.FileMode(h.Mode) & 0o7777
		switch h.Typeflag {
		case tar.TypeDir:
			if fi, err := u.root.Lstat(n); err == nil && !fi.IsDir() {
				if err := u.root.Remove(n); err != nil {
					return err
				}
			}
			if err := u.root.MkdirAll(n, 0o755); err != nil {
				return fmt.Errorf("image: %s: %w", n, err)
			}
			if err := u.root.Lchown(n, h.Uid, h.Gid); err != nil {
				return err
			}
			dirs = append(dirs, dirMode{n, toGoMode(mode)})
		case tar.TypeReg:
			if err := u.replace(n); err != nil {
				return err
			}
			u.bytes += h.Size
			if u.bytes > u.max {
				return fmt.Errorf("%w: image larger than %d bytes", ErrUnavailable, u.max)
			}
			f, err := u.root.OpenFile(n, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return fmt.Errorf("image: %s: %w", n, err)
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return fmt.Errorf("image: %s: %w", n, err)
			}
			if err := u.root.Lchown(n, h.Uid, h.Gid); err != nil {
				return err
			}
			if err := u.root.Chmod(n, toGoMode(mode)); err != nil {
				return err
			}
			_ = u.root.Chtimes(n, h.ModTime, h.ModTime)
		case tar.TypeSymlink:
			if err := u.replace(n); err != nil {
				return err
			}
			if err := u.root.Symlink(h.Linkname, n); err != nil {
				return fmt.Errorf("image: symlink %s: %w", n, err)
			}
			if err := u.root.Lchown(n, h.Uid, h.Gid); err != nil {
				return err
			}
		case tar.TypeLink:
			target, ok := cleanName(h.Linkname)
			if !ok || target == "." {
				return fmt.Errorf("%w: unsafe hard link %q", ErrSignature, h.Linkname)
			}
			if fi, err := u.root.Lstat(target); err != nil || !fi.Mode().IsRegular() {
				return fmt.Errorf("%w: hard link %s to a missing or non-regular %s", ErrSignature, n, target)
			}
			if err := u.replace(n); err != nil {
				return err
			}
			if err := u.root.Link(target, n); err != nil {
				return fmt.Errorf("image: link %s: %w", n, err)
			}
		case tar.TypeChar, tar.TypeBlock, tar.TypeFifo:
			u.skipped++ // kete-job-init mounts devtmpfs; no device node comes from an image
			continue
		default:
			return fmt.Errorf("%w: unsupported tar entry type %q for %s", ErrUnavailable, h.Typeflag, h.Name)
		}
		// This layer wrote n and, implicitly, its parents: whiteouts here affect lower layers only.
		for p := n; p != "." && p != "" && !written[p]; p = path.Dir(p) {
			written[p] = true
		}
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := u.root.Chmod(dirs[i].name, dirs[i].mode); err != nil {
			return err
		}
	}
	return nil
}

// toGoMode converts tar permission bits (with setuid/setgid/sticky) to an os.FileMode.
func toGoMode(m os.FileMode) os.FileMode {
	g := m & 0o777
	if m&0o4000 != 0 {
		g |= os.ModeSetuid
	}
	if m&0o2000 != 0 {
		g |= os.ModeSetgid
	}
	if m&0o1000 != 0 {
		g |= os.ModeSticky
	}
	return g
}

// replace removes whatever is at n unless it is a directory being replaced by a directory.
func (u *unpacker) replace(n string) error {
	fi, err := u.root.Lstat(n)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return u.root.RemoveAll(n)
	}
	return u.root.Remove(n)
}

// emptyDir removes from dir everything the layers below put there (opaque whiteout): every child
// the current layer didn't write is removed, and directories it did write (or created implicitly
// as parents) are emptied the same way, recursively.
func (u *unpacker) emptyDir(dir string, written map[string]bool) error {
	f, err := u.root.Open(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	names, err := f.Readdirnames(-1)
	f.Close()
	if err != nil {
		return err
	}
	for _, c := range names {
		p := path.Join(dir, c)
		if !written[p] {
			if err := u.root.RemoveAll(p); err != nil {
				return err
			}
			continue
		}
		if fi, err := u.root.Lstat(p); err == nil && fi.IsDir() {
			if err := u.emptyDir(p, written); err != nil {
				return err
			}
		}
	}
	return nil
}
