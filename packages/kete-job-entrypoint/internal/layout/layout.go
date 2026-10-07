// Package layout is every fixed path, user name, port, limit and timing the entrypoint uses
// (module README "Layout"), as one Config with defaults. The binary has no flag or environment
// knob for any of it: only in-process tests override fields (mostly timings and binary paths).
package layout

import (
	"path/filepath"
	"time"
)

// Config is the entrypoint's fixed configuration.
type Config struct {
	// Binaries.
	KeteBin   string // the real `kete` (the heartbeat's kete_cgroup_extra skips it)
	HelperBin string
	EgressBin string
	NftBin    string
	GitBin    string
	// LaunchExe is re-executed as stage 2 of every launch ("__launch"); /proc/self/exe is the
	// running entrypoint's own inode.
	LaunchExe string

	// Users and the shared group (created by the image, verified at boot).
	KeteUser, ToolUser, ProxyUser, JobGroup string
	PasswdPath, GroupPath                   string

	// Directories and files.
	RunDir       string // root 0700: egress.json, root temp
	EgressCADir  string // root 0755
	HelperDir    string // root 0755
	RootDir      string // root 0700: pristine.git, home, tmp
	LogDir       string // root 0700
	JobLib       string // root 0755: kete/ and tool/
	SrvDir       string // root 0755
	WorkParent   string // root:kete-job 2750: the helper's --worktree-root
	RepoName     string // the agent's working copy under WorkParent
	ResolvConf   string
	ProcMount    string
	FlyDir       string
	CgroupParent string // empty: the entrypoint's own cgroup at start-up

	// Host profile signals and the host-boundary probe (module README "Host profiles"). Only
	// in-process tests point these elsewhere.
	InitBin     string // kete-job-init: PID 1's executable in microvm and cloudvm guests
	Proc1Exe    string // PID 1's executable link
	RouteFile   string // IPv4 routes (the default gateways)
	SysBlockDir string // one entry per block device
	DevDir      string // device nodes, by the block device's name
	VirtioDir   string // virtio devices (a vsock device has id 0x0013)
	DMIDir      string // firmware DMI fields (sys_vendor, product_name, chassis_asset_tag)

	// The shared-kernel guard's inputs (hostprofile.GatherKernel). Only in-process tests point
	// these elsewhere, and only they set NSInode (nil: stat NSDir/<name>).
	NSDir        string
	Proc1Cmdline string
	MountInfo    string
	MarkerFiles  []string
	NSInode      func(name string) (uint64, error)

	// Ports A, B and R on 127.0.0.1.
	PortKete, PortTool, PortRoot int

	// Timings.
	Minute          time.Duration // the unit of policy.timeout and effective_timeout_minutes
	FinalizeReserve time.Duration // kept back from the deadline for the report phase
	BackstopExtra   time.Duration // past the effective timeout before the entrypoint stops kete
	KillWait        time.Duration // SIGTERM → cgroup.kill
	ReapTimeout     time.Duration // 6a: every job process gone
	Heartbeat       time.Duration
	ProxyReady      time.Duration
	HelperReady     time.Duration
	ProbeTimeout    time.Duration // one isolation probe run, launch to answer
	StopWait        time.Duration
	HTTPTimeout     time.Duration
	ClaimTries      int
	ClaimWindow     time.Duration
	RetryBackoff    time.Duration
	CloneTimeout    time.Duration
	GitTimeout      time.Duration

	// Values the claim doesn't carry yet.
	MaxOutputTokens int // KETE_JOB_MAX_OUTPUT_TOKENS (D14)
}

// Default is the production configuration.
func Default() Config {
	return Config{
		KeteBin:   "/usr/local/bin/kete",
		HelperBin: "/usr/local/libexec/kete/kete-root-helper",
		EgressBin: "/usr/local/libexec/kete/kete-egress",
		NftBin:    "/usr/sbin/nft",
		GitBin:    "/usr/bin/git",
		LaunchExe: "/proc/self/exe",

		KeteUser: "kete", ToolUser: "kete-tool", ProxyUser: "kete-proxy", JobGroup: "kete-job",
		PasswdPath: "/etc/passwd", GroupPath: "/etc/group",

		RunDir:      "/run/kete-job",
		EgressCADir: "/run/kete-egress",
		HelperDir:   "/run/kete-helper",
		RootDir:     "/var/lib/kete-root",
		LogDir:      "/var/log/kete-job",
		JobLib:      "/var/lib/kete-job",
		SrvDir:      "/srv/kete-job",
		WorkParent:  "/srv/kete-job/work",
		RepoName:    "repo",
		ResolvConf:  "/etc/resolv.conf",
		ProcMount:   "/proc",
		FlyDir:      "/.fly",

		InitBin:     "/usr/local/libexec/kete/kete-job-init",
		Proc1Exe:    "/proc/1/exe",
		RouteFile:   "/proc/net/route",
		SysBlockDir: "/sys/class/block",
		DevDir:      "/dev",
		VirtioDir:   "/sys/bus/virtio/devices",
		DMIDir:      "/sys/class/dmi/id",

		NSDir:        "/proc/self/ns",
		Proc1Cmdline: "/proc/1/cmdline",
		MountInfo:    "/proc/self/mountinfo",
		MarkerFiles:  []string{"/.dockerenv", "/run/.containerenv"},

		PortKete: 81, PortTool: 82, PortRoot: 83,

		Minute:          time.Minute,
		FinalizeReserve: 5 * time.Minute,
		BackstopExtra:   3 * time.Minute,
		KillWait:        10 * time.Second,
		ReapTimeout:     30 * time.Second,
		Heartbeat:       30 * time.Second,
		ProxyReady:      10 * time.Second,
		HelperReady:     10 * time.Second,
		ProbeTimeout:    20 * time.Second,
		StopWait:        10 * time.Second,
		HTTPTimeout:     30 * time.Second,
		ClaimTries:      5,
		ClaimWindow:     2 * time.Minute,
		RetryBackoff:    time.Second,
		CloneTimeout:    10 * time.Minute,
		GitTimeout:      60 * time.Second,

		MaxOutputTokens: 32000,
	}
}

// Derived paths.

func (c Config) CAPath() string       { return filepath.Join(c.EgressCADir, "ca.pem") }
func (c Config) HelperSocket() string { return filepath.Join(c.HelperDir, "helper.sock") }
func (c Config) Pristine() string     { return filepath.Join(c.RootDir, "pristine.git") }
func (c Config) RootHome() string     { return filepath.Join(c.RootDir, "home") }
func (c Config) RootTmp() string      { return filepath.Join(c.RootDir, "tmp") }
func (c Config) ProxyLog() string     { return filepath.Join(c.LogDir, "proxy.jsonl") }
func (c Config) ProxyStderr() string  { return filepath.Join(c.LogDir, "proxy.stderr") }
func (c Config) HelperStderr() string { return filepath.Join(c.LogDir, "helper.stderr") }
func (c Config) KeteStdout() string   { return filepath.Join(c.LogDir, "kete.stdout") }
func (c Config) KeteStderr() string   { return filepath.Join(c.LogDir, "kete.stderr") }

// KeteAudit is the root-owned file the entrypoint copies `kete`'s audit pipe into (piece A3).
func (c Config) KeteAudit() string      { return filepath.Join(c.LogDir, KeteAuditName) }
func (c Config) KeteHome() string       { return filepath.Join(c.JobLib, "kete") }
func (c Config) ToolHome() string       { return filepath.Join(c.JobLib, "tool") }
func (c Config) KeteTmp() string        { return filepath.Join(c.KeteHome(), "tmp") }
func (c Config) ToolTmp() string        { return filepath.Join(c.ToolHome(), "tmp") }
func (c Config) SpecPath() string       { return filepath.Join(c.KeteHome(), "spec.json") }
func (c Config) Repo() string           { return filepath.Join(c.WorkParent, c.RepoName) }
func (c Config) KeteDataHome() string   { return filepath.Join(c.KeteHome(), ".local", "share") }
func (c Config) KeteConfigHome() string { return filepath.Join(c.KeteHome(), ".config") }
func (c Config) KeteCacheHome() string  { return filepath.Join(c.KeteHome(), ".cache") }
func (c Config) KeteStateHome() string  { return filepath.Join(c.KeteHome(), ".local", "state") }

// The audit sink (piece A3, contracts.md §6d): `kete job run` gets the write end of a pipe as this
// descriptor (KETE_JOB_AUDIT_FD), and `kete` writes its audit log only there; the entrypoint reads
// the other end into KeteAudit(). `kete` can append, never seek, truncate or rewrite.
const (
	KeteAuditFD   = 4
	KeteAuditName = "kete.audit.jsonl"
)

// Limits mirrored from the platform (docs/jobs.md §2 uploads) and ADR 0021 rule 6.
const (
	MaxAuditUpload    = 20_000_000
	MaxProxyLogUpload = 10_000_000
	MaxKeteStdout     = 1 << 20

	// Decimal and conservative (README "Bundle"): a platform reading "1 MB" as 10^6 never refuses
	// a bundle built under these.
	BundleMaxFile       = 1_000_000
	BundleMaxBinaryFile = 256_000
	BundleMaxBinaries   = 50
	BundleMaxEntries    = 1000
	BundleMaxTar        = 20_000_000
	BundleMaxGzip       = 10_000_000
	BundleMaxUntracked  = 100_000
	GitMaxStdout        = 64 << 20
	GitMaxStderr        = 64 << 10
)

// RegistryHosts are the built-in registry hosts the tool user may reach in the agent phase (D7),
// the same list as kete-egress's internal/registry BuiltinHosts.
var RegistryHosts = []string{
	"registry.npmjs.org", "registry.yarnpkg.com",
	"pypi.org", "files.pythonhosted.org",
	"index.crates.io", "static.crates.io", "crates.io",
	"rubygems.org", "index.rubygems.org",
}

// ToolEnvAllow are the variable names `kete`'s shell tool may pass to a tool process through the
// helper (never a KETE_* name, never a proxy or CA variable: those are fixed by ToolEnvSet).
var ToolEnvAllow = []string{"TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "CI", "COLUMNS", "LINES", "PAGER", "GIT_PAGER", "GIT_EDITOR", "EDITOR"}
