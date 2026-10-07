// Package blocked is the single list of destination ranges the proxy must never reach: private,
// loopback, link-local (the metadata service), CGNAT, multicast, Fly's private network (inside
// fc00::/7) and the NAT64, 6to4, IPv4-mapped and IPv4-compatible forms that could smuggle one of
// those.
//
// Open question for piece C: 64:ff9b::/96 (well-known NAT64) is blocked today. If Fly Machines
// reach IPv4-only hosts through NAT64, that blocks every such host; decide once Fly's networking
// is verified, and never silently. The nftables
// generator (internal/netrules) and the upstream dialer (internal/proxy) both read this list, so
// the firewall and the Go-level check can't drift apart.
//
// The documentation ranges 198.51.100.0/24 and 2001:db8::/32 are deliberately not listed: they
// aren't routable on the internet, and the integration suite uses them as its "internet".
package blocked

import "net/netip"

// V4 and V6 are the blocked prefixes, in the order the nftables sets list them.
var (
	V4 = mustPrefixes(
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.0.0.0/24",
		"192.168.0.0/16",
		"198.18.0.0/15",
		"224.0.0.0/3",
	)
	V6 = mustPrefixes(
		"::/96", // unspecified, loopback and the deprecated IPv4-compatible form (::a.b.c.d)
		"::ffff:0:0/96",
		"64:ff9b::/96",
		"64:ff9b:1::/48",
		"100::/64",
		"2002::/16", // 6to4: embeds an arbitrary IPv4 address
		"fc00::/7",
		"fe80::/10",
		"ff00::/8",
	)
)

func mustPrefixes(ss ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(ss))
	for i, s := range ss {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}

// Contains reports whether addr falls in a blocked range. An IPv4-mapped IPv6 address is blocked
// outright (::ffff:0:0/96), and a zoned address is always blocked.
func Contains(addr netip.Addr) bool {
	if !addr.IsValid() || addr.Zone() != "" {
		return true
	}
	list := V6
	if addr.Is4() {
		list = V4
	}
	for _, p := range list {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// Forbidden is egress configuration v2's forbidden ranges (`docs/platform/egress-config-v2.md`
// "Forbidden ranges", the platform's EGRESS_FORBIDDEN_RANGES, in the same order): no internal range
// may touch them, and the upstream proxy's address may not be in one, whether a literal (refused
// at start-up) or resolved. They reach the node or the cloud control plane, or embed an arbitrary
// IPv4 address: unspecified and "this network", loopback, link-local and cloud metadata, Azure
// WireServer, Alibaba metadata, multicast, reserved and broadcast, IPv4-compatible IPv6,
// IPv4-mapped, NAT64 (RFC 6052 and RFC 8215), 6to4, IPv6 link-local, AWS IPv6 metadata, IPv6
// multicast. An `internal` range never re-opens them.
var Forbidden = mustPrefixes(
	"0.0.0.0/8",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"168.63.129.16/32",
	"100.100.100.200/32",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"::/96",
	"::1/128",
	"::ffff:0:0/96",
	"64:ff9b::/96",
	"64:ff9b:1::/48",
	"2002::/16",
	"fe80::/10",
	"fd00:ec2::254/128",
	"ff00::/8",
)

// ForbiddenOverlaps reports whether p touches a forbidden range (same address family).
func ForbiddenOverlaps(p netip.Prefix) bool {
	for _, f := range Forbidden {
		if f.Overlaps(p) {
			return true
		}
	}
	return false
}

// IsForbidden reports whether addr is in a forbidden range. An invalid or zoned address is
// forbidden.
func IsForbidden(addr netip.Addr) bool {
	if !addr.IsValid() || addr.Zone() != "" {
		return true
	}
	return ForbiddenOverlaps(netip.PrefixFrom(addr, addr.BitLen()))
}
