// Package firecracker is the agent's `firecracker` driver (kete-code-platform ADR 0023 rule 7):
// one Firecracker microVM per job, each under the jailer (its own uid and gid, a chroot, the
// default seccomp filters, a new PID namespace, cgroup v2 limits of the job size), with no API
// socket, no MMDS and no vsock, booted from Kete's guest kernel and the job image's read-only
// root file system, with a per-job ext4 scratch disk and the read-only config disk, on one tap
// and /30 behind the host table (internal/hostnet).
//
// This file renders the jailer arguments, the VM configuration and the kernel command line; none
// of them ever holds the machine configuration (it reaches the guest only on the config disk).
package firecracker

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/hostnet"
)

// Fixed names inside a jail (the chroot's root).
const (
	jailKernel  = "vmlinux"
	jailRootfs  = "rootfs.ext4"
	jailScratch = "scratch.ext4"
	// jailConfigDir is a small tmpfs mounted in the jail for the config disk, so the claim token never
	// reaches a persistent file system; jailConfig is the disk's path inside the jail.
	jailConfigDir = "cfg"
	jailConfig    = jailConfigDir + "/config.img"
	jailVMJSON    = "vm-config.json"
	jailLog       = "firecracker.log"
	// ParentCgroup holds every VM's cgroup, outside the agent unit's, so an agent restart or stop
	// leaves VMs running (reconcile then re-adopts or destroys them).
	ParentCgroup = "kete-job-host-vms"
	initPath     = "/usr/local/libexec/kete/kete-job-init"
	pidsMax      = 256
)

// machine is everything rendered for one VM.
type machine struct {
	ID          string
	UID         int
	ExecFile    string // the firecracker binary
	ChrootBase  string // <state>/jail
	VCPUs       int
	MemoryMiB   int
	OverheadMiB int
	ScratchGiB  int
	Slot        hostnet.Slot
	Resolvers   []netip.Addr
	NetMbps     int
	DiskMBps    int
	DiskIOPS    int
}

// jailerArgs are the jailer's arguments (after the binary).
func jailerArgs(m machine) []string {
	cpu := fmt.Sprintf("cpu.max=%d 100000", m.VCPUs*100_000)
	mem := fmt.Sprintf("memory.max=%d", int64(m.MemoryMiB+m.OverheadMiB)<<20)
	return []string{
		"--id", m.ID,
		"--exec-file", m.ExecFile,
		"--uid", strconv.Itoa(m.UID),
		"--gid", strconv.Itoa(m.UID),
		"--chroot-base-dir", m.ChrootBase,
		"--cgroup-version", "2",
		"--parent-cgroup", ParentCgroup,
		"--cgroup", cpu,
		"--cgroup", mem,
		"--cgroup", "pids.max=" + strconv.Itoa(pidsMax),
		"--new-pid-ns",
		"--resource-limit", "no-file=1024",
		// The scratch disk is preallocated sparse at its full size, so no write grows a file past it.
		"--resource-limit", "fsize=" + strconv.FormatInt(int64(m.ScratchGiB)<<30, 10),
		"--",
		"--config-file", "/" + jailVMJSON,
		"--no-api",
	}
}

// bootArgs is the guest kernel command line: serial console, reboot on panic (kete-job-init's
// last resort; Firecracker exits on a guest reboot), kete-job-init as PID 1, the static network,
// quiet boot. Firecracker adds `root=/dev/vda ro` for the read-only root drive.
func bootArgs(m machine) string {
	return strings.Join([]string{
		"console=ttyS0", "reboot=k", "panic=1", "pci=off", "quiet", "loglevel=1",
		"init=" + initPath, m.Slot.KernelIP(m.Resolvers),
	}, " ")
}

type rateLimiter struct {
	Bandwidth *tokenBucket `json:"bandwidth,omitempty"`
	Ops       *tokenBucket `json:"ops,omitempty"`
}

type tokenBucket struct {
	Size       int64 `json:"size"`
	RefillTime int64 `json:"refill_time"`
}

type drive struct {
	DriveID      string       `json:"drive_id"`
	PathOnHost   string       `json:"path_on_host"`
	IsRootDevice bool         `json:"is_root_device"`
	IsReadOnly   bool         `json:"is_read_only"`
	RateLimiter  *rateLimiter `json:"rate_limiter,omitempty"`
}

type vmConfig struct {
	BootSource struct {
		KernelImagePath string `json:"kernel_image_path"`
		BootArgs        string `json:"boot_args"`
	} `json:"boot-source"`
	Drives        []drive `json:"drives"`
	MachineConfig struct {
		VCPUCount  int  `json:"vcpu_count"`
		MemSizeMiB int  `json:"mem_size_mib"`
		SMT        bool `json:"smt"`
	} `json:"machine-config"`
	NetworkInterfaces []struct {
		IfaceID       string       `json:"iface_id"`
		HostDevName   string       `json:"host_dev_name"`
		GuestMAC      string       `json:"guest_mac"`
		RxRateLimiter *rateLimiter `json:"rx_rate_limiter,omitempty"`
		TxRateLimiter *rateLimiter `json:"tx_rate_limiter,omitempty"`
	} `json:"network-interfaces"`
	Logger struct {
		LogPath string `json:"log_path"`
		Level   string `json:"level"`
	} `json:"logger"`
}

// renderVMConfig is Firecracker's --config-file: the kernel, three drives (read-only root,
// scratch, read-only config disk), the machine size, one network interface, the log file. No
// `mmds-config` (MMDS stays off), no `vsock`, no metrics, no API socket (--no-api).
func renderVMConfig(m machine) ([]byte, error) {
	var c vmConfig
	c.BootSource.KernelImagePath = "/" + jailKernel
	c.BootSource.BootArgs = bootArgs(m)
	disk := &rateLimiter{
		Bandwidth: &tokenBucket{Size: int64(m.DiskMBps) << 20, RefillTime: 1000},
		Ops:       &tokenBucket{Size: int64(m.DiskIOPS), RefillTime: 1000},
	}
	c.Drives = []drive{
		{DriveID: "rootfs", PathOnHost: "/" + jailRootfs, IsRootDevice: true, IsReadOnly: true, RateLimiter: disk},
		{DriveID: "scratch", PathOnHost: "/" + jailScratch, IsReadOnly: false, RateLimiter: disk},
		{DriveID: "config", PathOnHost: "/" + jailConfig, IsReadOnly: true},
	}
	c.MachineConfig.VCPUCount = m.VCPUs
	c.MachineConfig.MemSizeMiB = m.MemoryMiB
	net := &rateLimiter{Bandwidth: &tokenBucket{Size: int64(m.NetMbps) * 1_000_000 / 8, RefillTime: 1000}}
	c.NetworkInterfaces = []struct {
		IfaceID       string       `json:"iface_id"`
		HostDevName   string       `json:"host_dev_name"`
		GuestMAC      string       `json:"guest_mac"`
		RxRateLimiter *rateLimiter `json:"rx_rate_limiter,omitempty"`
		TxRateLimiter *rateLimiter `json:"tx_rate_limiter,omitempty"`
	}{{IfaceID: "eth0", HostDevName: m.Slot.Tap, GuestMAC: m.Slot.MAC(), RxRateLimiter: net, TxRateLimiter: net}}
	c.Logger.LogPath = "/" + jailLog
	c.Logger.Level = "Info"
	return json.MarshalIndent(c, "", "  ")
}
