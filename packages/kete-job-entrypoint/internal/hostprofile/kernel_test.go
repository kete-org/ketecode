package hostprofile

import (
	"strings"
	"testing"
)

// Mount tables as the guard sees them (abridged from real ones; fields as in proc(5)).
const (
	// A privileged Docker container (S0 r2's shape): overlay root, Docker's bind mounts of
	// resolv.conf, hostname and hosts.
	mountsDocker = `1279 1180 0:121 / / rw,relatime master:540 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/A,upperdir=/var/lib/docker/overlay2/x/diff,workdir=/var/lib/docker/overlay2/x/work
1280 1279 0:124 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
1281 1279 0:125 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
1290 1279 0:129 / /sys rw,nosuid,nodev,noexec,relatime - sysfs sysfs rw
1291 1290 0:30 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw,nsdelegate
1295 1279 259:1 /var/lib/docker/containers/abc/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/root rw
1296 1279 259:1 /var/lib/docker/containers/abc/hostname /etc/hostname rw,relatime - ext4 /dev/root rw
1297 1279 259:1 /var/lib/docker/containers/abc/hosts /etc/hosts rw,relatime - ext4 /dev/root rw
`
	// A capability-only Kubernetes pod under containerd (S0 r3's shape): kubelet's hosts and
	// termination log, the sandbox's hostname and resolv.conf, the service account.
	mountsPod = `2337 2268 0:345 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/rancher/k3s/agent/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/9/fs
2338 2337 0:350 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
2341 2337 0:352 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
2346 2337 254:1 /var/lib/kubelet/pods/5f0e/etc-hosts /etc/hosts rw,relatime - ext4 /dev/vda1 rw
2347 2337 254:1 /var/lib/kubelet/pods/5f0e/containers/job/2a1b /dev/termination-log rw,relatime - ext4 /dev/vda1 rw
2348 2337 254:1 /var/lib/rancher/k3s/agent/containerd/io.containerd.grpc.v1.cri/sandboxes/77/hostname /etc/hostname rw,relatime - ext4 /dev/vda1 rw
2349 2337 254:1 /var/lib/rancher/k3s/agent/containerd/io.containerd.grpc.v1.cri/sandboxes/77/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vda1 rw
2350 2337 0:340 / /run/secrets/kubernetes.io/serviceaccount ro,relatime - tmpfs tmpfs rw,size=1024k
`
	// The dedicated reaper's job root (kete-job-host internal/driver/dedicated initMounts): overlay
	// root, then proc, a read-only sys, a tmpfs dev with devpts and shm, run, cgroup2.
	mountsDedicated = `801 640 0:64 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/kete-job-host/dedicated/m/lower,upperdir=/var/lib/kete-job-host/dedicated/m/scratch/upper,workdir=/var/lib/kete-job-host/dedicated/m/scratch/work
802 801 0:66 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
803 801 0:67 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
804 801 0:68 / /dev rw,nosuid,noexec,relatime - tmpfs tmpfs rw,size=1024k,nr_inodes=64,mode=755
805 804 0:69 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620,ptmxmode=666
806 804 0:70 / /dev/shm rw,nosuid,nodev,relatime - tmpfs tmpfs rw
807 801 0:71 / /run rw,nosuid,nodev,relatime - tmpfs tmpfs rw,mode=755
808 803 0:30 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup2 rw,nsdelegate
`
	// A firecracker guest after kete-job-init (overlay on the scratch disk, the moved /proc, /sys
	// and /dev, then cgroup2, /run and /dev/shm).
	mountsVM = `21 1 0:20 / / rw,relatime - overlay overlay rw,lowerdir=/,upperdir=/mnt/upper,workdir=/mnt/work
22 21 0:21 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
23 21 0:22 / /sys rw,nosuid,nodev,noexec,relatime - sysfs sysfs rw
24 21 0:5 / /dev rw,nosuid,noexec,relatime - devtmpfs devtmpfs rw,size=1000k,mode=755
25 23 0:23 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup2 rw,nsdelegate
26 21 0:24 / /run rw,nosuid,nodev,relatime - tmpfs tmpfs rw,mode=755
`
)

// The four machines' kernel facts, as GatherKernel builds them.
func privilegedDocker() Kernel {
	return Kernel{UserNSInitial: true, PID1Args: ParseArgs([]byte("bash\x00scripts/integration.sh\x00")), RuntimeMount: RuntimeMountIn(mountsDocker), MarkerFile: true}
}

func capabilityPod() Kernel {
	return Kernel{UserNSInitial: true, PID1Args: ParseArgs([]byte("/bin/sh\x00-c\x00exec /usr/local/libexec/kete/kete-job-entrypoint --config-fd 0\x00")), RuntimeMount: RuntimeMountIn(mountsPod)}
}

const entrypointExe = "/usr/local/libexec/kete/kete-job-entrypoint"

func dedicatedKernel() Kernel {
	return Kernel{UserNSInitial: true, PID1Args: ParseArgs([]byte("/proc/self/exe\x00" + DedicatedInitArg + "\x00")), PPID: 1, SelfExe: entrypointExe, RuntimeMount: RuntimeMountIn(mountsDedicated)}
}

func vmKernel() Kernel {
	return Kernel{UserNSInitial: true, PIDNSInitial: true, PID1Args: ParseArgs([]byte("/usr/local/libexec/kete/kete-job-init\x00__guest\x00")), RuntimeMount: RuntimeMountIn(mountsVM)}
}

func TestRuntimeMountIn(t *testing.T) {
	for _, c := range []struct{ name, mi, want string }{
		{"docker", mountsDocker, "/etc/resolv.conf"},
		{"pod", mountsPod, "/etc/hosts"},
		{"dedicated", mountsDedicated, ""},
		{"vm", mountsVM, ""},
		{"pod without /etc mounts", "1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /dev/termination-log rw - ext4 /dev/vda1 rw\n", "/dev/termination-log"},
		{"service account only", "1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /var/run/secrets/kubernetes.io/serviceaccount ro - tmpfs tmpfs rw\n", "/var/run/secrets/kubernetes.io/serviceaccount"},
		{"/etc itself", "1 0 0:1 / /etc rw - ext4 /dev/vda1 rw\n", "/etc"},
		{"a sibling name is not under /etc", "1 0 0:1 / /etcetera rw - ext4 /dev/vda1 rw\n2 1 0:2 / /run/secretsx rw - tmpfs tmpfs rw\n", ""},
		{"escaped mount point", "1 0 0:1 / /etc/a\\040b rw - ext4 /dev/vda1 rw\n", "/etc/a b"},
		{"short and empty lines", "\n1 0\n", ""},
	} {
		if got := RuntimeMountIn(c.mi); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestParseArgs(t *testing.T) {
	for _, c := range []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"\x00", nil},
		{"/proc/self/exe\x00__dedicated-init\x00", []string{"/proc/self/exe", "__dedicated-init"}},
		{"a\x00\x00b\x00", []string{"a", "", "b"}},
		{"no-terminator", []string{"no-terminator"}},
	} {
		if got := ParseArgs([]byte(c.in)); strings.Join(got, "|") != strings.Join(c.want, "|") || len(got) != len(c.want) {
			t.Errorf("ParseArgs(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestGuardRules: the VM rule passes only the VM; the dedicated rule only the reaper's set-up, and
// each of its conditions refuses on its own.
func TestGuardRules(t *testing.T) {
	machines := map[string]Kernel{"privileged docker": privilegedDocker(), "capability pod": capabilityPod(), "dedicated": dedicatedKernel(), "vm": vmKernel()}
	for name, k := range machines {
		if got, want := OwnKernel(k), name == "vm"; got != want {
			t.Errorf("OwnKernel(%s) = %v", name, got)
		}
		if got, want := DedicatedReaper(k), name == "dedicated"; got != want {
			t.Errorf("DedicatedReaper(%s) = %v", name, got)
		}
	}
	for name, mod := range map[string]func(*Kernel){
		"another user namespace":  func(k *Kernel) { k.UserNSInitial = false },
		"the initial pid ns":      func(k *Kernel) { k.PIDNSInitial = true },
		"PID 1 unreadable":        func(k *Kernel) { k.PID1Args = nil },
		"PID 1 another program":   func(k *Kernel) { k.PID1Args = []string{"/sbin/tini", "--"} },
		"PID 1 with extra args":   func(k *Kernel) { k.PID1Args = append(k.PID1Args, "x") },
		"a runtime mount":         func(k *Kernel) { k.RuntimeMount = "/etc/hosts" },
		"a container marker file": func(k *Kernel) { k.MarkerFile = true },
		"container= for PID 1":    func(k *Kernel) { k.PID1Env = true },
		"parent isn't PID 1":      func(k *Kernel) { k.PPID = 7 },
		"PID 1 is this program":   func(k *Kernel) { k.PID1Args = []string{entrypointExe, DedicatedInitArg} },
		"PID 1 is a copy of it":   func(k *Kernel) { k.PID1Args = []string{"/tmp/kete-job-entrypoint", DedicatedInitArg} },
	} {
		k := dedicatedKernel()
		mod(&k)
		if DedicatedReaper(k) {
			t.Errorf("dedicated with %s passes", name)
		}
	}
	if OwnKernel(Kernel{PIDNSInitial: true}) || OwnKernel(Kernel{UserNSInitial: true}) {
		t.Error("OwnKernel needs both initial namespaces")
	}
}

func TestContainerEnvAndParentPID(t *testing.T) {
	for in, want := range map[string]bool{"": false, "PATH=/bin\x00": false, "PATH=/bin\x00container=docker\x00": true, "container=\x00": false, "xcontainer=1\x00": false} {
		if ContainerEnv([]byte(in)) != want {
			t.Errorf("ContainerEnv(%q) != %v", in, want)
		}
	}
	for in, want := range map[string]int{"12 (kete-job-entry) S 1 12 12 0": 1, "40 (a) b) R 39 40": 39} {
		if got, err := ParentPID([]byte(in)); err != nil || got != want {
			t.Errorf("ParentPID(%q) = %d, %v", in, got, err)
		}
	}
	for _, in := range []string{"", "12 (x", "12 (x) S", "12 (x) S y"} {
		if _, err := ParentPID([]byte(in)); err == nil {
			t.Errorf("ParentPID(%q) accepted", in)
		}
	}
}
