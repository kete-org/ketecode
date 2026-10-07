//go:build linux

package hostguard

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// Paths are where Gather reads (Default; tests point them at a tree).
type Paths struct {
	NSDir       string   // /proc/self/ns
	Proc1Env    string   // /proc/1/environ
	MarkerFiles []string // MarkerFiles
	// NSInode returns a namespace's nsfs inode number (nil: statfs NSDir/<name> must be nsfs,
	// then its inode). Tests set it.
	NSInode func(name string) (uint64, error)
}

// Default are the real paths.
func Default() Paths {
	return Paths{NSDir: "/proc/self/ns", Proc1Env: "/proc/1/environ", MarkerFiles: MarkerFiles}
}

// Gather reads the facts. Anything unreadable is an error (the caller refuses).
func Gather(p Paths) (Facts, error) {
	ino := p.NSInode
	if ino == nil {
		ino = func(name string) (uint64, error) { return NSInode(filepath.Join(p.NSDir, name)) }
	}
	var f Facts
	var err error
	if f.UserNS, err = ino("user"); err != nil {
		return Facts{}, err
	}
	if f.PIDNS, err = ino("pid"); err != nil {
		return Facts{}, err
	}
	for _, m := range p.MarkerFiles {
		if _, err := os.Lstat(m); err == nil {
			f.Markers = append(f.Markers, m)
		} else if !errors.Is(err, os.ErrNotExist) {
			return Facts{}, err
		}
	}
	env, err := os.Open(p.Proc1Env)
	if err != nil {
		return Facts{}, err
	}
	defer env.Close()
	b, err := io.ReadAll(io.LimitReader(env, 1<<20))
	if err != nil {
		return Facts{}, err
	}
	f.ContainerEnv = ContainerEnv(b)
	return f, nil
}

// NSInode is a namespace file's nsfs inode number; a file that isn't on nsfs is an error.
func NSInode(path string) (uint64, error) {
	var sfs unix.Statfs_t
	if err := unix.Statfs(path, &sfs); err != nil {
		return 0, err
	}
	if uint32(sfs.Type) != unix.NSFS_MAGIC {
		return 0, fmt.Errorf("hostguard: %s is not on nsfs", path)
	}
	var st unix.Stat_t
	if err := unix.Stat(path, &st); err != nil {
		return 0, err
	}
	return st.Ino, nil
}

// Run gathers and checks.
func Run(p Paths) error {
	f, err := Gather(p)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrContainer, err)
	}
	return Check(f)
}
