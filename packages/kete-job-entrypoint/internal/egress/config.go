// Package egress drives kete-egress (its README is the contract): it builds configuration v1 (v2
// for kubevm: the enterprise proxy, CA bundle and internal ranges),
// applies the nftables ruleset, binds ports A/B/R and opens the request log once, and starts,
// instructs and restarts the proxy over control protocol v1 with the same listener and log fds
// (decision D2: hosts that arrive after the proxy started need a new instance; the request log's
// current size is each instance's starting offset, so its cap holds across instances).
package egress

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"strconv"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
)

// Hosts is one phase's allowlists, per port.
type Hosts struct {
	Kete []string
	Tool []string
	Root []string
}

// Instance is one proxy instance's allowlists.
type Instance struct {
	Clone, Agent, Report Hosts
}

// Base is what every instance shares.
type Base struct {
	ProxyUID, KeteUID, ToolUID   uint32
	PortKete, PortTool, PortRoot int
	Resolvers                    []string
	// V2, when set (kubevm), renders configuration v2: allowlist entries may be `host:port`.
	V2 *V2
}

// V2 is configuration v2's enterprise network (docs/platform/egress-config-v2.md).
type V2 struct {
	Proxy         string // http(s)://host:port, "" none
	ProxyAuthFile string // under /run/, "" none
	CABundleFile  string // under /run/, "" none
	Internal      []bootenv.InternalRange
}

type upstreamJSON struct {
	Proxy         string `json:"proxy"`
	ProxyAuthFile string `json:"proxy_auth_file,omitempty"`
	CABundleFile  string `json:"ca_bundle_file,omitempty"`
}

type portSet struct {
	Kete []string `json:"kete,omitempty"`
	Tool []string `json:"tool,omitempty"`
	Root []string `json:"root,omitempty"`
}

type config struct {
	Version int `json:"version"`
	UIDs    struct {
		Proxy uint32 `json:"proxy"`
		Kete  uint32 `json:"kete"`
		Tool  uint32 `json:"tool"`
	} `json:"uids"`
	Ports struct {
		Kete int `json:"kete"`
		Tool int `json:"tool"`
		Root int `json:"root"`
	} `json:"ports"`
	Resolvers []string `json:"resolvers"`
	Phases    struct {
		Clone  *portSet `json:"clone,omitempty"`
		Agent  *portSet `json:"agent,omitempty"`
		Report *portSet `json:"report,omitempty"`
	} `json:"phases"`
	Upstream *upstreamJSON           `json:"upstream,omitempty"`
	Internal []bootenv.InternalRange `json:"internal,omitempty"`
}

// validEntry is a plain DNS host, or (v2) `host:port` with a port other than 443.
func validEntry(h string, v2 bool) bool {
	if bootenv.ValidHost(h) {
		return true
	}
	i := strings.LastIndexByte(h, ':')
	if !v2 || i < 0 || !bootenv.ValidHost(h[:i]) {
		return false
	}
	p := h[i+1:]
	n, err := strconv.Atoi(p)
	return err == nil && n >= 1 && n <= 65535 && n != 443 && p[0] != '0'
}

// dedupe checks every host and drops repeats (the proxy refuses a host listed twice in a list).
func dedupe(hosts []string, v2 bool) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, h := range hosts {
		if !validEntry(h, v2) {
			return nil, fmt.Errorf("egress: %q is not a plain DNS host", h)
		}
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out, nil
}

func set(h Hosts, v2 bool) (*portSet, int, error) {
	var ps portSet
	var err error
	if ps.Kete, err = dedupe(h.Kete, v2); err != nil {
		return nil, 0, err
	}
	if ps.Tool, err = dedupe(h.Tool, v2); err != nil {
		return nil, 0, err
	}
	if ps.Root, err = dedupe(h.Root, v2); err != nil {
		return nil, 0, err
	}
	n := len(ps.Kete) + len(ps.Tool) + len(ps.Root)
	if n == 0 {
		return nil, 0, nil
	}
	return &ps, n, nil
}

// BuildConfig renders configuration v1, or v2 when b.V2 is set.
func BuildConfig(b Base, inst Instance) ([]byte, error) {
	if len(b.Resolvers) == 0 {
		return nil, errors.New("egress: no resolver")
	}
	var c config
	c.Version = 1
	v2 := b.V2 != nil
	if v2 {
		c.Version = 2
		c.Internal = b.V2.Internal
		if b.V2.Proxy != "" {
			c.Upstream = &upstreamJSON{Proxy: b.V2.Proxy, ProxyAuthFile: b.V2.ProxyAuthFile, CABundleFile: b.V2.CABundleFile}
		}
	}
	c.UIDs.Proxy, c.UIDs.Kete, c.UIDs.Tool = b.ProxyUID, b.KeteUID, b.ToolUID
	c.Ports.Kete, c.Ports.Tool, c.Ports.Root = b.PortKete, b.PortTool, b.PortRoot
	c.Resolvers = b.Resolvers
	total := 0
	var err error
	var n int
	if c.Phases.Clone, n, err = set(inst.Clone, v2); err != nil {
		return nil, err
	}
	total += n
	if c.Phases.Agent, n, err = set(inst.Agent, v2); err != nil {
		return nil, err
	}
	total += n
	if c.Phases.Report, n, err = set(inst.Report, v2); err != nil {
		return nil, err
	}
	total += n
	if total == 0 {
		return nil, errors.New("egress: no host in any list")
	}
	return json.Marshal(c)
}

// ParseResolvConf returns the nameservers of a resolv.conf as "ip:53" / "[ipv6]:53". A loopback,
// unspecified or zoned address is refused (the proxy refuses them; Docker's embedded DNS is
// loopback).
func ParseResolvConf(r io.Reader) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	sc := bufio.NewScanner(io.LimitReader(r, 64<<10))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 || f[0] != "nameserver" {
			continue
		}
		a, err := netip.ParseAddr(f[1])
		if err != nil {
			return nil, fmt.Errorf("resolv.conf: bad nameserver %q", f[1])
		}
		if a.Zone() != "" || a.IsLoopback() || a.IsUnspecified() || a.IsMulticast() {
			return nil, fmt.Errorf("resolv.conf: nameserver %s can't be used by the proxy", a)
		}
		a = a.Unmap()
		s := netip.AddrPortFrom(a, 53).String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, errors.New("resolv.conf: no nameserver")
	}
	return out, nil
}
