package hostprofile

import (
	"bytes"
	"errors"
	"path"
	"strconv"
	"strings"
)

// The shared-kernel guard (module README "Shared-kernel guard"; spike S0 runs r2/r3): every
// profile but fly writes kernel state (sysctls, mounts, nftables, cgroups), so before anything is
// written the entrypoint and kete-job-init must know whose kernel that state belongs to. Virtio and
// DMI signals can't tell (a container on a VM node shows the VM's), so the guard uses facts a
// container runtime can't present by accident:
//
//	microvm, cloudvm  the process is in the kernel's initial PID and user namespaces (their nsfs
//	                  inode numbers are fixed kernel constants) and PID 1 is kete-job-init (Check's
//	                  init rule): kete-job-init is then the kernel's own init, so the kernel is the
//	                  VM's, booted for this job. A container is never in the initial PID namespace
//	                  (one sharing the host's has the host's init as PID 1, not kete-job-init).
//	dedicated         the job deliberately runs in the dedicated host's own kernel (kete-job-host's
//	                  dedicated driver; the host is single-tenant and rebuilt after the job). The
//	                  guard proves the dedicated driver set the job up: the initial user namespace,
//	                  a PID namespace that isn't the initial one, PID 1 the driver's reaper
//	                  (argv exactly [<exe>, DedicatedInitArg], not this program) and this process's
//	                  parent, and none of the marks container runtimes leave (RuntimeMountPrefixes
//	                  in the mount table, ContainerMarkerFiles, `container=` in PID 1's
//	                  environment).
//
// The guard defends against running the image where it doesn't belong (a Kubernetes or Docker
// container with the dedicated or a VM profile, which in S0 changed a node's sysctls); it is not a
// defence against a host administrator who deliberately imitates the driver, who owns the kernel
// anyway.

// Initial namespaces' nsfs inode numbers (include/linux/proc_ns.h: PROC_USER_INIT_INO,
// PROC_PID_INIT_INO). Every other namespace gets a number from 0xF0000000 up.
const (
	InitUserNSIno uint64 = 0xEFFFFFFD
	InitPIDNSIno  uint64 = 0xEFFFFFFC
)

// DedicatedInitArg is argv[1] of kete-job-host's dedicated reaper (packages/kete-job-host
// internal/driver/dedicated InitArg): PID 1 of a dedicated job's namespaces. Change both together.
const DedicatedInitArg = "__dedicated-init"

// RuntimeMountPrefixes are mount points container runtimes create and the dedicated reaper never
// does: Docker, Podman and every CRI runtime bind-mount /etc/hosts, /etc/hostname and
// /etc/resolv.conf (the reaper writes them as files in the job's root); Kubernetes adds
// /dev/termination-log and the service account under /run/secrets or /var/run/secrets. A mount
// point equal to a prefix or below it counts.
var RuntimeMountPrefixes = []string{"/etc", "/dev/termination-log", "/run/secrets", "/var/run/secrets"}

// ContainerMarkerFiles are files container managers leave in a container's root: Docker's,
// Podman's, and systemd's container interface (/run/systemd/container, /run/host/container-manager).
var ContainerMarkerFiles = []string{"/.dockerenv", "/run/.containerenv", "/run/systemd/container", "/run/host/container-manager"}

// Kernel is what the machine shows about whose kernel the entrypoint runs in (GatherKernel).
type Kernel struct {
	UserNSInitial bool     // the kernel's initial user namespace
	PIDNSInitial  bool     // the kernel's initial PID namespace
	PID1Args      []string // PID 1's argv (nil when unreadable)
	PID1Env       bool     // PID 1's environment sets `container=` (systemd's container interface)
	PPID          int      // this process's parent
	SelfExe       string   // this process's executable
	RuntimeMount  string   // the first mount point under RuntimeMountPrefixes, or ""
	MarkerFile    bool     // one of ContainerMarkerFiles exists
}

// OwnKernel is the VM profiles' rule: the initial user and PID namespaces, so PID 1 (which Check
// requires to be kete-job-init) is the kernel's own init.
func OwnKernel(k Kernel) bool { return k.UserNSInitial && k.PIDNSInitial }

// DedicatedReaper is the dedicated profile's rule: set up by the dedicated driver's reaper, not by
// a container runtime.
func DedicatedReaper(k Kernel) bool {
	return k.UserNSInitial && !k.PIDNSInitial &&
		len(k.PID1Args) == 2 && k.PID1Args[1] == DedicatedInitArg &&
		k.PID1Args[0] != k.SelfExe && path.Base(k.PID1Args[0]) != path.Base(k.SelfExe) &&
		k.PPID == 1 && !k.PID1Env &&
		k.RuntimeMount == "" && !k.MarkerFile
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

// ParentPID is the ppid field of /proc/<pid>/stat content (the fourth field, counted after the
// command's closing parenthesis), or an error.
func ParentPID(stat []byte) (int, error) {
	i := bytes.LastIndexByte(stat, ')')
	if i < 0 {
		return 0, errors.New("hostprofile: malformed stat")
	}
	f := strings.Fields(string(stat[i+1:]))
	if len(f) < 2 {
		return 0, errors.New("hostprofile: malformed stat")
	}
	return strconv.Atoi(f[1])
}

// ParseArgs splits /proc/<pid>/cmdline content (NUL-terminated arguments) into argv.
func ParseArgs(b []byte) []string {
	b = bytes.TrimSuffix(b, []byte{0})
	if len(b) == 0 {
		return nil
	}
	return strings.Split(string(b), "\x00")
}

// RuntimeMountIn returns the first mount point in /proc/self/mountinfo content that is one of
// RuntimeMountPrefixes or below one, or "".
func RuntimeMountIn(mountinfo string) string {
	for _, line := range strings.Split(mountinfo, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		mp := unescapeMount(f[4])
		for _, p := range RuntimeMountPrefixes {
			if mp == p || strings.HasPrefix(mp, p+"/") {
				return mp
			}
		}
	}
	return ""
}

// unescapeMount decodes mountinfo's octal escapes (\040 for a space, \011, \012, \134).
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
