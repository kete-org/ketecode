// Package egress drives kete-egress (its README is the contract): it builds configuration v1,
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
}

// dedupe checks every host and drops repeats (the proxy refuses a host listed twice in a list).
func dedupe(hosts []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, h := range hosts {
		if !bootenv.ValidHost(h) {
			return nil, fmt.Errorf("egress: %q is not a plain DNS host", h)
		}
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out, nil
}

func set(h Hosts) (*portSet, int, error) {
	var ps portSet
	var err error
	if ps.Kete, err = dedupe(h.Kete); err != nil {
		return nil, 0, err
	}
	if ps.Tool, err = dedupe(h.Tool); err != nil {
		return nil, 0, err
	}
	if ps.Root, err = dedupe(h.Root); err != nil {
		return nil, 0, err
	}
	n := len(ps.Kete) + len(ps.Tool) + len(ps.Root)
	if n == 0 {
		return nil, 0, nil
	}
	return &ps, n, nil
}

// BuildConfig renders configuration v1.
func BuildConfig(b Base, inst Instance) ([]byte, error) {
	if len(b.Resolvers) == 0 {
		return nil, errors.New("egress: no resolver")
	}
	var c config
	c.Version = 1
	c.UIDs.Proxy, c.UIDs.Kete, c.UIDs.Tool = b.ProxyUID, b.KeteUID, b.ToolUID
	c.Ports.Kete, c.Ports.Tool, c.Ports.Root = b.PortKete, b.PortTool, b.PortRoot
	c.Resolvers = b.Resolvers
	total := 0
	var err error
	var n int
	if c.Phases.Clone, n, err = set(inst.Clone); err != nil {
		return nil, err
	}
	total += n
	if c.Phases.Agent, n, err = set(inst.Agent); err != nil {
		return nil, err
	}
	total += n
	if c.Phases.Report, n, err = set(inst.Report); err != nil {
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
