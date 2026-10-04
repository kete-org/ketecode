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
