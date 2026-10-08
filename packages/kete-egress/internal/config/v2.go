package config

// Configuration v2 (`docs/platform/egress-config-v2.md`; module README "Configuration v2"): v1
// plus an upstream proxy reached with CONNECT, a CA bundle for upstream TLS, and internal
// destinations (private ranges, ports other than 443) allowed by CIDR for the proxy user. ParseV2
// validates a document and Runtime turns it into the Config the proxy and the firewall run on
// (Load picks the version; the `serve` and `nft` subcommands read both).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/blocked"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/hostname"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/registry"
)

// v2 limits.
const (
	VersionV2           = 2
	InternalMaxRanges   = 32
	InternalMaxPorts    = 16
	TargetsMaxPerList   = 256
	DirectMax           = 64
	targetMaxLen        = 259
	proxyURLMaxLen      = 300
	filePathMaxLen      = 255
	internalMinPrefixV4 = 8
	internalMinPrefixV6 = 32
)

// FieldError is a refused v2 configuration: Field is where (a dotted path such as
// `upstream.proxy` or `internal.1.cidr`), never a secret value.
type FieldError struct {
	Field string
	Msg   string
}

func (e *FieldError) Error() string { return "config: " + e.Field + ": " + e.Msg }

func fieldErr(field, format string, args ...any) error {
	return &FieldError{Field: field, Msg: fmt.Sprintf(format, args...)}
}

// Target is an allowlist entry: a plain DNS host and a port (443 when the entry names none).
type Target struct {
	Host string
	Port uint16
}

// String is the entry's one spelling: the bare host for 443, `host:port` otherwise.
func (t Target) String() string {
	if t.Port == 443 {
		return t.Host
	}
	return t.Host + ":" + strconv.Itoa(int(t.Port))
}

const dnsHost = `(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?`

var (
	targetRe   = regexp.MustCompile(`^(` + dnsHost + `)(?::([1-9][0-9]{0,4}))?$`)
	proxyURLRe = regexp.MustCompile(`^(https?)://(` + dnsHost + `|[0-9.]+):([1-9][0-9]{0,4})$`)
	filePathRe = regexp.MustCompile(`^/run(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)+$`)
)

// ParseTarget parses an allowlist entry (EgressTarget): a lowercase DNS host, optionally `:port`
// with a port 1–65535 without leading zeros; `host:443` is refused (the bare host is the one
// spelling of 443), and so is anything v1's host rules refuse.
func ParseTarget(s string) (Target, error) {
	m := targetRe.FindStringSubmatch(s)
	if len(s) > targetMaxLen || m == nil {
		return Target{}, fmt.Errorf("%q is not a DNS host or host:port", s)
	}
	port := 443
	if m[2] != "" {
		port, _ = strconv.Atoi(m[2])
		if port > 65535 || port == 443 {
			return Target{}, fmt.Errorf("%q: the port must be 1-65535 and not 443 (write the bare host for 443)", s)
		}
	}
	h, err := hostname.Normalize(m[1])
	if err != nil || h != m[1] {
		return Target{}, fmt.Errorf("%q is not a plain DNS host", s)
	}
	return Target{Host: h, Port: uint16(port)}, nil
}

// Upstream is the validated `upstream`.
type Upstream struct {
	// Scheme is http or https (TLS to the proxy, verified).
	Scheme string
	// Host is a DNS name or an IPv4 literal; Addr is set when it is a literal.
	Host string
	Addr netip.Addr
	Port uint16
	// ProxyAuthFile holds `username:password` (never inline, never logged); CABundleFile holds
	// PEM certificates trusted in addition to the image's roots for upstream TLS only. Both are
	// under /run/ ("" when absent).
	ProxyAuthFile string
	CABundleFile  string
	// Direct entries are dialled without the proxy.
	Direct map[Target]bool
}

// InternalRange allows the proxy user to reach Prefix on exactly Ports, although v1 blocks it.
type InternalRange struct {
	Prefix netip.Prefix
	Ports  []uint16
}

// ConfigV2 is a validated configuration v2.
type ConfigV2 struct {
	UIDs      UIDs
	Ports     map[Port]uint16
	Resolvers []netip.AddrPort
	// Allow maps phase → port → allowed targets.
	Allow map[phase.Phase]map[Port]map[Target]bool
	// Registries are the configured registry rules plus every built-in registry host allowlisted
	// on 443 without an entry.
	Registries map[Target]registry.Spec
	Limits     Limits
	Upstream   *Upstream
	Internal   []InternalRange
}

// Runtime is the configuration the proxy and the firewall run on: v1's Config with Allow and
// Registries keyed by each target's one spelling (Target.String()), Upstream and Internal set.
func (c *ConfigV2) Runtime() *Config {
	out := &Config{
		Version: VersionV2, UIDs: c.UIDs, Ports: c.Ports, Resolvers: c.Resolvers, Limits: c.Limits,
		Allow: map[phase.Phase]map[Port]map[string]bool{}, Registries: map[string]registry.Spec{},
		Upstream: c.Upstream, Internal: c.Internal,
	}
	for ph, ports := range c.Allow {
		m := map[Port]map[string]bool{}
		for port, ts := range ports {
			set := map[string]bool{}
			for t := range ts {
				set[t.String()] = true
			}
			m[port] = set
		}
		out.Allow[ph] = m
	}
	for t, spec := range c.Registries {
		out.Registries[t.String()] = spec
	}
	return out
}

// AllTargets is the sorted union of every allowlisted target.
func (c *ConfigV2) AllTargets() []Target {
	set := map[Target]bool{}
	for _, ports := range c.Allow {
		for _, ts := range ports {
			for t := range ts {
				set[t] = true
			}
		}
	}
	out := make([]Target, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}

type rawUpstream struct {
	Proxy         *string  `json:"proxy"`
	ProxyAuthFile *string  `json:"proxy_auth_file"`
	CABundleFile  *string  `json:"ca_bundle_file"`
	Direct        []string `json:"direct"`
}

type rawInternal struct {
	CIDR  *string `json:"cidr"`
	Ports []int   `json:"ports"`
}

type rawConfigV2 struct {
	Version    *int          `json:"version"`
	UIDs       *rawUIDs      `json:"uids"`
	Ports      *rawPorts     `json:"ports"`
	Resolvers  []string      `json:"resolvers"`
	Phases     *rawPhases    `json:"phases"`
	Registries []rawRegistry `json:"registries"`
	Limits     *rawLimits    `json:"limits"`
	Upstream   *rawUpstream  `json:"upstream"`
	Internal   []rawInternal `json:"internal"`
}

// v2Keys is every object's allowed keys, by path ("*" for each array element).
var v2Keys = map[string][]string{
	"":             {"version", "uids", "ports", "resolvers", "phases", "registries", "limits", "upstream", "internal"},
	"uids":         {"proxy", "kete", "tool"},
	"ports":        {"kete", "tool", "root"},
	"phases":       {"clone", "agent", "report"},
	"phases.*":     {"kete", "tool", "root"},
	"registries.*": {"host", "kind", "shapes"},
	"limits":       {"registry_requests", "log_max_bytes"},
	"upstream":     {"proxy", "proxy_auth_file", "ca_bundle_file", "direct"},
	"internal.*":   {"cidr", "ports"},
}

// checkV2Shape refuses an unknown field in any object (so inline credentials can't hide in an
// unread field) and any null (the schema has no nullable field; v1's reader treats null as
// absent, v2 refuses it), naming the path.
func checkV2Shape(v any, path, pattern string) error {
	switch x := v.(type) {
	case nil:
		return fieldErr(orTop(path), "null is not a value")
	case map[string]any:
		allowed, known := v2Keys[pattern]
		for k, val := range x {
			if known && !slices.Contains(allowed, k) {
				return fieldErr(orTop(path), "unknown field %q", k)
			}
			next := k
			if pattern == "phases" {
				next = "*"
			}
			if err := checkV2Shape(val, joinPath(path, k), joinPath(pattern, next)); err != nil {
				return err
			}
		}
	case []any:
		for i, el := range x {
			if err := checkV2Shape(el, joinPath(path, strconv.Itoa(i)), joinPath(pattern, "*")); err != nil {
				return err
			}
		}
	}
	return nil
}

func joinPath(a, b string) string {
	if a == "" {
		return b
	}
	return a + "." + b
}

func orTop(p string) string {
	if p == "" {
		return "config"
	}
	return p
}

// ParseV2 reads and validates a configuration v2 from r. Refusals are *FieldError.
func ParseV2(r io.Reader) (*ConfigV2, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	if len(data) > MaxBytes {
		return nil, fieldErr("config", "larger than %d bytes", MaxBytes)
	}
	var generic any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&generic); err != nil {
		return nil, fieldErr("config", "not valid JSON")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fieldErr("config", "trailing data after the JSON object")
	}
	if _, ok := generic.(map[string]any); !ok {
		return nil, fieldErr("config", "not a JSON object")
	}
	if err := checkV2Shape(generic, "", ""); err != nil {
		return nil, err
	}
	var raw rawConfigV2
	dec = json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil {
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) && te.Field != "" {
			return nil, fieldErr(te.Field, "wrong type")
		}
		return nil, fieldErr("config", "%v", err)
	}
	return validateV2(&raw)
}

// wrap names the field of a v1 helper's error.
func wrap(field string, err error) error {
	return fieldErr(field, "%s", strings.TrimPrefix(err.Error(), "config: "))
}

func validateV2(raw *rawConfigV2) (*ConfigV2, error) {
	if raw.Version == nil || *raw.Version != VersionV2 {
		return nil, fieldErr("version", "must be %d (a version 1 document is read by Parse)", VersionV2)
	}
	cfg := &ConfigV2{}
	var err error
	if cfg.UIDs, err = validateUIDs(raw.UIDs); err != nil {
		return nil, wrap("uids", err)
	}
	if cfg.Ports, err = validatePorts(raw.Ports); err != nil {
		return nil, wrap("ports", err)
	}
	if cfg.Resolvers, err = validateResolvers(raw.Resolvers); err != nil {
		return nil, wrap("resolvers", err)
	}
	if len(raw.Resolvers) > 8 {
		return nil, fieldErr("resolvers", "at most 8")
	}
	for _, s := range raw.Resolvers {
		if !resolverV2Re.MatchString(s) {
			return nil, fieldErr("resolvers", "%q must be ipv4:53 or [ipv6]:53, lowercase", s)
		}
	}

	// internal (first: every other port is checked against it)
	if len(raw.Internal) > InternalMaxRanges {
		return nil, fieldErr("internal", "at most %d ranges", InternalMaxRanges)
	}
	internalPorts := map[uint16]bool{}
	for i, r := range raw.Internal {
		field := fmt.Sprintf("internal.%d", i)
		if r.CIDR == nil {
			return nil, fieldErr(field+".cidr", "required")
		}
		p, err := ParseInternalCIDR(*r.CIDR)
		if err != nil {
			return nil, fieldErr(field+".cidr", "%v", err)
		}
		for j, prev := range cfg.Internal {
			if prev.Prefix.Overlaps(p) {
				return nil, fieldErr(field+".cidr", "overlaps internal.%d", j)
			}
		}
		if len(r.Ports) < 1 || len(r.Ports) > InternalMaxPorts {
			return nil, fieldErr(field+".ports", "needs 1-%d ports", InternalMaxPorts)
		}
		rng := InternalRange{Prefix: p}
		for _, port := range r.Ports {
			if port < 1 || port > 65535 {
				return nil, fieldErr(field+".ports", "port %d is not 1-65535", port)
			}
			if slices.Contains(rng.Ports, uint16(port)) {
				return nil, fieldErr(field+".ports", "port %d is listed twice", port)
			}
			rng.Ports = append(rng.Ports, uint16(port))
			internalPorts[uint16(port)] = true
		}
		cfg.Internal = append(cfg.Internal, rng)
	}

	// phases: v1's rules, with host:port entries
	if raw.Phases == nil {
		return nil, fieldErr("phases", "required")
	}
	cfg.Allow = map[phase.Phase]map[Port]map[Target]bool{}
	allowed := map[Target]bool{}
	for _, ph := range []struct {
		p   phase.Phase
		set *rawPortSet
	}{{phase.Clone, raw.Phases.Clone}, {phase.Agent, raw.Phases.Agent}, {phase.Report, raw.Phases.Report}} {
		ports := map[Port]map[Target]bool{}
		cfg.Allow[ph.p] = ports
		if ph.set == nil {
			continue
		}
		for _, pl := range []struct {
			port    Port
			targets []string
		}{{PortKete, ph.set.Kete}, {PortTool, ph.set.Tool}, {PortRoot, ph.set.Root}} {
			field := fmt.Sprintf("phases.%s.%s", ph.p, pl.port)
			if len(pl.targets) > TargetsMaxPerList {
				return nil, fieldErr(field, "at most %d entries", TargetsMaxPerList)
			}
			set := map[Target]bool{}
			for _, s := range pl.targets {
				t, err := ParseTarget(s)
				if err != nil {
					return nil, fieldErr(field, "%v", err)
				}
				if set[t] {
					return nil, fieldErr(field, "lists %q twice", s)
				}
				if t.Port != 443 && !internalPorts[t.Port] {
					return nil, fieldErr(field, "port %d of %q is in no internal range", t.Port, s)
				}
				set[t] = true
				allowed[t] = true
			}
			ports[pl.port] = set
		}
	}
	if len(allowed) == 0 {
		return nil, fieldErr("phases", "allow no host at all")
	}
	for _, ph := range []phase.Phase{phase.Clone, phase.Report} {
		if len(cfg.Allow[ph][PortTool]) > 0 {
			return nil, fieldErr(fmt.Sprintf("phases.%s.tool", ph), "must be empty (the tool user may reach registries in the agent phase only)")
		}
	}

	// registries: v1's rules, keyed by target
	cfg.Registries = map[Target]registry.Spec{}
	for i, r := range raw.Registries {
		field := fmt.Sprintf("registries.%d", i)
		t, err := ParseTarget(r.Host)
		if err != nil {
			return nil, fieldErr(field+".host", "%v", err)
		}
		if _, dup := cfg.Registries[t]; dup {
			return nil, fieldErr(field+".host", "%q is listed twice", r.Host)
		}
		if t.Port != 443 && !internalPorts[t.Port] {
			return nil, fieldErr(field+".host", "port %d is in no internal range", t.Port)
		}
		spec := registry.Spec{Kind: registry.Kind(r.Kind), Shapes: r.Shapes}
		host := t.Host
		if t.Port != 443 {
			host = t.String() // a mirror on another port is never a built-in host
		}
		if err := registry.Validate(host, spec); err != nil {
			return nil, fieldErr(field, "%v", err)
		}
		cfg.Registries[t] = spec
	}
	for t := range allowed {
		if t.Port != 443 {
			continue
		}
		if kind, ok := registry.BuiltinHosts[t.Host]; ok {
			if _, declared := cfg.Registries[t]; !declared {
				cfg.Registries[t] = registry.Spec{Kind: kind}
			}
		}
	}
	for t := range cfg.Allow[phase.Agent][PortTool] {
		if _, ok := cfg.Registries[t]; !ok {
			return nil, fieldErr("phases.agent.tool", "lists %q, which is neither a built-in registry host nor in registries (the tool user may reach registries only)", t)
		}
	}

	if cfg.Limits, err = validateLimits(raw.Limits); err != nil {
		return nil, wrap("limits", err)
	}

	// upstream
	if u := raw.Upstream; u != nil {
		up, err := parseUpstream(u)
		if err != nil {
			return nil, err
		}
		cfg.Upstream = up
	}

	if up := cfg.Upstream; up != nil {
		if up.Port != 443 && !internalPorts[up.Port] {
			return nil, fieldErr("upstream.proxy", "port %d is in no internal range", up.Port)
		}
		for i, d := range raw.Upstream.Direct {
			t, _ := ParseTarget(d)
			if !allowed[t] {
				return nil, fieldErr(fmt.Sprintf("upstream.direct.%d", i), "%q is in no allowlist", d)
			}
		}
		if up.Addr.IsValid() {
			if blocked.IsForbidden(up.Addr) {
				return nil, fieldErr("upstream.proxy", "the proxy address is in a forbidden range")
			}
			// v1's firewall blocks private, CGNAT, link-local, multicast and reserved addresses
			// (internal/blocked): a proxy there must be inside an internal range.
			if blocked.Contains(up.Addr) && !slices.ContainsFunc(cfg.Internal, func(r InternalRange) bool { return r.Prefix.Contains(up.Addr) }) {
				return nil, fieldErr("upstream.proxy", "a proxy in a blocked range must be inside an internal range")
			}
		}
	}
	return cfg, nil
}

var resolverV2Re = regexp.MustCompile(`^(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3}|\[[0-9a-f:]+\]):53$`)

func parseUpstream(u *rawUpstream) (*Upstream, error) {
	if u.Proxy == nil {
		return nil, fieldErr("upstream.proxy", "required")
	}
	m := proxyURLRe.FindStringSubmatch(*u.Proxy)
	if len(*u.Proxy) > proxyURLMaxLen || m == nil {
		return nil, fieldErr("upstream.proxy", "must be http://host:port or https://host:port (no userinfo, path or query)")
	}
	port, _ := strconv.Atoi(m[3])
	if port > 65535 {
		return nil, fieldErr("upstream.proxy", "port %d is not 1-65535", port)
	}
	up := &Upstream{Scheme: m[1], Host: m[2], Port: uint16(port), Direct: map[Target]bool{}}
	if strings.Trim(m[2], "0123456789.") == "" {
		a, err := netip.ParseAddr(m[2])
		if err != nil || !a.Is4() {
			return nil, fieldErr("upstream.proxy", "the host is not an IPv4 address")
		}
		up.Addr = a
	} else if h, err := hostname.Normalize(m[2]); err != nil || h != m[2] {
		return nil, fieldErr("upstream.proxy", "the host is not a plain DNS name")
	}
	for _, f := range []struct {
		name string
		v    *string
		dst  *string
	}{{"proxy_auth_file", u.ProxyAuthFile, &up.ProxyAuthFile}, {"ca_bundle_file", u.CABundleFile, &up.CABundleFile}} {
		if f.v == nil {
			continue
		}
		if len(*f.v) > filePathMaxLen || !filePathRe.MatchString(*f.v) {
			return nil, fieldErr("upstream."+f.name, "must be a path under /run/ whose segments start with a letter, digit or _")
		}
		*f.dst = *f.v
	}
	if len(u.Direct) > DirectMax {
		return nil, fieldErr("upstream.direct", "at most %d entries", DirectMax)
	}
	for i, d := range u.Direct {
		t, err := ParseTarget(d)
		if err != nil {
			return nil, fieldErr(fmt.Sprintf("upstream.direct.%d", i), "%v", err)
		}
		if up.Direct[t] {
			return nil, fieldErr("upstream.direct", "%q is listed twice", d)
		}
		up.Direct[t] = true
	}
	return up, nil
}

// ParseInternalCIDR parses an internal range (EgressCidr): canonical text (lowercase, RFC 5952
// for IPv6 — never a dotted IPv4 tail — no host bits), at least /8 (IPv4) or /32 (IPv6), and
// touching no forbidden range.
func ParseInternalCIDR(s string) (netip.Prefix, error) {
	p, err := netip.ParsePrefix(s)
	if err != nil || p.Addr().Zone() != "" {
		return netip.Prefix{}, fmt.Errorf("%q is not a CIDR", s)
	}
	m := p.Masked()
	canonical := formatAddr(m.Addr()) + "/" + strconv.Itoa(m.Bits())
	if canonical != s {
		return netip.Prefix{}, fmt.Errorf("%q is not canonical (%s)", s, canonical)
	}
	if (m.Addr().Is4() && m.Bits() < internalMinPrefixV4) || (!m.Addr().Is4() && m.Bits() < internalMinPrefixV6) {
		return netip.Prefix{}, fmt.Errorf("%q is broader than /%d (IPv4) or /%d (IPv6)", s, internalMinPrefixV4, internalMinPrefixV6)
	}
	if blocked.ForbiddenOverlaps(m) {
		return netip.Prefix{}, fmt.Errorf("%q touches a forbidden range", s)
	}
	return m, nil
}

// formatAddr writes IPv4 dotted and IPv6 per RFC 5952 with hex groups only (as the platform's
// schema does; Go writes an IPv4-mapped address with a dotted tail).
func formatAddr(a netip.Addr) string {
	if a.Is4() {
		return a.String()
	}
	b := a.As16()
	var g [8]uint16
	for i := range g {
		g[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
	}
	best, bestLen := -1, 1
	for i := 0; i < 8; {
		if g[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && g[j] == 0 {
			j++
		}
		if j-i > bestLen {
			best, bestLen = i, j-i
		}
		i = j
	}
	hex := func(gs []uint16) string {
		parts := make([]string, len(gs))
		for i, x := range gs {
			parts[i] = strconv.FormatUint(uint64(x), 16)
		}
		return strings.Join(parts, ":")
	}
	if best < 0 {
		return hex(g[:])
	}
	return hex(g[:best]) + "::" + hex(g[best+bestLen:])
}
