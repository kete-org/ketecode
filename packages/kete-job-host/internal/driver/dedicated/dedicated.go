// Package dedicated is the `dedicated` driver (kete-code-platform ADR 0023 rule 8, self-hosted
// P5): exactly one job at a time, directly on a host without KVM whose identity is good for one
// job (the agent spends the generation at the start; the platform resets the host after it).
//
// A machine is the job image's entrypoint, launched by a reaper (`kete-job-host __dedicated-init`,
// the agent's own binary) that is PID 1 of new mount, PID, network, IPC, UTS and cgroup
// namespaces, cloned straight into /sys/fs/cgroup/kete-job-host-jobs/<machine> (cpu, memory, swap
// and pids limits). Its root is an overlay of the image's verified read-only ext4 (shared with the
// firecracker driver's image store, loop-mounted read-only) and a fresh sparse ext4 scratch file;
// its network is a veth pair `kjh0` (host) / `eth0` (job) with a /30, filtered by the same host
// nftables table as firecracker guests; its /dev is a small tmpfs with fixed nodes (no host
// device). The configuration reaches the entrypoint only on a pipe (`--config-fd 3`) with
// `KETE_JOB_HOST_PROFILE=dedicated`; nothing of it touches disk. The reaper reaps every orphan
// (so the entrypoint's end-of-job check never sees zombies as live job processes) and, when the
// entrypoint exits, kills what is left and records the end.
//
// These namespaces keep the host's processes, sockets and files out of the job's view; they are
// explicitly NOT a security boundary (rule 8): job root is host root. The host is compromised
// after the job, which is why it runs one.
package dedicated

import (
	"errors"
	"fmt"
	"net/netip"
	"path/filepath"
	"strconv"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// Fixed names.
const (
	// ParentCgroup holds one cgroup per machine, outside the agent unit's cgroup (the job
	// survives an agent restart, like a firecracker VM).
	ParentCgroup = "kete-job-host-jobs"
	// InitArg is argv[1] of the reaper (the agent's binary re-executed).
	InitArg = "__dedicated-init"
	// EntrypointBin is the job image's entrypoint (the image's ENTRYPOINT; kete-job-init's path).
	EntrypointBin = "/usr/local/libexec/kete/kete-job-entrypoint"
	// ConfigFDArg is the entrypoint's config pipe flag (bootenv.ConfigFDArg).
	ConfigFDArg = "--config-fd"
	// ProfileEnv selects the entrypoint's host profile (ADR 0023 rule 16).
	ProfileEnv = "KETE_JOB_HOST_PROFILE=dedicated"
	// Hostname is the job's UTS hostname.
	Hostname = "kete-job"
	// ScratchLabel labels the scratch file system (as the firecracker scratch disk).
	ScratchLabel = "kete-scratch"
)

// The reaper's descriptors (exec.Cmd.ExtraFiles order).
const (
	fdConfig  = 3 // the configuration pipe's read end, handed to the entrypoint as its fd 3
	fdControl = 4 // agent -> reaper: one InitSpec line once the host side is ready
	fdReport  = 5 // reaper -> agent: "ok\n" once the entrypoint runs, or "error: ...\n"
	fdExit    = 6 // the machine's exit file: "exited <code>\n" when the entrypoint has ended
)

// guestEnv is the entrypoint's whole environment (kete-job-init's, plus the profile).
var guestEnv = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", ProfileEnv}

// InitSpec is what the agent sends the reaper on its control pipe once the veth is in place. It
// holds no secret (the configuration travels on its own pipe).
type InitSpec struct {
	// Root is the overlay root's host path; the reaper pivots into it.
	Root string `json:"root"`
	// IPBin is the host's iproute2 binary, run by the reaper before it pivots.
	IPBin string `json:"ip_bin"`
	// Address is the job's address with its /30; Gateway the host side's.
	Address string `json:"address"`
	Gateway string `json:"gateway"`
	// Resolvers become the job's /etc/resolv.conf (the host table allows DNS only to them).
	Resolvers []string `json:"resolvers"`
}

// Validate checks the spec (the reaper trusts nothing it is handed).
func (s InitSpec) Validate() error {
	if !filepath.IsAbs(s.Root) || filepath.Clean(s.Root) != s.Root || s.Root == "/" {
		return errors.New("dedicated: init spec: root must be a clean absolute path other than /")
	}
	if !filepath.IsAbs(s.IPBin) || filepath.Clean(s.IPBin) != s.IPBin || filepath.Base(s.IPBin) != "ip" {
		return errors.New("dedicated: init spec: ip_bin must be an absolute path to ip")
	}
	p, err := netip.ParsePrefix(s.Address)
	if err != nil || !p.Addr().Is4() || p.Bits() != 30 {
		return errors.New("dedicated: init spec: address must be an IPv4 /30")
	}
	gw, err := netip.ParseAddr(s.Gateway)
	if err != nil || !gw.Is4() || !p.Masked().Contains(gw) || gw == p.Addr() {
		return errors.New("dedicated: init spec: gateway must be the other address of the /30")
	}
	if len(s.Resolvers) == 0 || len(s.Resolvers) > 2 {
		return errors.New("dedicated: init spec: one or two resolvers")
	}
	for _, r := range s.Resolvers {
		if a, err := netip.ParseAddr(r); err != nil || !a.Is4() {
			return errors.New("dedicated: init spec: resolvers must be IPv4 addresses")
		}
	}
	return nil
}

// CgroupFile is one limit written into the machine's cgroup.
type CgroupFile struct{ Name, Value string }

// CgroupLimits are the machine cgroup's limits: the job's vCPUs as CPU bandwidth, its memory with
// no swap, and a process limit. The entrypoint divides the cgroup further inside its namespace.
func CgroupLimits(r contract.Resources, pidsMax int) ([]CgroupFile, error) {
	if r.VCPUs < 1 || r.VCPUs > 256 || r.MemoryMiB < 256 || r.MemoryMiB > 1<<22 || r.ScratchGiB < 1 || r.ScratchGiB > 16384 {
		return nil, errors.New("dedicated: invalid resources")
	}
	if pidsMax < 256 {
		return nil, errors.New("dedicated: pids_max too small")
	}
	const period = 100000
	return []CgroupFile{
		{"cpu.max", fmt.Sprintf("%d %d", r.VCPUs*period, period)},
		{"memory.max", strconv.FormatInt(int64(r.MemoryMiB)<<20, 10)},
		{"memory.swap.max", "0"},
		{"pids.max", strconv.Itoa(pidsMax)},
	}, nil
}
