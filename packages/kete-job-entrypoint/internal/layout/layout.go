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
	BootIDFile  string // this kernel's boot ID (kubevm's shared-kernel check)

	// kubevm (the Kubernetes runner's VM-isolated pods). ConfigDir is the per-job Secret's volume
	// (`--config-file` must name ConfigFile, and the volume is unmounted before anything else is
	// written); OutboxDir the per-job outbox volume the runner's publisher reads after the job;
	// UpstreamDir holds the enterprise proxy's credentials and CA bundle for kete-egress (root,
	// group kete-proxy, 0750). BoundaryRetry bounds the host-boundary probe's retries while a
	// NetworkPolicy may not be enforced yet (spec "S0 findings" 5); BoundaryEvery spaces them.
	ConfigDir     string
	OutboxDir     string
	UpstreamDir   string
	BoundaryRetry time.Duration
	BoundaryEvery time.Duration

	// The shared-kernel guard's inputs (hostprofile.GatherKernel). Only in-process tests point
	// these elsewhere, and only they set NSInode (nil: stat NSDir/<name>).
	NSDir        string
	Proc1Cmdline string
	Proc1Environ string
	SelfStat     string
	SelfExe      string
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
		BootIDFile:  "/proc/sys/kernel/random/boot_id",

		ConfigDir:     ConfigDir,
		OutboxDir:     "/var/lib/kete-outbox",
		UpstreamDir:   "/run/kete-upstream",
		BoundaryRetry: 30 * time.Second,
		BoundaryEvery: 2 * time.Second,

		NSDir:        "/proc/self/ns",
		Proc1Cmdline: "/proc/1/cmdline",
		Proc1Environ: "/proc/1/environ",
		SelfStat:     "/proc/self/stat",
		SelfExe:      "/proc/self/exe",
		MountInfo:    "/proc/self/mountinfo",
		MarkerFiles:  []string{"/.dockerenv", "/run/.containerenv", "/run/systemd/container", "/run/host/container-manager"},

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

// ConfigDir is where the Kubernetes runner mounts a job pod's per-job Secret, and ConfigFile the
// machine configuration in it (packages/kete-job-host internal/driver/kubernetes ConfigMountPath
// and SecretConfig; change them together).
const (
	ConfigDir  = "/run/kete-config"
	ConfigFile = ConfigDir + "/config.json"
)

// OutboxGID is the group the outbox's files belong to (0640) and its directory (0750): the
// runner image's non-root user's group (65532), so the publisher (P3) can read them while no job
// user can.
const OutboxGID = 65532

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

// UpstreamCA and UpstreamAuth are kete-egress's configuration v2 upstream.ca_bundle_file and
// upstream.proxy_auth_file (kubevm with an enterprise proxy).
func (c Config) UpstreamCA() string   { return filepath.Join(c.UpstreamDir, "ca.pem") }
func (c Config) UpstreamAuth() string { return filepath.Join(c.UpstreamDir, "proxy-auth") }

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

// OrchestrationTurnRel is where, beneath KeteHome, `kete` records an orchestration turn's state
// (its XDG state directory's kete/orchestration-turn.json; core/src/kete/orchestration/turn-state.ts):
// kete's home is 0700 kete-owned, so the job's tools can't write it.
var OrchestrationTurnRel = []string{".local", "state", "kete", "orchestration-turn.json"}

// MaxOrchestrationTurn bounds that file.
const MaxOrchestrationTurn = 4096

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
