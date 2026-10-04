// Package setup prepares the machine before the network guard and the claim (steps 0 and
// 1b-1e): the entrypoint's own process settings, the sysctls, /proc with hidepid=2, Fly's API
// directory, and every directory of the fixed layout, created through fds opened O_NOFOLLOW so a
// pre-existing symlink can't redirect anything.
package setup

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// FlyAPISockets are Fly's machine API sockets, relative to the Fly directory: `/.fly/api` is the
// only one Fly documents (the Machines API, authenticated as the machine). A socket anywhere else
// is caught by the isolation check's sweep of every listening unix socket.
var FlyAPISockets = []string{"api"}

// FlySocketPaths are FlyAPISockets under dir.
func FlySocketPaths(dir string) []string {
	out := make([]string, len(FlyAPISockets))
	for i, n := range FlyAPISockets {
		out[i] = filepath.Join(dir, n)
	}
	return out
}

// ErrFlyAPIMissing: the machine runs on Fly, but Fly's API directory or socket isn't where the
// guard expects it (fail closed: the phase line is setup_fly failed "missing").
var ErrFlyAPIMissing = errors.New("on Fly, but the machine API socket is not at the expected path")

// Dir is one directory of the layout.
type Dir struct {
	Path     string
	UID, GID uint32
	Mode     os.FileMode // permission bits plus os.ModeSetgid where needed
}

// Sysctl is one value written and read back.
type Sysctl struct {
	Path  string // under /proc/sys
	Value string
}

// Sysctls are the values the job needs (step 1b; egress README "Not done here", D6).
func Sysctls(procMount string) []Sysctl {
	return []Sysctl{
		{procMount + "/sys/fs/protected_hardlinks", "1"},
		{procMount + "/sys/fs/protected_symlinks", "1"},
		{procMount + "/sys/user/max_user_namespaces", "0"},
	}
}

// HidepidMounted reports whether /proc/self/mountinfo content shows procMount mounted with
// hidepid=2 (newer kernels print it as hidepid=invisible).
func HidepidMounted(mountinfo, procMount string) bool {
	for _, line := range strings.Split(mountinfo, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[4] != procMount {
			continue
		}
		for i, f := range fields {
			if f == "-" && i+3 < len(fields) && fields[i+1] == "proc" {
				for _, opt := range strings.Split(fields[i+3], ",") {
					if opt == "hidepid=2" || opt == "hidepid=invisible" {
						return true
					}
				}
			}
		}
	}
	return false
}
