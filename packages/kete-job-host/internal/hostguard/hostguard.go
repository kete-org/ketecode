// Package hostguard is the host agent's shared-kernel guard (task
// docs/tasks/2026-10-07-shared-kernel-guard): the firecracker and dedicated drivers write host
// kernel state (the host nftables table, IP forwarding, cgroups, loop devices, and on a dedicated
// host the job itself writes the host's sysctls), which is only right when the agent runs on the
// host itself, not in a container on someone else's node (a privileged DaemonSet, `docker run
// --privileged`). The agent must be in the kernel's initial user and PID namespaces (their nsfs
// inode numbers are fixed kernel constants), and no container marker may be present: Docker's
// /.dockerenv, Podman's /run/.containerenv, systemd's /run/systemd/container and
// /run/host/container-manager, or `container=` in PID 1's environment. Drivers run it first in
// Init; `kete-job-host doctor` reports it.
//
// It stops the agent being installed in a container by mistake; it is not a defence against a
// host administrator deliberately disguising a container, who owns the kernel anyway.
package hostguard

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
)

// Initial namespaces' nsfs inode numbers (include/linux/proc_ns.h: PROC_USER_INIT_INO,
// PROC_PID_INIT_INO); every other namespace's is 0xF0000000 or above.
const (
	InitUserNSIno uint64 = 0xEFFFFFFD
	InitPIDNSIno  uint64 = 0xEFFFFFFC
)

// MarkerFiles are files container managers leave in a container's root.
var MarkerFiles = []string{"/.dockerenv", "/run/.containerenv", "/run/systemd/container", "/run/host/container-manager"}

// Facts are what the guard decides on (Gather reads them).
type Facts struct {
	UserNS, PIDNS uint64   // nsfs inode numbers of this process's namespaces
	Markers       []string // MarkerFiles that exist
	ContainerEnv  bool     // PID 1's environment sets `container=`
}

// ErrContainer is the guard's refusal.
var ErrContainer = errors.New("hostguard: the agent is not running on the host itself (shared kernel)")

// Check refuses unless the facts show the host itself.
func Check(f Facts) error {
	var why []string
	if f.UserNS != InitUserNSIno {
		why = append(why, "not the initial user namespace")
	}
	if f.PIDNS != InitPIDNSIno {
		why = append(why, "not the initial PID namespace")
	}
	for _, m := range f.Markers {
		why = append(why, m+" exists")
	}
	if f.ContainerEnv {
		why = append(why, "PID 1's environment sets container=")
	}
	if len(why) > 0 {
		return fmt.Errorf("%w: %s", ErrContainer, strings.Join(why, "; "))
	}
	return nil
}

// ContainerEnv reports whether /proc/<pid>/environ content sets a non-empty `container=`.
func ContainerEnv(environ []byte) bool {
	for _, kv := range bytes.Split(environ, []byte{0}) {
		if v, ok := bytes.CutPrefix(kv, []byte("container=")); ok && len(v) > 0 {
			return true
		}
	}
	return false
}
