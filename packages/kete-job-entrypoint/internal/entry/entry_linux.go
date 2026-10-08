//go:build linux

// Package entry wires the real implementations into job.Run: machine setup (steps 0-1f), the
// egress manager, the helper, `kete`, the platform client, root's git and the bundle reader.
// cmd/kete-job-entrypoint calls Main after the boot re-exec; the integration suite calls it
// in-process with test timings.
package entry

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/cgroup"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/egress"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/gitops"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/helper"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/job"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/launch"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
	pl "github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/setup"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/sysusers"
)

// Main runs steps 0-7 and returns the exit code: 2 for a boot failure, 1 for any other failure
// before claim, else job.Run's code.
func Main(ctx context.Context, cfg layout.Config, boot bootenv.Values, stdout io.Writer) int {
	log := pl.New(stdout)
	step := func(s pl.Step, fn func() error) bool {
		log.Start(s)
		if err := fn(); err != nil {
			log.FailErr(s, pl.CodeFailed, err)
			return false
		}
		log.OK(s)
		return true
	}
	// The host profile and the shared-kernel guard come first: nothing, not even this process's
	// own settings, is written before it is known whose kernel this is.
	profile, ok := hostCheck(log, cfg, boot)
	if !ok {
		return exit(log, 1)
	}
	// kubevm: the pod's own kernel is proven; now the per-job Secret's volume goes (nothing in the
	// guest may read the configuration again), and /proc/sys and the cgroup mount, which the
	// container runtime mounts read-only, become writable for the steps below.
	if profile == hostprofile.KubeVM && !kubeVMSetup(log, cfg) {
		return exit(log, 1)
	}
	// Fly has no shared-kernel guard yet (a follow-up, to verify on a Fly machine): at least its API
	// directory and socket must be there before anything is written, so Fly's variables alone in
	// a container never reach the sysctls. The Fly guard proper (locking, the probe) runs below.
	if profile == hostprofile.Fly {
		if err := setup.FlyPresent(cfg.FlyDir); err != nil {
			log.Start(pl.StepFly)
			if errors.Is(err, setup.ErrFlyAPIMissing) {
				log.Fail(pl.StepFly, pl.CodeMissing)
			} else {
				log.FailErr(pl.StepFly, pl.CodeFailed, err)
			}
			return exit(log, 1)
		}
	}
	if !step(pl.StepBoot, setup.Self) {
		log.Exit(2)
		return 2
	}
	var ids sysusers.IDs
	if !step(pl.StepUsers, func() error {
		pw, err := os.Open(cfg.PasswdPath)
		if err != nil {
			return err
		}
		defer pw.Close()
		gr, err := os.Open(cfg.GroupPath)
		if err != nil {
			return err
		}
		defer gr.Close()
		ids, err = sysusers.Resolve(pw, gr, sysusers.Names{Kete: cfg.KeteUser, Tool: cfg.ToolUser, Proxy: cfg.ProxyUser, Group: cfg.JobGroup})
		return err
	}) {
		return exit(log, 1)
	}
	if sharedKernelTest(boot) {
		// The test-only shared-kernel mode (kind CI, a kete_testdriver build): these sysctls are
		// host-wide in a shared kernel, so they are left alone — the very writes the release
		// build refuses to risk outside its own VM.
		log.Note(pl.StepSysctl, pl.CodeSharedKernel)
	} else if !step(pl.StepSysctl, func() error { return setup.ApplySysctls(setup.Sysctls(cfg.ProcMount)) }) {
		return exit(log, 1)
	}
	if !step(pl.StepProc, func() error { return setup.RemountProc(cfg.ProcMount) }) {
		return exit(log, 1)
	}
	// Fly keeps its guard; every other profile proves the host's isolation first, as root and
	// before any in-guest rule exists (module README "Host profiles").
	if profile == hostprofile.Fly {
		if !flyGuard(ctx, log, cfg, boot, ids) {
			return exit(log, 1)
		}
	} else if !hostBoundary(ctx, log, cfg, profile, boot) {
		return exit(log, 1)
	}
	if !step(pl.StepDirs, func() error {
		if err := setup.MakeDirs(Dirs(cfg, ids)); err != nil {
			return err
		}
		if profile == hostprofile.KubeVM {
			return kubeVMDirs(cfg, ids, boot)
		}
		return nil
	}) {
		return exit(log, 1)
	}
	var cg cgroup.Layout
	if !step(pl.StepCgroup, func() error {
		parent := cfg.CgroupParent
		if parent == "" {
			var err error
			if parent, err = cgroup.Own(); err != nil {
				return err
			}
		}
		mem, err := cgroup.MemTotal()
		if err != nil {
			return err
		}
		cg, err = cgroup.Setup(parent, cgroup.LimitsFor(mem))
		return err
	}) {
		return exit(log, 1)
	}

	var base egress.Base
	if !step(pl.StepEgressConf, func() error {
		f, err := os.Open(cfg.ResolvConf)
		if err != nil {
			return err
		}
		defer f.Close()
		res, err := egress.ParseResolvConf(f)
		if err != nil {
			return err
		}
		base = egress.Base{ProxyUID: ids.Proxy.UID, KeteUID: ids.Kete.UID, ToolUID: ids.Tool.UID,
			PortKete: cfg.PortKete, PortTool: cfg.PortTool, PortRoot: cfg.PortRoot, Resolvers: res}
		if profile == hostprofile.KubeVM {
			base.V2 = egressV2(cfg, boot)
		}
		return nil
	}) {
		return exit(log, 1)
	}
	mgr := &egress.Manager{
		EgressBin: cfg.EgressBin, LaunchExe: cfg.LaunchExe, CgroupDir: cg.System,
		ProxyUID: ids.Proxy.UID, ProxyGID: ids.Proxy.GID, StderrPath: cfg.ProxyStderr(),
		CAPath: cfg.CAPath(), Ready: cfg.ProxyReady, StopWait: cfg.StopWait,
	}
	if !step(pl.StepProxy, func() error {
		return mgr.Open([3]int{cfg.PortKete, cfg.PortTool, cfg.PortRoot}, cfg.ProxyLog())
	}) {
		return exit(log, 1)
	}
	defer mgr.Close()

	proxyURL := "http://127.0.0.1:" + strconv.Itoa(cfg.PortRoot)
	git := gitops.Runner{
		Git: cfg.GitBin, Home: cfg.RootHome(), ProxyURL: proxyURL, CAPath: cfg.CAPath(),
		Timeout: cfg.GitTimeout, CloneTimeout: cfg.CloneTimeout, MaxStdout: layout.GitMaxStdout, MaxStderr: layout.GitMaxStderr,
	}
	m := &machine{cfg: cfg, ids: ids, cg: cg, git: git, resolvers: base.Resolvers, profile: profile, kubeAPI: boot.KubeAPI}
	if boot.Local != nil {
		m.nodes, m.internalPorts = boot.Local.NodeAddresses, internalPorts(boot)
	}
	pc := platform.New(platform.Options{
		BaseURL: boot.PlatformURL, JobID: boot.JobID, StorageHost: boot.StorageHost, ProxyURL: proxyURL, Timeout: cfg.HTTPTimeout,
		ClaimTries: cfg.ClaimTries, ClaimWindow: cfg.ClaimWindow, Backoff: cfg.RetryBackoff,
	})
	var rt *job.Runtime
	if profile == hostprofile.KubeVM {
		var err error
		if rt, err = runtimeDeps(cfg, boot, pc, git); err != nil {
			log.FailErr(pl.StepEgressConf, pl.CodeInvalid, err)
			return exit(log, 1)
		}
		boot.Local = nil // the clone credential lives on in rt only
	}
	deps := job.Deps{
		Cfg:  cfg,
		Log:  log,
		Boot: boot,
		Egress: &egressImpl{
			mgr: mgr, base: base, cfg: cfg,
		},
		Platform: pc,
		Git:      git,
		Machine:  m,
		Now:      time.Now,
		Runtime:  rt,
	}
	return job.Run(ctx, deps)
}

// hostCheck is step setup_host, the first step: the boot values' host profile against the
// machine's signals (hostprofile.Check), with the shared-kernel guard for every profile but fly.
// Any mismatch, or a profile that can't be read, refuses the job before claim, and before anything
// is written, with a fixed code.
func hostCheck(log *pl.Logger, cfg layout.Config, boot bootenv.Values) (hostprofile.Name, bool) {
	log.Start(pl.StepHost)
	n, err := hostprofile.Parse(boot.Profile)
	if err != nil {
		log.Fail(pl.StepHost, pl.CodeInvalid)
		return "", false
	}
	paths := signalPaths(cfg)
	in := hostprofile.Signals{
		FlyEnv: boot.OnFly, Source: hostprofile.Source(boot.Source), Provider: boot.Provider, Generation: boot.Generation,
	}
	if n == hostprofile.KubeVM {
		// The kubevm rule is the boot ID (KubeVMKernel), read here: the namespace facts can't
		// tell a Kata guest from a container on a VM node.
		paths.BootIDFile = cfg.BootIDFile
		in.NodeBootID = boot.NodeBootID
		in.SharedKernelTest = sharedKernelTest(boot)
	}
	sig, err := hostprofile.Gather(paths, in)
	if err != nil {
		log.FailErr(pl.StepHost, pl.CodeFailed, err)
		return "", false
	}
	if n != hostprofile.Fly && n != hostprofile.KubeVM {
		// Reads only. A namespace that can't be read refuses as the guard would: whose kernel
		// this is stays unknown.
		if sig.Kernel, err = hostprofile.GatherKernel(kernelPaths(cfg)); err != nil {
			log.FailErr(pl.StepHost, pl.CodeSharedKernel, err)
			return "", false
		}
	}
	if err := hostprofile.Check(n, sig); err != nil {
		var r *hostprofile.Refusal
		if errors.As(err, &r) {
			log.Fail(pl.StepHost, r.Code)
		} else {
			log.FailErr(pl.StepHost, pl.CodeFailed, err)
		}
		return "", false
	}
	log.OK(pl.StepHost)
	return n, true
}

func signalPaths(cfg layout.Config) hostprofile.Paths {
	return hostprofile.Paths{
		FlyDir: cfg.FlyDir, InitBin: cfg.InitBin, Proc1Exe: cfg.Proc1Exe, VirtioDir: cfg.VirtioDir,
		DMIDir: cfg.DMIDir, SysBlockDir: cfg.SysBlockDir, DevDir: cfg.DevDir,
	}
}

func kernelPaths(cfg layout.Config) hostprofile.KernelPaths {
	return hostprofile.KernelPaths{
		NSDir: cfg.NSDir, Proc1Cmdline: cfg.Proc1Cmdline, Proc1Environ: cfg.Proc1Environ, SelfStat: cfg.SelfStat, SelfExe: cfg.SelfExe,
		MountInfo: cfg.MountInfo, MarkerFiles: cfg.MarkerFiles, NSInode: cfg.NSInode,
	}
}

func readGateways(path string) ([]netip.Addr, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return hostprofile.DefaultGateways(f)
}

// hostBoundary is step host_boundary (every profile but fly): as root, before the network guard
// installs the in-guest rules, nothing outside the guest's public egress may answer: no block
// device may still hold the config disk, cloudvm's metadata drop must be installed, and the
// host-boundary probe (the default gateway's sample ports, metadata, private-range and IPv6
// samples) must reach nothing. This proves the host-level isolation (the host table, the
// provider's network) exists independently of the guest's own rules.
func hostBoundary(ctx context.Context, log *pl.Logger, cfg layout.Config, profile hostprofile.Name, boot bootenv.Values) bool {
	log.Start(pl.StepBoundary)
	gws, err := readGateways(cfg.RouteFile)
	if err != nil {
		log.FailErr(pl.StepBoundary, pl.CodeProbe, err)
		return false
	}
	// Without a default gateway there is no host side to probe, and no egress either: a guest the
	// host set up wrongly, refused rather than passed.
	if len(gws) == 0 {
		log.Fail(pl.StepBoundary, pl.CodeProbe)
		return false
	}
	disk, err := hostprofile.FindConfigDisk(cfg.SysBlockDir, cfg.DevDir)
	if err != nil {
		log.FailErr(pl.StepBoundary, pl.CodeProbe, err)
		return false
	}
	if disk != "" {
		log.Fail(pl.StepBoundary, pl.CodeConfigDisk)
		return false
	}
	if profile == hostprofile.CloudVM {
		tctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		out, err := exec.CommandContext(tctx, cfg.NftBin, "-j", "list", "table", "inet", hostprofile.MetadataDropTable).Output()
		cancel()
		if err == nil {
			err = hostprofile.VerifyMetadataDrop(out) // exactly init's drop rules, not just the table
		}
		if err != nil {
			log.Fail(pl.StepBoundary, pl.CodeMetadataDrop)
			return false
		}
	}
	ln, err := isolation.Listen()
	if err != nil {
		log.FailErr(pl.StepBoundary, pl.CodeProbe, err)
		return false
	}
	defer ln.Close()
	probes := append(isolation.Controls(ln.TCPAddr(), ""), hostprofile.BoundaryTargets(gws)...)
	if profile != hostprofile.KubeVM {
		if code := isolation.Check(ctx, isolation.NewRequest(probes), isolation.SysNet{}); code != isolation.OK {
			log.Fail(pl.StepBoundary, code)
			return false
		}
		log.OK(pl.StepBoundary)
		return true
	}
	// kubevm: also the Kubernetes API and the node's addresses; and a NetworkPolicy may be
	// enforced only after the pod started (spec "S0 findings" 5), so a failed probe is retried
	// for a bounded time and passes only after two consecutive rounds in which every target was
	// unreachable. The claim token (in memory) hasn't been used and no job code runs before claim,
	// so waiting exposes nothing new. The probe runs as root before the in-guest firewall: what
	// root can't reach now, no user reaches after it.
	var nodes []string
	if boot.Local != nil {
		nodes = boot.Local.NodeAddresses
	}
	probes = append(probes, hostprofile.KubeTargets(boot.KubeAPI, nodes, internalPorts(boot))...)
	until := time.Now().Add(cfg.BoundaryRetry)
	clean := 0
	for {
		code := isolation.Check(ctx, isolation.NewRequest(probes), isolation.SysNet{})
		if code == isolation.OK {
			if clean++; clean >= 2 {
				log.OK(pl.StepBoundary)
				return true
			}
		} else {
			clean = 0
		}
		if ctx.Err() != nil || !time.Now().Add(cfg.BoundaryEvery).Before(until) {
			if code == isolation.OK {
				code = pl.CodeProbe // one clean round only: not proven twice in the window
			}
			log.Fail(pl.StepBoundary, code)
			return false
		}
		if code != isolation.OK {
			log.Note(pl.StepBoundary, code)
		}
		select {
		case <-ctx.Done():
		case <-time.After(cfg.BoundaryEvery):
		}
	}
}

// flyGuard is step setup_fly: lock Fly's API directory and socket (failing closed on Fly when
// they're missing: code "missing"), then confirm as the tool user that the socket can't be
// connected to (code "fly_api"; the isolation check before claim confirms it again, with every
// other listening unix socket).
func flyGuard(ctx context.Context, log *pl.Logger, cfg layout.Config, boot bootenv.Values, ids sysusers.IDs) bool {
	log.Start(pl.StepFly)
	if err := setup.LockFly(cfg.FlyDir, boot.OnFly); err != nil {
		if errors.Is(err, setup.ErrFlyAPIMissing) {
			log.Fail(pl.StepFly, pl.CodeMissing)
		} else {
			log.FailErr(pl.StepFly, pl.CodeFailed, err)
		}
		return false
	}
	ln, err := isolation.Listen()
	if err != nil {
		log.FailErr(pl.StepFly, pl.CodeProbe, err)
		return false
	}
	defer ln.Close()
	err = isolation.Run(ctx, isolation.Options{
		Exe: cfg.LaunchExe, UID: ids.Tool.UID, GID: ids.JobGID, Timeout: cfg.ProbeTimeout,
	}, isolation.NewRequest(isolation.FlyProbes(ln.TCPAddr(), ln.UnixName(), setup.FlySocketPaths(cfg.FlyDir))))
	if err != nil {
		isolation.LogFailure(log, pl.StepFly, err)
		return false
	}
	log.OK(pl.StepFly)
	return true
}

func exit(log *pl.Logger, code int) int {
	log.Exit(code)
	return code
}

// Dirs is the fixed directory layout (module README "Layout"), parents first.
func Dirs(cfg layout.Config, ids sysusers.IDs) []setup.Dir {
	return []setup.Dir{
		{Path: cfg.RunDir, Mode: 0o700},
		{Path: cfg.EgressCADir, Mode: 0o755},
		{Path: cfg.HelperDir, Mode: 0o755},
		{Path: cfg.RootDir, Mode: 0o700},
		{Path: cfg.RootHome(), Mode: 0o700},
		{Path: cfg.RootTmp(), Mode: 0o700},
		{Path: cfg.LogDir, Mode: 0o700},
		{Path: cfg.JobLib, Mode: 0o755},
		{Path: cfg.KeteHome(), UID: ids.Kete.UID, GID: ids.Kete.GID, Mode: 0o700},
		{Path: cfg.KeteTmp(), UID: ids.Kete.UID, GID: ids.Kete.GID, Mode: 0o700},
		{Path: cfg.ToolHome(), UID: ids.Tool.UID, GID: ids.Tool.GID, Mode: 0o700},
		{Path: cfg.ToolTmp(), UID: ids.Tool.UID, GID: ids.Tool.GID, Mode: 0o700},
		{Path: cfg.SrvDir, Mode: 0o755},
		{Path: cfg.WorkParent, GID: ids.JobGID, Mode: 0o750 | os.ModeSetgid},
	}
}

// ToolEnv is the tool user's fixed environment (the helper's --env-set; egress README
// "Clients", port B).
func ToolEnv(cfg layout.Config) map[string]string {
	ca := cfg.CAPath()
	proxy := "http://127.0.0.1:" + strconv.Itoa(cfg.PortTool)
	env := map[string]string{
		"HOME": cfg.ToolHome(), "TMPDIR": cfg.ToolTmp(), "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
		"HTTPS_PROXY": proxy, "https_proxy": proxy, "HTTP_PROXY": proxy, "http_proxy": proxy,
		"NPM_CONFIG_AUDIT": "false", "NPM_CONFIG_FUND": "false", "NPM_CONFIG_UPDATE_NOTIFIER": "false",
		"PIP_DISABLE_PIP_VERSION_CHECK": "1", "UV_NATIVE_TLS": "1",
	}
	for _, k := range []string{"SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_CAFILE", "PIP_CERT", "REQUESTS_CA_BUNDLE", "CARGO_HTTP_CAINFO", "GIT_SSL_CAINFO", "CURL_CA_BUNDLE"} {
		env[k] = ca
	}
	return env
}

// KeteEnvList is `kete`'s complete environment. Port A is its only proxy (HTTPS_PROXY): every
// upstream is HTTPS, and kete's own server is a unix socket, so there is no HTTP_PROXY or NO_PROXY.
// The gateway key is not in it: kete reads it once from fd 3 (KETE_JOB_GATEWAY_KEY_FD, StartKete).
// Its audit log goes to the pipe on fd 4 (KETE_JOB_AUDIT_FD, StartKete), never to a file it owns.
// KETE_DISABLE_MODELS_FETCH: `kete serve` would otherwise fetch the models.dev catalog periodically,
// a host port A never allows (a refused request and an error per job); the binary's bundled
// snapshot is a job's only model catalog either way.
func KeteEnvList(cfg layout.Config, e job.KeteEnv) []string {
	proxy := "http://127.0.0.1:" + strconv.Itoa(cfg.PortKete)
	return []string{
		"HOME=" + cfg.KeteHome(),
		"XDG_CONFIG_HOME=" + cfg.KeteConfigHome(),
		"XDG_DATA_HOME=" + cfg.KeteDataHome(),
		"XDG_CACHE_HOME=" + cfg.KeteCacheHome(),
		"XDG_STATE_HOME=" + cfg.KeteStateHome(),
		"TMPDIR=" + cfg.KeteTmp(),
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"LANG=C.UTF-8",
		"HTTPS_PROXY=" + proxy,
		"https_proxy=" + proxy,
		"NODE_EXTRA_CA_CERTS=" + cfg.CAPath(),
		"SSL_CERT_FILE=" + cfg.CAPath(),
		"KETE_JOB_MODE=1",
		"KETE_JOB_TOOL_SOCKET=" + cfg.HelperSocket(),
		"KETE_JOB_MAX_OUTPUT_TOKENS=" + strconv.Itoa(cfg.MaxOutputTokens),
		"KETE_RUNTIME_TYPE=kete_cloud",
		"KETE_GATEWAY_URL=" + e.GatewayURL,
		"KETE_PLATFORM_URL=" + e.PlatformURL,
		"KETE_JOB_GATEWAY_KEY_FD=3",
		"KETE_JOB_AUDIT_FD=" + strconv.Itoa(layout.KeteAuditFD),
		"KETE_DISABLE_MODELS_FETCH=1",
	}
}

type egressImpl struct {
	mgr  *egress.Manager
	base egress.Base
	cfg  layout.Config
}

func (e *egressImpl) Firewall(ctx context.Context, first egress.Instance) error {
	conf, err := egress.BuildConfig(e.base, first)
	if err != nil {
		return err
	}
	if err := setup.WriteFileAtomic(filepath.Join(e.cfg.RunDir, "egress.json"), conf, 0, 0, 0o600); err != nil {
		return err
	}
	return egress.ApplyFirewall(ctx, e.cfg.EgressBin, e.cfg.NftBin, conf, 10*time.Second)
}

func (e *egressImpl) Start(_ context.Context, inst egress.Instance) (job.Proxy, error) {
	conf, err := egress.BuildConfig(e.base, inst)
	if err != nil {
		return nil, err
	}
	p, err := e.mgr.Start(conf)
	if err != nil {
		return nil, err
	}
	return p, nil
}

type machine struct {
	kubeAPI       string   // kubevm
	nodes         []string // kubevm
	internalPorts []uint16 // kubevm
	cfg           layout.Config
	ids           sysusers.IDs
	cg            cgroup.Layout
	git           gitops.Runner
	resolvers     []string
	audit         *auditReader
	profile       hostprofile.Name
}

// CheckIsolation runs the isolation probe as the tool user, in the tool cgroup, against every
// target (module README "Isolation check").
func (m *machine) CheckIsolation(ctx context.Context) error {
	f, err := os.Open(filepath.Join(m.cfg.ProcMount, "net", "unix"))
	if err != nil {
		return &isolation.Failure{Reason: pl.CodeProbe, Err: err}
	}
	socks, err := isolation.ParseProcNetUnix(f)
	f.Close()
	if err != nil {
		return &isolation.Failure{Reason: pl.CodeProbe, Err: err}
	}
	var local []netip.Addr
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return &isolation.Failure{Reason: pl.CodeProbe, Err: err}
	}
	for _, a := range addrs {
		p, err := netip.ParsePrefix(a.String())
		if err != nil {
			return &isolation.Failure{Reason: pl.CodeProbe, Err: err} // never drop an address silently
		}
		local = append(local, p.Addr())
	}
	ln, err := isolation.Listen()
	if err != nil {
		return &isolation.Failure{Reason: pl.CodeProbe, Err: err}
	}
	defer ln.Close()
	in := isolation.Inputs{
		FlySockets: setup.FlySocketPaths(m.cfg.FlyDir), HelperSocket: m.cfg.HelperSocket(), UnixSockets: socks,
		KeteDirs: []string{m.cfg.KeteHome(), m.cfg.KeteTmp()}, Resolvers: m.resolvers, LocalAddrs: local,
		PortTool: m.cfg.PortTool, Control: ln.TCPAddr(), UnixControl: ln.UnixName(),
	}
	if m.profile != hostprofile.Fly {
		// Off Fly: no Fly socket, resolver or private network; the profile's own targets instead.
		gws, err := readGateways(m.cfg.RouteFile)
		if err != nil {
			return &isolation.Failure{Reason: pl.CodeProbe, Err: err}
		}
		devs, err := hostprofile.BlockDevices(m.cfg.SysBlockDir, m.cfg.DevDir)
		if err != nil {
			return &isolation.Failure{Reason: pl.CodeProbe, Err: err}
		}
		in.FlySockets, in.OffFly, in.Extra = nil, true, hostprofile.IsolationTargets(m.profile, gws, devs)
		if m.profile == hostprofile.KubeVM {
			// The Kubernetes API, the node, the (unmounted) config volume, the outbox and the
			// enterprise proxy's credentials: none for the tool user.
			in.Extra = append(in.Extra, hostprofile.KubeTargets(m.kubeAPI, m.nodes, m.internalPorts)...)
			for _, d := range []string{m.cfg.OutboxDir, m.cfg.UpstreamDir} {
				in.Extra = append(in.Extra, isolation.Probe{Kind: isolation.KindDir, Target: d, Reason: pl.CodeGuardedPath})
			}
		}
	}
	probes := isolation.Build(in)
	// The tool cgroup holds no process directly (its leaves are the helper's p<N>), so the probe
	// gets a leaf of its own, removed once it has exited.
	leaf := filepath.Join(m.cg.Tool, "isolation")
	if err := os.Mkdir(leaf, 0o700); err != nil {
		return &isolation.Failure{Reason: pl.CodeProbe, Err: err}
	}
	runErr := isolation.Run(ctx, isolation.Options{
		Exe: m.cfg.LaunchExe, CgroupDir: leaf, UID: m.ids.Tool.UID, GID: m.ids.JobGID, Timeout: m.cfg.ProbeTimeout,
	}, isolation.NewRequest(probes))
	if err := removeCgroup(leaf); err != nil && runErr == nil {
		return &isolation.Failure{Reason: pl.CodeProbe, Err: err}
	}
	return runErr
}

// removeCgroup kills anything left in an (otherwise finished) cgroup and removes it, retrying
// while the kernel still counts it populated.
func removeCgroup(dir string) error {
	_ = cgroup.Kill(dir)
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := os.Remove(dir)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// auditReader copies kete's audit pipe into the root-owned KeteAudit file (piece A3). Past
// MaxAuditUpload it stops and closes the pipe, so kete's next write fails (EPIPE) and kete
// interrupts the run; the copy is then not uploaded.
type auditReader struct {
	done      chan struct{}
	size      int64
	overLimit bool
	err       error
}

func startAuditReader(r *os.File, out *os.File) *auditReader {
	a := &auditReader{done: make(chan struct{})}
	go func() {
		defer close(a.done)
		defer out.Close()
		defer r.Close()
		n, err := io.Copy(out, io.LimitReader(r, layout.MaxAuditUpload+1))
		a.size = n
		if n > layout.MaxAuditUpload {
			a.overLimit = true
			return
		}
		a.err = err
	}()
	return a
}

func (m *machine) StartHelper(context.Context) (job.Helper, error) {
	h, err := helper.Start(helper.Options{
		Bin: m.cfg.HelperBin, LaunchExe: m.cfg.LaunchExe, CgroupDir: m.cg.System,
		StderrPath: m.cfg.HelperStderr(), Ready: m.cfg.HelperReady, StopWait: m.cfg.StopWait,
	}, helper.Flags{
		Socket: m.cfg.HelperSocket(), KeteUID: m.ids.Kete.UID, ToolUID: m.ids.Tool.UID, ToolGID: m.ids.JobGID,
		WorktreeRoot: m.cfg.WorkParent, ToolCgroup: m.cg.Tool, EnvAllow: layout.ToolEnvAllow, EnvSet: ToolEnv(m.cfg),
	})
	if err != nil {
		return nil, err
	}
	return h, nil
}

func (m *machine) PrepareWorktree() error {
	return gitops.ChownWalk(m.cfg.Repo(), int(m.ids.Tool.UID), int(m.ids.JobGID))
}

func (m *machine) WriteSpec(spec []byte) error {
	return setup.CreateExclusive(m.cfg.SpecPath(), spec, m.ids.Kete.UID, m.ids.Kete.GID, 0o600)
}

func (m *machine) StartKete(_ context.Context, e job.KeteEnv) (job.Kete, error) {
	if e.GatewayKey == "" {
		return nil, errors.New("start kete: empty gateway key")
	}
	if m.audit != nil {
		return nil, errors.New("start kete: already started")
	}
	// The gateway key travels on a pipe that becomes kete's fd 3, never in its environment. It is at
	// most 4096 bytes (claim validation), below the pipe's capacity, so the write can't block; the
	// write end is closed before kete starts, so kete reads to EOF.
	keyR, keyW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer keyR.Close()
	if _, err := keyW.Write([]byte(e.GatewayKey)); err != nil {
		keyW.Close()
		return nil, err
	}
	if err := keyW.Close(); err != nil {
		return nil, err
	}
	out, err := setup.CreateRootFile(m.cfg.KeteStdout(), false)
	if err != nil {
		return nil, err
	}
	defer out.Close()
	errf, err := setup.CreateRootFile(m.cfg.KeteStderr(), false)
	if err != nil {
		return nil, err
	}
	defer errf.Close()
	// The audit sink (piece A3): a pipe whose write end becomes kete's fd 4. Our copy of the write
	// end is closed once kete has it, so EOF arrives when every kete process is gone; the reader
	// copies the read end into a root-owned file the upload step opens.
	auditFile, err := setup.CreateRootFile(m.cfg.KeteAudit(), false)
	if err != nil {
		return nil, err
	}
	auditR, auditW, err := os.Pipe()
	if err != nil {
		auditFile.Close()
		return nil, err
	}
	m.audit = startAuditReader(auditR, auditFile)
	defer auditW.Close()
	p, err := launch.Start(launch.Options{Exe: m.cfg.LaunchExe, CgroupDir: m.cg.Kete, Stdout: out, Stderr: errf, Extra: []*os.File{keyR, auditW}}, launch.Spec{
		Path: m.cfg.KeteBin, Argv: []string{m.cfg.KeteBin, "job", "run", "--json", m.cfg.SpecPath()},
		Env: KeteEnvList(m.cfg, e), UID: m.ids.Kete.UID, GID: m.ids.Kete.GID, Groups: []uint32{m.ids.JobGID},
		OOMScoreAdj: 0, Umask: 0o002, NoNewPrivs: true, Dir: m.cfg.Repo(),
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (m *machine) KeteExtra() (int, error) {
	pids, err := cgroup.Procs(m.cg.Kete)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, pid := range pids {
		exe, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ESRCH) {
			continue // gone between the two reads (or a zombie with no exe left)
		}
		if err != nil {
			n++ // unreadable: not shown to be kete, so it counts (fail closed)
			continue
		}
		if exe != m.cfg.KeteBin {
			n++
		}
	}
	return n, nil
}

// jobUIDProcesses lists pids with any uid (real, effective, saved, filesystem) of kete or tool.
func (m *machine) jobUIDProcesses() []int {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return []int{-1}
	}
	want := map[string]bool{strconv.FormatUint(uint64(m.ids.Kete.UID), 10): true, strconv.FormatUint(uint64(m.ids.Tool.UID), 10): true}
	var out []int
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		status, err := os.ReadFile("/proc/" + e.Name() + "/status")
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(status), "\n") {
			if rest, ok := strings.CutPrefix(line, "Uid:"); ok {
				for _, f := range strings.Fields(rest) {
					if want[f] {
						out = append(out, pid)
						break
					}
				}
				break
			}
		}
	}
	return out
}

func (m *machine) Reap(ctx context.Context) error {
	deadline := time.Now().Add(m.cfg.ReapTimeout)
	for {
		_ = cgroup.Kill(m.cg.Kete)
		_ = cgroup.Kill(m.cg.Tool)
		kp, err1 := cgroup.Populated(m.cg.Kete)
		tp, err2 := cgroup.Populated(m.cg.Tool)
		if err1 == nil && err2 == nil && !kp && !tp && len(m.jobUIDProcesses()) == 0 {
			return nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return errors.New("job processes are still alive")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (m *machine) KillNow() {
	_ = cgroup.Kill(m.cg.Kete)
	_ = cgroup.Kill(m.cg.Tool)
}

func (m *machine) KillKete() { _ = cgroup.Kill(m.cg.Kete) }

func (m *machine) ReadKeteStdout() ([]byte, error) {
	f, err := os.Open(m.cfg.KeteStdout())
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > layout.MaxKeteStdout {
		if _, err := f.Seek(info.Size()-layout.MaxKeteStdout, io.SeekStart); err != nil {
			return nil, err
		}
	}
	return io.ReadAll(io.LimitReader(f, layout.MaxKeteStdout))
}

// auditWait bounds the wait for the audit reader after Reap (every kete process is gone, so the
// pipe is at EOF unless something unexpected still holds its write end).
const auditWait = 10 * time.Second

func (m *machine) OpenAudit() (io.ReadCloser, int64, error) {
	if m.audit == nil {
		return nil, 0, errors.New("kete was not started")
	}
	select {
	case <-m.audit.done:
	case <-time.After(auditWait):
		return nil, 0, job.ErrAuditReaderStuck
	}
	if m.audit.overLimit {
		return nil, 0, job.ErrAuditTooLarge
	}
	if m.audit.err != nil {
		return nil, 0, m.audit.err
	}
	f, size, err := setup.OpenNoFollow(m.cfg.LogDir, []string{layout.KeteAuditName})
	if err != nil {
		return nil, 0, err
	}
	return f, size, nil
}

func (m *machine) OpenProxyLog() (io.ReadCloser, int64, error) {
	f, err := os.Open(m.cfg.ProxyLog())
	if err != nil {
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}

func (m *machine) BuildBundle(ctx context.Context, baseSHA string) (*bundle.Result, error) {
	return bundle.Build(ctx, bundle.Options{
		Git: m.git, GitDir: m.cfg.Pristine(), WorkParent: m.cfg.WorkParent, RepoName: m.cfg.RepoName,
		TmpDir: m.cfg.RootTmp(), BaseSHA: baseSHA,
		Limits: bundle.Limits{
			MaxFile: layout.BundleMaxFile, MaxBinaryFile: layout.BundleMaxBinaryFile, MaxBinaries: layout.BundleMaxBinaries,
			MaxEntries: layout.BundleMaxEntries, MaxTar: layout.BundleMaxTar, MaxGzip: layout.BundleMaxGzip,
			MaxUntracked: layout.BundleMaxUntracked,
		},
	})
}
