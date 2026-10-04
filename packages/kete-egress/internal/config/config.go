// Package config parses and validates kete-egress configuration v1 (module README
// "Configuration"). The same file drives both subcommands: `nft` (the firewall) and `serve` (the
// proxy). Unknown fields are refused, every host goes through internal/hostname, and limits may
// only be lowered. This package does no I/O beyond reading the bytes it's given.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"sort"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/hostname"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/registry"
)

const (
	// Version is the only configuration version this build understands.
	Version = 1

	// MaxBytes bounds the configuration file.
	MaxBytes = 1 << 20

	// DefaultLogMaxBytes is the default, and highest, request-log size (decision D8: 10 MB read as
	// 10,000,000 bytes, safe under both definitions).
	DefaultLogMaxBytes = 10_000_000
	// MinLogMaxBytes leaves room for at least one line and the log_full marker.
	MinLogMaxBytes = 4096

	// ResolverPort is the only DNS port the firewall's exception opens.
	ResolverPort = 53
)

// Port names one of the proxy's three listeners, and so the user it serves.
type Port int

const (
	PortKete Port = iota // port A: the kete user
	PortTool             // port B: the tool user
	PortRoot             // port R: root
)

// Ports lists every Port, in fd order (fds 3, 4, 5).
var Ports = []Port{PortKete, PortTool, PortRoot}

func (p Port) String() string {
	switch p {
	case PortKete:
		return "kete"
	case PortTool:
		return "tool"
	case PortRoot:
		return "root"
	}
	return fmt.Sprintf("port(%d)", int(p))
}

// UIDs are the numeric users the rules and the proxy's peer check use. Root is always 0.
type UIDs struct {
	Proxy uint32
	Kete  uint32
	Tool  uint32
}

// ForPort is the uid a port serves.
func (u UIDs) ForPort(p Port) uint32 {
	switch p {
	case PortKete:
		return u.Kete
	case PortTool:
		return u.Tool
	}
	return 0
}

// Limits are the effective limits after defaults.
type Limits struct {
	RegistryRequests int
	LogMaxBytes      int64
}

// Config is a validated configuration.
type Config struct {
	UIDs      UIDs
	Ports     map[Port]uint16
	Resolvers []netip.AddrPort
	// Allow maps phase → port → allowed host set.
	Allow map[phase.Phase]map[Port]map[string]bool
	// Registries are the effective registry rules: the configured entries plus every built-in
	// registry host that appears in an allowlist without an entry (all its kind's shapes).
	Registries map[string]registry.Spec
	Limits     Limits
}

// AllHosts is the sorted union of every allowlisted host (the CA's name constraints).
func (c *Config) AllHosts() []string {
	set := map[string]bool{}
	for _, ports := range c.Allow {
		for _, hosts := range ports {
			for h := range hosts {
				set[h] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for h := range set {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

type rawConfig struct {
	Version    *int          `json:"version"`
	UIDs       *rawUIDs      `json:"uids"`
	Ports      *rawPorts     `json:"ports"`
	Resolvers  []string      `json:"resolvers"`
	Phases     *rawPhases    `json:"phases"`
	Registries []rawRegistry `json:"registries"`
	Limits     *rawLimits    `json:"limits"`
}

type rawUIDs struct {
	Proxy *int64 `json:"proxy"`
	Kete  *int64 `json:"kete"`
	Tool  *int64 `json:"tool"`
}

type rawPorts struct {
	Kete *int `json:"kete"`
	Tool *int `json:"tool"`
	Root *int `json:"root"`
}

type rawPortSet struct {
	Kete []string `json:"kete"`
	Tool []string `json:"tool"`
	Root []string `json:"root"`
}

type rawPhases struct {
	Clone  *rawPortSet `json:"clone"`
	Agent  *rawPortSet `json:"agent"`
	Report *rawPortSet `json:"report"`
}

type rawRegistry struct {
	Host   string   `json:"host"`
	Kind   string   `json:"kind"`
	Shapes []string `json:"shapes"`
}

type rawLimits struct {
	RegistryRequests *int   `json:"registry_requests"`
	LogMaxBytes      *int64 `json:"log_max_bytes"`
}

// Parse reads and validates a configuration from r.
func Parse(r io.Reader) (*Config, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	if len(data) > MaxBytes {
		return nil, fmt.Errorf("config is larger than %d bytes", MaxBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var raw rawConfig
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("config: trailing data after the JSON object")
	}
	return validate(&raw)
}

func validate(raw *rawConfig) (*Config, error) {
	if raw.Version == nil {
		return nil, errors.New("config: version is required")
	}
	if *raw.Version != Version {
		return nil, fmt.Errorf("config: version %d is not supported (this build reads version %d)", *raw.Version, Version)
	}
	cfg := &Config{}

	// uids
	if raw.UIDs == nil {
		return nil, errors.New("config: uids is required")
	}
	uid := func(name string, v *int64) (uint32, error) {
		if v == nil {
			return 0, fmt.Errorf("config: uids.%s is required", name)
		}
		if *v <= 0 || *v >= 1<<32-1 {
			return 0, fmt.Errorf("config: uids.%s must be a non-zero uid (got %d)", name, *v)
		}
		return uint32(*v), nil
	}
	var err error
	if cfg.UIDs.Proxy, err = uid("proxy", raw.UIDs.Proxy); err != nil {
		return nil, err
	}
	if cfg.UIDs.Kete, err = uid("kete", raw.UIDs.Kete); err != nil {
		return nil, err
	}
	if cfg.UIDs.Tool, err = uid("tool", raw.UIDs.Tool); err != nil {
		return nil, err
	}
	u := cfg.UIDs
	if u.Proxy == u.Kete || u.Proxy == u.Tool || u.Kete == u.Tool {
		return nil, errors.New("config: uids.proxy, uids.kete and uids.tool must all differ")
	}

	// ports
	if raw.Ports == nil {
		return nil, errors.New("config: ports is required")
	}
	cfg.Ports = map[Port]uint16{}
	seenPort := map[int]bool{}
	for _, p := range []struct {
		port Port
		v    *int
	}{{PortKete, raw.Ports.Kete}, {PortTool, raw.Ports.Tool}, {PortRoot, raw.Ports.Root}} {
		if p.v == nil {
			return nil, fmt.Errorf("config: ports.%s is required", p.port)
		}
		if *p.v < 1 || *p.v > 1023 {
			return nil, fmt.Errorf("config: ports.%s must be a privileged port, 1-1023 (got %d)", p.port, *p.v)
		}
		if seenPort[*p.v] {
			return nil, fmt.Errorf("config: ports must be distinct (%d is used twice)", *p.v)
		}
		seenPort[*p.v] = true
		cfg.Ports[p.port] = uint16(*p.v)
	}

	// resolvers
	if len(raw.Resolvers) == 0 {
		return nil, errors.New("config: resolvers needs at least one resolver")
	}
	seenRes := map[netip.AddrPort]bool{}
	for _, s := range raw.Resolvers {
		ap, err := netip.ParseAddrPort(s)
		if err != nil {
			return nil, fmt.Errorf("config: resolver %q must be an IP literal and a port (e.g. \"[fdaa::3]:53\"): %v", s, err)
		}
		a := ap.Addr()
		if a.Zone() != "" {
			return nil, fmt.Errorf("config: resolver %q must not carry a zone", s)
		}
		if a.Is4In6() {
			return nil, fmt.Errorf("config: resolver %q must be written as plain IPv4", s)
		}
		if a.IsLoopback() || a.IsUnspecified() || a.IsMulticast() {
			return nil, fmt.Errorf("config: resolver %q must not be loopback, unspecified or multicast", s)
		}
		if ap.Port() != ResolverPort {
			return nil, fmt.Errorf("config: resolver %q must use port %d", s, ResolverPort)
		}
		if seenRes[ap] {
			return nil, fmt.Errorf("config: resolver %q is listed twice", s)
		}
		seenRes[ap] = true
		cfg.Resolvers = append(cfg.Resolvers, ap)
	}

	// phases
	if raw.Phases == nil {
		return nil, errors.New("config: phases is required")
	}
	cfg.Allow = map[phase.Phase]map[Port]map[string]bool{}
	total := 0
	for _, ph := range []struct {
		p   phase.Phase
		set *rawPortSet
	}{{phase.Clone, raw.Phases.Clone}, {phase.Agent, raw.Phases.Agent}, {phase.Report, raw.Phases.Report}} {
		ports := map[Port]map[string]bool{}
		cfg.Allow[ph.p] = ports
		if ph.set == nil {
			continue
		}
		for _, pl := range []struct {
			port  Port
			hosts []string
		}{{PortKete, ph.set.Kete}, {PortTool, ph.set.Tool}, {PortRoot, ph.set.Root}} {
			set := map[string]bool{}
			for _, h := range pl.hosts {
				n, err := hostname.Normalize(h)
				if err != nil {
					return nil, fmt.Errorf("config: phases.%s.%s: %v", ph.p, pl.port, err)
				}
				if set[n] {
					return nil, fmt.Errorf("config: phases.%s.%s lists %q twice", ph.p, pl.port, n)
				}
				set[n] = true
				total++
			}
			ports[pl.port] = set
		}
	}
	if total == 0 {
		return nil, errors.New("config: phases allow no host at all")
	}

	// registries (D9: may only narrow the built-in rules)
	cfg.Registries = map[string]registry.Spec{}
	for i, r := range raw.Registries {
		h, err := hostname.Normalize(r.Host)
		if err != nil {
			return nil, fmt.Errorf("config: registries[%d].host: %v", i, err)
		}
		if _, dup := cfg.Registries[h]; dup {
			return nil, fmt.Errorf("config: registry %q is listed twice", h)
		}
		spec := registry.Spec{Kind: registry.Kind(r.Kind), Shapes: r.Shapes}
		if err := registry.Validate(h, spec); err != nil {
			return nil, fmt.Errorf("config: %v", err)
		}
		cfg.Registries[h] = spec
	}
	for _, h := range cfg.AllHosts() {
		if kind, ok := registry.BuiltinHosts[h]; ok {
			if _, declared := cfg.Registries[h]; !declared {
				cfg.Registries[h] = registry.Spec{Kind: kind}
			}
		}
	}

	// The tool user runs arbitrary build and test code, so it may reach package registries only
	// (hosts under registry rules), and only in the agent phase.
	for _, ph := range []phase.Phase{phase.Clone, phase.Report} {
		if len(cfg.Allow[ph][PortTool]) > 0 {
			return nil, fmt.Errorf("config: phases.%s.tool must be empty (the tool user may reach registries in the agent phase only)", ph)
		}
	}
	for h := range cfg.Allow[phase.Agent][PortTool] {
		if _, ok := cfg.Registries[h]; !ok {
			return nil, fmt.Errorf("config: phases.agent.tool lists %q, which is neither a built-in registry host nor in registries (the tool user may reach registries only)", h)
		}
	}

	// limits (may only be lowered)
	cfg.Limits = Limits{RegistryRequests: registry.DefaultCap, LogMaxBytes: DefaultLogMaxBytes}
	if raw.Limits != nil {
		if v := raw.Limits.RegistryRequests; v != nil {
			if *v < 1 || *v > registry.DefaultCap {
				return nil, fmt.Errorf("config: limits.registry_requests must be 1-%d (it may only be lowered; got %d)", registry.DefaultCap, *v)
			}
			cfg.Limits.RegistryRequests = *v
		}
		if v := raw.Limits.LogMaxBytes; v != nil {
			if *v < MinLogMaxBytes || *v > DefaultLogMaxBytes {
				return nil, fmt.Errorf("config: limits.log_max_bytes must be %d-%d (it may only be lowered; got %d)", MinLogMaxBytes, DefaultLogMaxBytes, *v)
			}
			cfg.Limits.LogMaxBytes = *v
		}
	}
	return cfg, nil
}
