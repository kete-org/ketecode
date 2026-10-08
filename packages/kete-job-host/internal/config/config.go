// Package config reads the agent's configuration (`/etc/kete-job-host/config.json`, ADR 0023
// rule 6): one strict JSON object, unknown fields refused. The operator owns it; the platform
// never changes it, so what it pins (the platform origin, the image allowlist) bounds what a
// compromised platform can make the host do (ADR 0023 rules 13 and 17).
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fsutil"
)

// DefaultPath and DefaultStateDir are the production locations.
const (
	DefaultPath     = "/etc/kete-job-host/config.json"
	DefaultStateDir = "/var/lib/kete-job-host"
	maxFile         = 64 << 10
)

// File is the JSON shape.
type File struct {
	PlatformURL     string   `json:"platform_url"`
	Driver          string   `json:"driver"`
	Slots           int      `json:"slots"`
	Reset           string   `json:"reset"`
	Generation      string   `json:"generation,omitempty"`
	StateDir        string   `json:"state_dir,omitempty"`
	Resolvers       []string `json:"resolvers,omitempty"`
	ImageAllowlist  []string `json:"image_allowlist"`
	KernelAllowlist []string `json:"kernel_allowlist,omitempty"`
	Versions        struct {
		Firecracker string `json:"firecracker,omitempty"`
		GuestKernel string `json:"guest_kernel,omitempty"`
	} `json:"versions"`
	StartsBlocked string `json:"starts_blocked,omitempty"`
	// Firecracker configures the firecracker driver (required by it; refused for dedicated).
	Firecracker *FirecrackerFile `json:"firecracker,omitempty"`
	// Dedicated configures the dedicated driver (optional for it, every field has a default;
	// refused for firecracker).
	Dedicated *DedicatedFile `json:"dedicated,omitempty"`
	// Kubernetes configures the kubernetes driver, the enterprise runner (required by it; refused
	// for the others). Written by the Helm chart (packages/kete-runner-chart) into a ConfigMap.
	Kubernetes *KubernetesFile `json:"kubernetes,omitempty"`
}

// KubernetesFile is the kubernetes driver's section (ADR 0011; spec §4).
type KubernetesFile struct {
	Namespace           string                 `json:"namespace"`
	JobsNamespace       string                 `json:"jobs_namespace"`
	Instance            string                 `json:"instance"`
	AdmissionPolicies   []string               `json:"admission_policies"`
	KeysSecret          string                 `json:"keys_secret,omitempty"`
	StateSecret         string                 `json:"state_secret,omitempty"`
	EnrollmentSecret    string                 `json:"enrollment_secret,omitempty"`
	Lease               string                 `json:"lease,omitempty"`
	RuntimeClassNames   []string               `json:"runtime_class_names"`
	Proxy               string                 `json:"proxy,omitempty"`
	CABundle            string                 `json:"ca_bundle,omitempty"`
	Repositories        []string               `json:"repositories,omitempty"`
	AdvertiseRepos      bool                   `json:"advertise_repositories,omitempty"`
	Boundary            *contract.DataBoundary `json:"boundary,omitempty"`
	PodDriver           string                 `json:"pod_driver"`
	Placeholder         *PlaceholderFile       `json:"placeholder,omitempty"`
	StartTimeoutSeconds int                    `json:"start_timeout_seconds,omitempty"`
}

// PlaceholderFile configures the test-only placeholder pod driver (built with the kete_testdriver
// tag): each machine is a pod running its image's `sleep`, for the controller's kind e2e.
type PlaceholderFile struct {
	// ExitAfter makes machines of an image exit by themselves after Seconds (else they run until
	// stopped).
	ExitAfter []PlaceholderExit `json:"exit_after,omitempty"`
}

// PlaceholderExit is one ExitAfter entry.
type PlaceholderExit struct {
	Image   string `json:"image"`
	Seconds int    `json:"seconds"`
}

// Kubernetes is the validated kubernetes section.
type Kubernetes struct {
	Namespace     string
	JobsNamespace string
	// Instance is the Helm release name (job pod label and selector).
	Instance string
	// AdmissionPolicies are the ValidatingAdmissionPolicies (each with a binding of the same name)
	// that must exist and deny for starts to be allowed: the jobs namespace is Pod Security
	// privileged, so they are its only guard.
	AdmissionPolicies []string
	KeysSecret        string
	StateSecret       string
	EnrollmentSecret  string // "" = none configured
	Lease             string
	RuntimeClasses    []string
	// Proxy is the enterprise HTTP proxy for the platform connection (nil: direct).
	Proxy *url.URL
	// CABundle is a PEM file of extra roots for the platform connection ("" = system roots only).
	CABundle        string
	Repositories    []string
	AdvertiseRepos  bool
	Boundary        contract.DataBoundary
	PodDriver       string
	PlaceholderExit map[string]int
	StartTimeout    time.Duration
}

// PodDriverPlaceholder is the test-only placeholder pod driver; the VM-isolated pod driver is
// piece P2 of the enterprise runtime.
const PodDriverPlaceholder = "placeholder"

// DedicatedFile is the dedicated driver's section.
type DedicatedFile struct {
	GuestNetwork string `json:"guest_network,omitempty"`
	Uplink       string `json:"uplink,omitempty"`
	PidsMax      int    `json:"pids_max,omitempty"`
	MinFreeGiB   int    `json:"min_free_gib,omitempty"`
}

// Dedicated is the validated dedicated section.
type Dedicated struct {
	// GuestNetwork is the IPv4 network the job's /30 (slot 0) comes from (inside RFC 1918, so the
	// host table's private-range drop applies).
	GuestNetwork netip.Prefix
	// Uplink is the interface job traffic leaves by ("" = the IPv4 default route's).
	Uplink string
	// PidsMax bounds the job's processes (the machine cgroup's pids.max).
	PidsMax    int
	MinFreeGiB int
}

// FirecrackerFile is the firecracker driver's section. Every field but kernel has a default.
type FirecrackerFile struct {
	FirecrackerBin string `json:"firecracker_bin,omitempty"`
	JailerBin      string `json:"jailer_bin,omitempty"`
	Kernel         string `json:"kernel"`
	GuestNetwork   string `json:"guest_network,omitempty"`
	Uplink         string `json:"uplink,omitempty"`
	UIDBase        int    `json:"uid_base,omitempty"`
	VMMOverheadMiB int    `json:"vmm_overhead_mib,omitempty"`
	NetMbps        int    `json:"net_mbps,omitempty"`
	DiskMBps       int    `json:"disk_mbps,omitempty"`
	DiskIOPS       int    `json:"disk_iops,omitempty"`
	MinFreeGiB     int    `json:"min_free_gib,omitempty"`
}

// Firecracker is the validated firecracker section.
type Firecracker struct {
	FirecrackerBin string
	JailerBin      string
	// Kernel is the guest kernel file; its SHA-256 must be in KernelAllowlist at every start.
	Kernel string
	// GuestNetwork is the IPv4 pool the guests' /30s come from (inside RFC 1918, so the host
	// table's private-range drop also separates guests).
	GuestNetwork netip.Prefix
	// Uplink is the interface guest traffic leaves by ("" = the IPv4 default route's).
	Uplink string
	// UIDBase: VM in slot n runs as uid and gid UIDBase+n.
	UIDBase        int
	VMMOverheadMiB int
	NetMbps        int
	DiskMBps       int
	DiskIOPS       int
	MinFreeGiB     int
}

// Config is the validated configuration.
type Config struct {
	// Origin is the normalized platform URL, `https://host`; Authority its host (the signature's
	// `@authority`: lowercase, no port).
	Origin    string
	Authority string
	Driver    string
	Slots     int
	Reset     string
	// Generation is the operator-set generation (required for dedicated: its verified reset
	// generation, P5); empty on a firecracker host means "generate one at enrollment".
	Generation      string
	StateDir        string
	Resolvers       []netip.Addr
	ImageAllowlist  []string
	KernelAllowlist []string
	Firecracker     string
	GuestKernel     string
	// StartsBlocked is the operator's own block (`operator`), or "".
	StartsBlocked string
	// FC is the firecracker section (nil when absent).
	FC *Firecracker
	// Ded is the dedicated section with its defaults (set exactly for the dedicated driver).
	Ded *Dedicated
	// Kube is the kubernetes section with its defaults (set exactly for the kubernetes driver).
	Kube *Kubernetes
}

// HostProfile is the machine configuration profile this host's driver runs.
func (c Config) HostProfile() string {
	switch c.Driver {
	case contract.DriverDedicated:
		return "dedicated"
	case contract.DriverKubernetes:
		return "kubevm"
	}
	return "microvm"
}

// Load reads and validates path. The file must be a root-owned regular file that group and
// others can't write, reached without symlinks through root-owned, non-writable directories:
// whoever can change it decides which platform and images the host trusts.
func Load(path string) (Config, error) {
	f, err := fsutil.OpenRootFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		return Config{}, err
	}
	if len(data) > maxFile {
		return Config{}, errors.New("config: file too large")
	}
	return Parse(data)
}

var kernelDigestRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Parse validates the JSON.
func Parse(data []byte) (Config, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f File
	if err := dec.Decode(&f); err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("config: trailing data")
	}
	origin, host, err := NormalizeOrigin(f.PlatformURL)
	if err != nil {
		return Config{}, fmt.Errorf("config: platform_url %w", err)
	}
	c := Config{
		Origin: origin, Authority: host, Driver: f.Driver, Slots: f.Slots, Reset: f.Reset, Generation: f.Generation,
		StateDir: f.StateDir, Firecracker: f.Versions.Firecracker, GuestKernel: f.Versions.GuestKernel,
		StartsBlocked: f.StartsBlocked,
	}
	if c.StateDir == "" {
		c.StateDir = DefaultStateDir
	}
	if !filepath.IsAbs(c.StateDir) || filepath.Clean(c.StateDir) != c.StateDir {
		return Config{}, errors.New("config: state_dir must be a clean absolute path")
	}
	switch c.Driver {
	case contract.DriverFirecracker:
		if c.Reset != contract.ResetNone {
			return Config{}, errors.New("config: a firecracker host declares reset none")
		}
		if !contract.ValidVersion(c.Firecracker) || !contract.ValidVersion(c.GuestKernel) {
			return Config{}, errors.New("config: the firecracker driver needs versions.firecracker and versions.guest_kernel")
		}
	case contract.DriverDedicated:
		// ADR 0023 rule 8: the agent refuses to run the dedicated driver without a verified reset.
		switch c.Reset {
		case contract.ResetProviderRebuild:
		case contract.ResetMeasuredBoot:
			// R2's agent side (internal/reset) has no TPM-resident keys or quotes yet: refused
			// until it does (self-hosted P5 handoff, "R2").
			return Config{}, errors.New("config: measured_boot needs TPM-resident keys and quotes, which this agent doesn't implement yet; use provider_rebuild")
		default:
			return Config{}, errors.New("config: a dedicated host must declare a verified reset (provider_rebuild or measured_boot)")
		}
		if c.Slots != 1 {
			return Config{}, errors.New("config: a dedicated host has exactly 1 slot")
		}
		if !contract.ValidGeneration(c.Generation) {
			return Config{}, errors.New("config: a dedicated host needs its verified reset generation")
		}
		if c.Firecracker != "" || c.GuestKernel != "" {
			return Config{}, errors.New("config: firecracker versions only for the firecracker driver")
		}
	case contract.DriverKubernetes:
		if c.Reset != contract.ResetNone {
			return Config{}, errors.New("config: a kubernetes host declares reset none")
		}
		if c.Firecracker != "" || c.GuestKernel != "" || c.Generation != "" || f.StateDir != "" || len(f.Resolvers) > 0 || len(f.KernelAllowlist) > 0 {
			return Config{}, errors.New("config: versions, generation, state_dir, resolvers and kernel_allowlist are not for the kubernetes driver")
		}
		if c.Slots < 1 || c.Slots > contract.V2MaxSlots {
			return Config{}, fmt.Errorf("config: slots must be 1-%d", contract.V2MaxSlots)
		}
		if n := len(f.ImageAllowlist); n < 1 || n > contract.V2MaxImages {
			return Config{}, fmt.Errorf("config: a kubernetes host allows 1-%d images", contract.V2MaxImages)
		}
	default:
		return Config{}, errors.New("config: driver must be firecracker, dedicated or kubernetes")
	}
	if c.Driver != contract.DriverKubernetes && (c.Slots < 1 || c.Slots > contract.MaxSlots) {
		return Config{}, fmt.Errorf("config: slots must be 1-%d", contract.MaxSlots)
	}
	if c.Generation != "" && !contract.ValidGeneration(c.Generation) {
		return Config{}, errors.New("config: invalid generation")
	}
	if c.StartsBlocked != "" && c.StartsBlocked != contract.BlockedOperator {
		return Config{}, errors.New("config: starts_blocked may only be \"operator\"")
	}
	seen := map[string]bool{}
	for _, ref := range f.ImageAllowlist {
		if !contract.ValidImageRef(ref) {
			return Config{}, fmt.Errorf("config: image_allowlist entry %q is not <registry>/<repository>@sha256:<digest>", ref)
		}
		if !seen[ref] {
			c.ImageAllowlist = append(c.ImageAllowlist, ref)
			seen[ref] = true
		}
	}
	for _, d := range f.KernelAllowlist {
		if !kernelDigestRe.MatchString(d) {
			return Config{}, fmt.Errorf("config: kernel_allowlist entry %q is not sha256:<digest>", d)
		}
		c.KernelAllowlist = append(c.KernelAllowlist, d)
	}
	for _, r := range f.Resolvers {
		a, err := netip.ParseAddr(r)
		if err != nil || !a.Is4() || !PublicIPv4(a) {
			return Config{}, fmt.Errorf("config: resolver %q must be a public IPv4 address (ADR 0023 rule 7)", r)
		}
		c.Resolvers = append(c.Resolvers, a)
	}
	if len(c.Resolvers) > 2 {
		return Config{}, errors.New("config: at most 2 resolvers (the kernel's ip= dns0 and dns1)")
	}
	if f.Firecracker != nil {
		if c.Driver != contract.DriverFirecracker {
			return Config{}, errors.New("config: the firecracker section is only for the firecracker driver")
		}
		fc, err := parseFirecracker(*f.Firecracker, c.Slots)
		if err != nil {
			return Config{}, err
		}
		c.FC = &fc
	}
	if f.Dedicated != nil && c.Driver != contract.DriverDedicated {
		return Config{}, errors.New("config: the dedicated section is only for the dedicated driver")
	}
	if (f.Kubernetes != nil) != (c.Driver == contract.DriverKubernetes) {
		return Config{}, errors.New("config: the kubernetes section is exactly for the kubernetes driver")
	}
	if f.Kubernetes != nil {
		k, err := parseKubernetes(*f.Kubernetes, c.ImageAllowlist)
		if err != nil {
			return Config{}, err
		}
		c.Kube = &k
	}
	if c.Driver == contract.DriverDedicated {
		d, err := parseDedicated(f.Dedicated)
		if err != nil {
			return Config{}, err
		}
		c.Ded = &d
	}
	return c, nil
}

func parseDedicated(f *DedicatedFile) (Dedicated, error) {
	if f == nil {
		f = &DedicatedFile{}
	}
	d := Dedicated{Uplink: f.Uplink, PidsMax: f.PidsMax, MinFreeGiB: f.MinFreeGiB}
	if d.PidsMax == 0 {
		d.PidsMax = 32768
	}
	if d.MinFreeGiB == 0 {
		d.MinFreeGiB = 10
	}
	gn := f.GuestNetwork
	if gn == "" {
		gn = "10.200.0.0/30"
	}
	pool, err := parsePool(gn, 1)
	if err != nil {
		return Dedicated{}, fmt.Errorf("config: dedicated %w", err)
	}
	d.GuestNetwork = pool
	if d.Uplink != "" && !ifnameRe.MatchString(d.Uplink) {
		return Dedicated{}, errors.New("config: invalid uplink interface name")
	}
	if d.PidsMax < 256 || d.PidsMax > 4_194_304 || d.MinFreeGiB < 1 || d.MinFreeGiB > 10_000 {
		return Dedicated{}, errors.New("config: a dedicated limit is out of range")
	}
	return d, nil
}

// parsePool checks a guest network: IPv4, masked, /30 or larger, inside RFC 1918, with at least
// slots /30s.
func parsePool(s string, slots int) (netip.Prefix, error) {
	pool, err := netip.ParsePrefix(s)
	if err != nil || !pool.Addr().Is4() || pool.Masked() != pool || pool.Bits() > 30 {
		return netip.Prefix{}, errors.New("guest_network must be an IPv4 network of /30 or larger")
	}
	private := false
	for _, p := range []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"} {
		pp := netip.MustParsePrefix(p)
		if pp.Bits() <= pool.Bits() && pp.Contains(pool.Addr()) {
			private = true
		}
	}
	if !private {
		return netip.Prefix{}, errors.New("guest_network must lie inside RFC 1918 (10/8, 172.16/12, 192.168/16)")
	}
	if 1<<(32-pool.Bits())/4 < slots {
		return netip.Prefix{}, errors.New("guest_network has fewer /30s than slots")
	}
	return pool, nil
}

var ifnameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$`)

func absClean(p string) bool { return filepath.IsAbs(p) && filepath.Clean(p) == p }

func parseFirecracker(f FirecrackerFile, slots int) (Firecracker, error) {
	def := func(v, d int) int {
		if v == 0 {
			return d
		}
		return v
	}
	str := func(v, d string) string {
		if v == "" {
			return d
		}
		return v
	}
	fc := Firecracker{
		FirecrackerBin: str(f.FirecrackerBin, "/usr/local/bin/firecracker"),
		JailerBin:      str(f.JailerBin, "/usr/local/bin/jailer"),
		Kernel:         f.Kernel,
		Uplink:         f.Uplink,
		UIDBase:        def(f.UIDBase, 900_000_000),
		VMMOverheadMiB: def(f.VMMOverheadMiB, 256),
		NetMbps:        def(f.NetMbps, 1000),
		DiskMBps:       def(f.DiskMBps, 400),
		DiskIOPS:       def(f.DiskIOPS, 10_000),
		MinFreeGiB:     def(f.MinFreeGiB, 10),
	}
	for _, p := range []string{fc.FirecrackerBin, fc.JailerBin, fc.Kernel} {
		if !absClean(p) {
			return Firecracker{}, fmt.Errorf("config: firecracker paths must be clean absolute paths (%q)", p)
		}
	}
	if filepath.Base(fc.FirecrackerBin) != "firecracker" {
		return Firecracker{}, errors.New("config: firecracker_bin must be named firecracker (the jailer names the jail after it)")
	}
	pool, err := netip.ParsePrefix(str(f.GuestNetwork, "10.200.0.0/16"))
	if err != nil || !pool.Addr().Is4() || pool.Masked() != pool || pool.Bits() > 29 {
		return Firecracker{}, errors.New("config: guest_network must be an IPv4 network of /29 or larger")
	}
	private := false
	for _, p := range []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"} {
		pp := netip.MustParsePrefix(p)
		if pp.Bits() <= pool.Bits() && pp.Contains(pool.Addr()) {
			private = true
		}
	}
	if !private {
		return Firecracker{}, errors.New("config: guest_network must lie inside RFC 1918 (10/8, 172.16/12, 192.168/16)")
	}
	if 1<<(32-pool.Bits())/4 < slots {
		return Firecracker{}, errors.New("config: guest_network has fewer /30s than slots")
	}
	fc.GuestNetwork = pool
	if fc.Uplink != "" && !ifnameRe.MatchString(fc.Uplink) {
		return Firecracker{}, errors.New("config: invalid uplink interface name")
	}
	if fc.UIDBase < 100_000 || fc.UIDBase > 4_000_000_000 {
		return Firecracker{}, errors.New("config: uid_base must be 100000-4000000000")
	}
	switch {
	case fc.VMMOverheadMiB < 64 || fc.VMMOverheadMiB > 4096,
		fc.NetMbps < 1 || fc.NetMbps > 100_000,
		fc.DiskMBps < 1 || fc.DiskMBps > 100_000,
		fc.DiskIOPS < 1 || fc.DiskIOPS > 10_000_000,
		fc.MinFreeGiB < 1 || fc.MinFreeGiB > 10_000:
		return Firecracker{}, errors.New("config: a firecracker limit is out of range")
	}
	return fc, nil
}

var specialRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("240.0.0.0/4"),
}

// PublicIPv4 reports an IPv4 address outside every range ADR 0023 rule 7 blocks.
func PublicIPv4(a netip.Addr) bool {
	for _, p := range specialRanges {
		if p.Contains(a) {
			return false
		}
	}
	return a.Is4()
}

var hostRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)

// NormalizeOrigin checks an `https://` URL with a plain lowercase DNS host, port 443 or none, no
// userinfo, path, query or fragment (the entrypoint's bootenv.NormalizeHTTPSURL rule) and returns
// `https://host` and the host.
func NormalizeOrigin(raw string) (string, string, error) {
	if raw == "" {
		return "", "", errors.New("is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", errors.New("is not a URL")
	}
	if u.Scheme != "https" {
		return "", "", errors.New("must be https")
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Path != "" && u.Path != "/") {
		return "", "", errors.New("must be an origin (no userinfo, path, query or fragment)")
	}
	if p := u.Port(); p != "" && p != "443" {
		return "", "", errors.New("must use port 443")
	}
	host := u.Hostname()
	if len(host) > 253 || !hostRe.MatchString(host) || strings.ToLower(host) != host {
		return "", "", errors.New("must name a plain lowercase DNS host")
	}
	return "https://" + host, host, nil
}

func parseKubernetes(f KubernetesFile, images []string) (Kubernetes, error) {
	str := func(v, d string) string {
		if v == "" {
			return d
		}
		return v
	}
	k := Kubernetes{
		Namespace: f.Namespace, JobsNamespace: f.JobsNamespace, Instance: f.Instance,
		KeysSecret: str(f.KeysSecret, "kete-runner-keys"), StateSecret: str(f.StateSecret, "kete-runner-state"),
		EnrollmentSecret: f.EnrollmentSecret, Lease: str(f.Lease, "kete-runner"),
		CABundle: f.CABundle, AdvertiseRepos: f.AdvertiseRepos, Boundary: contract.DefaultDataBoundary,
		PodDriver: f.PodDriver, StartTimeout: 10 * time.Minute,
	}
	for _, n := range []string{k.Namespace, k.JobsNamespace} {
		if !dns1123Label(n) {
			return Kubernetes{}, fmt.Errorf("config: kubernetes namespace %q is not a DNS-1123 label", n)
		}
	}
	if !dns1123Label(k.Instance) {
		return Kubernetes{}, errors.New("config: kubernetes instance (the release name) must be a DNS-1123 label")
	}
	if n := len(f.AdmissionPolicies); n < 1 || n > 8 {
		return Kubernetes{}, errors.New("config: kubernetes admission_policies must name 1-8 policies (the jobs namespace's guard)")
	}
	for _, p := range f.AdmissionPolicies {
		if !contract.ValidKubernetesName(p) || slices.Contains(k.AdmissionPolicies, p) {
			return Kubernetes{}, fmt.Errorf("config: admission policy %q is invalid or repeated", p)
		}
		k.AdmissionPolicies = append(k.AdmissionPolicies, p)
	}
	if k.Namespace == k.JobsNamespace {
		return Kubernetes{}, errors.New("config: the controller and jobs namespaces must differ")
	}
	names := []string{k.KeysSecret, k.StateSecret, k.Lease}
	if k.EnrollmentSecret != "" {
		names = append(names, k.EnrollmentSecret)
	}
	for _, n := range names {
		if !contract.ValidKubernetesName(n) {
			return Kubernetes{}, fmt.Errorf("config: kubernetes object name %q is invalid", n)
		}
	}
	if k.KeysSecret == k.StateSecret || k.KeysSecret == k.EnrollmentSecret || k.StateSecret == k.EnrollmentSecret {
		return Kubernetes{}, errors.New("config: the keys, state and enrollment Secrets must differ")
	}
	k.RuntimeClasses = append([]string(nil), f.RuntimeClassNames...)
	if n := len(k.RuntimeClasses); n < 1 || n > contract.V2MaxRuntimeClasses {
		return Kubernetes{}, fmt.Errorf("config: runtime_class_names must name 1-%d RuntimeClasses", contract.V2MaxRuntimeClasses)
	}
	seen := map[string]bool{}
	for _, n := range k.RuntimeClasses {
		if !contract.ValidKubernetesName(n) || seen[n] {
			return Kubernetes{}, fmt.Errorf("config: runtime class %q is invalid or repeated", n)
		}
		seen[n] = true
	}
	if f.Proxy != "" {
		u, err := url.Parse(f.Proxy)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.Hostname() == "" ||
			u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			// Credentials never sit in the configuration (a ConfigMap): proxy authentication is a
			// later addition through a Secret.
			return Kubernetes{}, errors.New("config: kubernetes proxy must be http(s)://host[:port] without credentials, path or query")
		}
		k.Proxy = u
	}
	if k.CABundle != "" && !absClean(k.CABundle) {
		return Kubernetes{}, errors.New("config: kubernetes ca_bundle must be a clean absolute path")
	}
	seen = map[string]bool{}
	for _, r := range f.Repositories {
		if !contract.ValidRuntimeRepoName(r) || seen[r] {
			return Kubernetes{}, fmt.Errorf("config: repository %q is invalid or repeated", r)
		}
		seen[r] = true
		k.Repositories = append(k.Repositories, r)
	}
	if len(k.Repositories) > contract.V2MaxRepositories {
		return Kubernetes{}, fmt.Errorf("config: at most %d repositories", contract.V2MaxRepositories)
	}
	if f.Boundary != nil {
		if err := f.Boundary.Validate(); err != nil {
			return Kubernetes{}, fmt.Errorf("config: kubernetes %w", err)
		}
		k.Boundary = *f.Boundary
	}
	switch k.PodDriver {
	case PodDriverPlaceholder:
	case "":
		return Kubernetes{}, errors.New("config: kubernetes pod_driver is required (the VM-isolated pod driver is not built yet; placeholder is for test builds)")
	default:
		return Kubernetes{}, fmt.Errorf("config: unknown kubernetes pod_driver %q", k.PodDriver)
	}
	if f.Placeholder != nil && k.PodDriver != PodDriverPlaceholder {
		return Kubernetes{}, errors.New("config: the placeholder section is only for the placeholder pod driver")
	}
	k.PlaceholderExit = map[string]int{}
	if f.Placeholder != nil {
		for _, e := range f.Placeholder.ExitAfter {
			if !slices.Contains(images, e.Image) || e.Seconds < 1 || e.Seconds > 86_400 || k.PlaceholderExit[e.Image] != 0 {
				return Kubernetes{}, errors.New("config: placeholder exit_after entries name an allowlisted image once, 1-86400 seconds")
			}
			k.PlaceholderExit[e.Image] = e.Seconds
		}
	}
	if f.StartTimeoutSeconds != 0 {
		if f.StartTimeoutSeconds < 30 || f.StartTimeoutSeconds > 3_600 {
			return Kubernetes{}, errors.New("config: kubernetes start_timeout_seconds must be 30-3600")
		}
		k.StartTimeout = time.Duration(f.StartTimeoutSeconds) * time.Second
	}
	return k, nil
}

var dns1123LabelRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)

func dns1123Label(s string) bool { return dns1123LabelRe.MatchString(s) }
