package guestinit

import (
	"errors"
	"net/netip"
	"strings"
)

// Kernel command-line parameters kete-job-init reads (the kernel ignores dotted parameters it
// doesn't know). Only a cloudvm image's boot loader sets them; the host agent's microvm command
// line configures the network with the kernel's `ip=` and carries neither.
//
//	kete.net=dhcp        configure the uplink with kete-job-init's DHCP client (internal/dhcp)
//	kete.dns=<ip>[,<ip>] the guest's resolvers: one or two public IPv4 addresses (ADR 0023 rule 7)
const (
	cmdlineNet = "kete.net"
	cmdlineDNS = "kete.dns"
)

// NetConfig is the network configuration the command line asks for.
type NetConfig struct {
	DHCP      bool
	Resolvers []string
}

// ParseCmdline reads kete.net and kete.dns. Without kete.net the kernel configured the network
// (microvm). kete.net=dhcp needs kete.dns; any other value, a repeated parameter or a resolver
// that isn't a public IPv4 address is an error (the guest then powers off).
func ParseCmdline(s string) (NetConfig, error) {
	var nc NetConfig
	seen := map[string]bool{}
	for _, f := range strings.Fields(s) {
		k, v, ok := strings.Cut(f, "=")
		if !ok || (k != cmdlineNet && k != cmdlineDNS) {
			continue
		}
		if seen[k] {
			return NetConfig{}, errors.New("cmdline: " + k + " repeated")
		}
		seen[k] = true
		switch k {
		case cmdlineNet:
			if v != "dhcp" {
				return NetConfig{}, errors.New("cmdline: kete.net must be dhcp")
			}
			nc.DHCP = true
		case cmdlineDNS:
			parts := strings.Split(v, ",")
			if len(parts) > 2 {
				return NetConfig{}, errors.New("cmdline: at most two resolvers")
			}
			for _, p := range parts {
				a, err := netip.ParseAddr(p)
				if err != nil || !publicIPv4(a) {
					return NetConfig{}, errors.New("cmdline: kete.dns must list public IPv4 addresses")
				}
				nc.Resolvers = append(nc.Resolvers, a.String())
			}
		}
	}
	if nc.DHCP != (nc.Resolvers != nil) {
		return NetConfig{}, errors.New("cmdline: kete.net=dhcp and kete.dns go together")
	}
	return nc, nil
}

var (
	cgnat    = netip.MustParsePrefix("100.64.0.0/10")
	thisNet  = netip.MustParsePrefix("0.0.0.0/8")
	reserved = netip.MustParsePrefix("240.0.0.0/4") // with the limited broadcast
)

// publicIPv4: not "this network" (0/8), private, CGNAT, loopback, link-local, multicast or
// reserved/broadcast (240/4). The cloudvm disk build (packer/scripts/build-disk.sh) applies the
// same rule to --resolvers.
func publicIPv4(a netip.Addr) bool {
	return a.Is4() && a.IsGlobalUnicast() && !a.IsPrivate() && !cgnat.Contains(a) &&
		!thisNet.Contains(a) && !reserved.Contains(a)
}
