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
	"strings"

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
}

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
}

// HostProfile is the machine configuration profile this host's driver runs.
func (c Config) HostProfile() string {
	if c.Driver == contract.DriverDedicated {
		return "dedicated"
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
	default:
		return Config{}, errors.New("config: driver must be firecracker or dedicated")
	}
	if c.Slots < 1 || c.Slots > contract.MaxSlots {
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
