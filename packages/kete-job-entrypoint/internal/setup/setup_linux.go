//go:build linux

package setup

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// Self applies the entrypoint's own process settings: not dumpable (no other process of any uid
// can ptrace it or read its memory, which holds every credential), oom_score_adj −1000, umask 022.
func Self() error {
	if err := unix.Prctl(unix.PR_SET_DUMPABLE, 0, 0, 0, 0); err != nil {
		return fmt.Errorf("PR_SET_DUMPABLE: %w", err)
	}
	if err := writeReadBack("/proc/self/oom_score_adj", "-1000"); err != nil {
		return err
	}
	unix.Umask(0o022)
	return nil
}

// ApplySysctls writes and reads back each value.
func ApplySysctls(list []Sysctl) error {
	for _, s := range list {
		if err := writeReadBack(s.Path, s.Value); err != nil {
			return err
		}
	}
	return nil
}

func writeReadBack(path, value string) error {
	fd, err := unix.Open(path, unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	defer unix.Close(fd)
	if _, err := unix.Write(fd, []byte(value)); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	buf := make([]byte, 64)
	n, err := unix.Pread(fd, buf, 0)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if got := strings.TrimSpace(string(buf[:n])); got != value {
		return fmt.Errorf("%s reads back %q, want %q", path, got, value)
	}
	return nil
}

// RemountProc remounts procMount with hidepid=2 and checks it took effect.
func RemountProc(procMount string) error {
	if err := unix.Mount("proc", procMount, "proc", unix.MS_REMOUNT|unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, "hidepid=2"); err != nil {
		return fmt.Errorf("remount %s: %w", procMount, err)
	}
	mi, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	if !HidepidMounted(string(mi), procMount) {
		return fmt.Errorf("%s is not mounted with hidepid=2", procMount)
	}
	return nil
}

// LockFly makes Fly's API directory (/.fly) root 0700 and each of its API sockets (FlyAPISockets)
// root 0600, then checks both took. It fails closed: on Fly (onFly, from Fly's own machine
// variables, or the directory existing at all) a missing directory or socket is ErrFlyAPIMissing,
// since the socket could then be somewhere this guard doesn't cover. Only off Fly (no variable,
// no directory) is it a no-op. The isolation check then confirms, as the tool user, that no
// listening unix socket (wherever it is) is reachable.
func LockFly(dir string, onFly bool) error {
	var st unix.Stat_t
	if err := unix.Lstat(dir, &st); err != nil {
		if errors.Is(err, unix.ENOENT) {
			if onFly {
				return ErrFlyAPIMissing
			}
			return nil
		}
		return err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fmt.Errorf("%s is not a directory", dir)
	}
	fd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if err := unix.Fchown(fd, 0, 0); err != nil {
		return err
	}
	if err := unix.Fchmod(fd, 0o700); err != nil {
		return err
	}
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Uid != 0 || st.Gid != 0 || st.Mode&0o7777 != 0o700 {
		return fmt.Errorf("%s did not become root 0700", dir)
	}
	// The directory is root-only now, so nothing else can swap a socket for a symlink below.
	for _, name := range FlyAPISockets {
		if err := unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			if errors.Is(err, unix.ENOENT) {
				return ErrFlyAPIMissing
			}
			return err
		}
		if st.Mode&unix.S_IFMT != unix.S_IFSOCK {
			return fmt.Errorf("%s/%s is not a socket", dir, name)
		}
		if err := unix.Fchownat(fd, name, 0, 0, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if err := unix.Fchmodat(fd, name, 0o600, 0); err != nil {
			return err
		}
		if err := unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if st.Mode&unix.S_IFMT != unix.S_IFSOCK || st.Uid != 0 || st.Gid != 0 || st.Mode&0o7777 != 0o600 {
			return fmt.Errorf("%s/%s did not become root 0600", dir, name)
		}
	}
	return nil
}

// FlyPresent is LockFly's presence check alone, reading only: Fly's API directory and each of its
// API sockets exist (ErrFlyAPIMissing otherwise; not a directory or not a socket is an error). The
// entrypoint runs it on the fly profile before it writes anything, so a container claiming to be
// a Fly machine on Fly's variables alone never gets as far as the sysctls.
func FlyPresent(dir string) error {
	var st unix.Stat_t
	if err := unix.Lstat(dir, &st); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return ErrFlyAPIMissing
		}
		return err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return fmt.Errorf("%s is not a directory", dir)
	}
	for _, name := range FlyAPISockets {
		if err := unix.Lstat(filepath.Join(dir, name), &st); err != nil {
			if errors.Is(err, unix.ENOENT) {
				return ErrFlyAPIMissing
			}
			return err
		}
		if st.Mode&unix.S_IFMT != unix.S_IFSOCK {
			return fmt.Errorf("%s/%s is not a socket", dir, name)
		}
	}
	return nil
}

// OpenDirNoFollow opens an absolute directory path one component at a time from /, refusing a
// symlink anywhere.
func OpenDirNoFollow(path string, flags int) (int, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return -1, fmt.Errorf("%q is not an absolute, clean path", path)
	}
	fd, err := unix.Open("/", unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	if path == "/" {
		return fd, nil
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, part := range parts {
		fl := unix.O_PATH | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if i == len(parts)-1 {
			fl = flags | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		}
		next, err := unix.Openat(fd, part, fl, 0)
		unix.Close(fd)
		if err != nil {
			return -1, fmt.Errorf("open %s: %w", path, err)
		}
		fd = next
	}
	return fd, nil
}

// MakeDirs creates each directory in order (parents first). The parent of each must already be
// a directory reached without a symlink; an existing leaf must be a directory owned by the
// expected uid and gid (its mode is then reset), anything else aborts.
func MakeDirs(dirs []Dir) error {
	for _, d := range dirs {
		if err := makeDir(d); err != nil {
			return err
		}
	}
	return nil
}

func permBits(m os.FileMode) uint32 {
	bits := uint32(m.Perm())
	if m&os.ModeSetgid != 0 {
		bits |= unix.S_ISGID
	}
	return bits
}

func makeDir(d Dir) error {
	parentFD, err := OpenDirNoFollow(filepath.Dir(d.Path), unix.O_PATH)
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)
	name := filepath.Base(d.Path)
	if err := unix.Mkdirat(parentFD, name, 0o700); err != nil {
		if !errors.Is(err, unix.EEXIST) {
			return fmt.Errorf("mkdir %s: %w", d.Path, err)
		}
		var st unix.Stat_t
		if err := unix.Fstatat(parentFD, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return err
		}
		if st.Mode&unix.S_IFMT != unix.S_IFDIR || st.Uid != d.UID || st.Gid != d.GID {
			return fmt.Errorf("%s exists and is not a directory owned by %d:%d", d.Path, d.UID, d.GID)
		}
	}
	fd, err := unix.Openat(parentFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", d.Path, err)
	}
	defer unix.Close(fd)
	if err := unix.Fchown(fd, int(d.UID), int(d.GID)); err != nil {
		return err
	}
	want := permBits(d.Mode)
	if err := unix.Fchmod(fd, want); err != nil {
		return err
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Uid != d.UID || st.Gid != d.GID || st.Mode&0o7777 != want {
		return fmt.Errorf("%s: ownership or mode did not apply", d.Path)
	}
	return nil
}

// CreateRootFile creates (or truncates) a root-owned 0600 regular file, refusing a symlink.
func CreateRootFile(path string, appendMode bool) (*os.File, error) {
	parentFD, err := OpenDirNoFollow(filepath.Dir(path), unix.O_PATH)
	if err != nil {
		return nil, err
	}
	defer unix.Close(parentFD)
	flags := unix.O_WRONLY | unix.O_CREAT | unix.O_NOFOLLOW | unix.O_CLOEXEC
	if appendMode {
		flags |= unix.O_APPEND
	} else {
		flags |= unix.O_TRUNC
	}
	fd, err := unix.Openat(parentFD, filepath.Base(path), flags, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil || st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fd)
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if err := unix.Fchown(fd, 0, 0); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if err := unix.Fchmod(fd, 0o600); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}

// OpenNoFollow opens a regular file for reading beneath a directory, one component at a time,
// refusing symlinks; it returns the file and its size.
func OpenNoFollow(dir string, rel []string) (*os.File, int64, error) {
	fd, err := OpenDirNoFollow(dir, unix.O_PATH)
	if err != nil {
		return nil, 0, err
	}
	for i, part := range rel {
		if part == "" || part == "." || part == ".." || strings.Contains(part, "/") {
			unix.Close(fd)
			return nil, 0, fmt.Errorf("bad path component %q", part)
		}
		fl := unix.O_PATH | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if i == len(rel)-1 {
			fl = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
		}
		next, err := unix.Openat(fd, part, fl, 0)
		unix.Close(fd)
		if err != nil {
			return nil, 0, err
		}
		fd = next
	}
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		unix.Close(fd)
		return nil, 0, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(fd)
		return nil, 0, errors.New("not a regular file")
	}
	return os.NewFile(uintptr(fd), filepath.Join(append([]string{dir}, rel...)...)), st.Size, nil
}

// WriteFileAtomic writes data to path (temp file in the same directory, then rename), with the
// given owner and mode.
func WriteFileAtomic(path string, data []byte, uid, gid uint32, mode uint32) error {
	parentFD, err := OpenDirNoFollow(filepath.Dir(path), unix.O_PATH)
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)
	tmp := "." + filepath.Base(path) + ".tmp"
	_ = unix.Unlinkat(parentFD, tmp, 0)
	fd, err := unix.Openat(parentFD, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), tmp)
	_, werr := f.Write(data)
	if werr == nil {
		werr = f.Chown(int(uid), int(gid))
	}
	if werr == nil {
		werr = f.Chmod(os.FileMode(mode))
	}
	if werr == nil {
		werr = f.Sync()
	}
	cerr := f.Close()
	if werr != nil || cerr != nil {
		_ = unix.Unlinkat(parentFD, tmp, 0)
		if werr != nil {
			return werr
		}
		return cerr
	}
	return unix.Renameat(parentFD, tmp, parentFD, filepath.Base(path))
}

// CreateExclusive creates a new file (O_EXCL) owned by uid:gid with mode, and writes data.
func CreateExclusive(path string, data []byte, uid, gid uint32, mode uint32) error {
	parentFD, err := OpenDirNoFollow(filepath.Dir(path), unix.O_PATH)
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)
	fd, err := unix.Openat(parentFD, filepath.Base(path), unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), path)
	_, werr := f.Write(data)
	if werr == nil {
		werr = f.Chown(int(uid), int(gid))
	}
	if werr == nil {
		werr = f.Chmod(os.FileMode(mode))
	}
	cerr := f.Close()
	if werr != nil {
		return werr
	}
	return cerr
}
