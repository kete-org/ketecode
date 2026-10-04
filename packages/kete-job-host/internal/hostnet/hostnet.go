// Package hostnet is the host side of the guests' network (kete-code-platform ADR 0023 rule 7):
// the nftables table `inet kete-job-host` that confines every guest to TCP 443 and DNS to the
// configured public resolvers, masqueraded out of the uplink, and the per-VM tap devices with one
// IPv4 /30 each. The table is rendered from the configuration, applied atomically with `nft -f`,
// and checked by comparing its `nft -j` listing with the one taken right after applying it: a
// missing or changed table blocks starts (contract starts_blocked `host_table`).
package hostnet

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
)

// TableName is the agent's nftables table (family inet).
const TableName = "kete-job-host"

// TapPrefix names guest tap devices: kjh<slot>.
const TapPrefix = "kjh"

// Blocked are the destinations no guest may reach (ADR 0023 rule 7), besides the host itself
// (input chain), other guests (any other output interface) and every IPv6 packet.
var Blocked = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

// Table is the host table's inputs.
type Table struct {
	// Uplink is the only interface guest traffic may leave by.
	Uplink string
	// Pool is the guests' address pool (masquerade source).
	Pool netip.Prefix
	// Resolvers are the public DNS resolvers guests may query (UDP and TCP 53).
	Resolvers []netip.Addr
}

// Validate checks the inputs (they are interpolated into the ruleset).
func (t Table) Validate() error {
	if !ValidIfName(t.Uplink) || strings.HasPrefix(t.Uplink, TapPrefix) {
		return fmt.Errorf("hostnet: invalid uplink %q", t.Uplink)
	}
	if !t.Pool.IsValid() || !t.Pool.Addr().Is4() || t.Pool.Masked() != t.Pool {
		return errors.New("hostnet: invalid guest pool")
	}
	if len(t.Resolvers) == 0 {
		return errors.New("hostnet: at least one resolver is required")
	}
	for _, r := range t.Resolvers {
		if !r.Is4() {
			return errors.New("hostnet: resolvers must be IPv4")
		}
		for _, b := range Blocked {
			if b.Contains(r) {
				return fmt.Errorf("hostnet: resolver %s is in a blocked range", r)
			}
		}
	}
	return nil
}

// ValidIfName reports a safe Linux interface name.
func ValidIfName(s string) bool {
	if s == "" || len(s) > 15 {
		return false
	}
	for i, c := range s {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || (i > 0 && (c == '-' || c == '_' || c == '.'))
		if !ok {
			return false
		}
	}
	return true
}

// Render returns the ruleset: one nft transaction that creates the table (if absent), deletes it,
// and creates it afresh, so applying it is atomic and idempotent.
func (t Table) Render() (string, error) {
	if err := t.Validate(); err != nil {
		return "", err
	}
	blocked := make([]string, len(Blocked))
	for i, p := range Blocked {
		blocked[i] = p.String()
	}
	res := make([]string, len(t.Resolvers))
	for i, r := range t.Resolvers {
		res[i] = r.String()
	}
	sort.Strings(res)
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	w("table inet %s", TableName)
	w("delete table inet %s", TableName)
	w("table inet %s {", TableName)
	w("\tset blocked4 {")
	w("\t\ttype ipv4_addr")
	w("\t\tflags interval")
	w("\t\telements = { %s }", strings.Join(blocked, ", "))
	w("\t}")
	w("\tset resolvers4 {")
	w("\t\ttype ipv4_addr")
	w("\t\telements = { %s }", strings.Join(res, ", "))
	w("\t}")
	w("\t# Guest -> the host itself (the agent included): every protocol, every address.")
	w("\tchain input {")
	w("\t\ttype filter hook input priority filter - 10; policy accept;")
	w("\t\tiifname \"%s*\" drop", TapPrefix)
	w("\t}")
	w("\tchain forward {")
	w("\t\ttype filter hook forward priority filter - 10; policy accept;")
	w("\t\tiifname \"%s*\" jump guest_out", TapPrefix)
	w("\t\toifname \"%s*\" jump guest_in", TapPrefix)
	w("\t}")
	w("\t# Guest -> elsewhere: IPv4 from the guest's own address, out of the uplink only (no other")
	w("\t# guest, no other host interface), no private or special range, then only DNS to the")
	w("\t# resolvers and TCP 443.")
	w("\tchain guest_out {")
	w("\t\tmeta nfproto != ipv4 drop")
	w("\t\t# No spoofing: the source must route back through the tap it came in on (its /30).")
	w("\t\tfib saddr . iif oif missing drop")
	w("\t\tip saddr != %s drop", t.Pool)
	w("\t\toifname != \"%s\" drop", t.Uplink)
	w("\t\tip daddr @blocked4 drop")
	w("\t\tip daddr @resolvers4 udp dport 53 accept")
	w("\t\tip daddr @resolvers4 tcp dport 53 accept")
	w("\t\ttcp dport 443 accept")
	w("\t\tdrop")
	w("\t}")
	w("\t# Elsewhere -> guest: only replies from the uplink.")
	w("\tchain guest_in {")
	w("\t\tmeta nfproto != ipv4 drop")
	w("\t\tiifname != \"%s\" drop", t.Uplink)
	w("\t\tct state established,related accept")
	w("\t\tdrop")
	w("\t}")
	w("\tchain postrouting {")
	w("\t\ttype nat hook postrouting priority srcnat; policy accept;")
	w("\t\toifname \"%s\" ip saddr %s masquerade", t.Uplink, t.Pool)
	w("\t}")
	w("}")
	return b.String(), nil
}

// Nft runs the nft binary.
type Nft struct {
	// Bin is the nft binary (default /usr/sbin/nft).
	Bin string
}

func (n Nft) bin() string {
	if n.Bin == "" {
		return "/usr/sbin/nft"
	}
	return n.Bin
}

func (n Nft) run(ctx context.Context, stdin string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, n.bin(), args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 512 {
			msg = msg[:512]
		}
		return nil, fmt.Errorf("nft %s: %v: %s", strings.Join(args, " "), err, msg)
	}
	return out, nil
}

// CheckSyntax parses a ruleset without applying it (`nft -c -f -`).
func (n Nft) CheckSyntax(ctx context.Context, ruleset string) error {
	_, err := n.run(ctx, ruleset, "-c", "-f", "-")
	return err
}

// Apply applies the table and returns its canonical listing for later checks.
func (n Nft) Apply(ctx context.Context, t Table) (string, error) {
	rs, err := t.Render()
	if err != nil {
		return "", err
	}
	if _, err := n.run(ctx, rs, "-f", "-"); err != nil {
		return "", err
	}
	return n.Listing(ctx)
}

// ErrMissing means the table doesn't exist.
var ErrMissing = errors.New("hostnet: the kete-job-host table is missing")

// ErrChanged means the table differs from what the agent applied.
var ErrChanged = errors.New("hostnet: the kete-job-host table was changed")

// Listing returns the table's canonical JSON listing (rule handles and metainfo removed).
func (n Nft) Listing(ctx context.Context) (string, error) {
	out, err := n.run(ctx, "", "-j", "list", "table", "inet", TableName)
	if err != nil {
		if strings.Contains(err.Error(), "No such file or directory") {
			return "", ErrMissing
		}
		return "", err
	}
	return Canonical(out)
}

// Check compares the live table with want (a Listing taken after Apply).
func (n Nft) Check(ctx context.Context, want string) error {
	got, err := n.Listing(ctx)
	if err != nil {
		return err
	}
	if got != want {
		return ErrChanged
	}
	return nil
}

// Delete removes the table (tests and uninstall).
func (n Nft) Delete(ctx context.Context) error {
	_, err := n.run(ctx, "", "delete", "table", "inet", TableName)
	return err
}

// Canonical strips what changes between listings of an unchanged table (handles, metainfo).
func Canonical(raw []byte) (string, error) {
	var doc struct {
		Nftables []map[string]json.RawMessage `json:"nftables"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", fmt.Errorf("hostnet: nft -j: %w", err)
	}
	var objs []string
	for _, o := range doc.Nftables {
		if _, ok := o["metainfo"]; ok {
			continue
		}
		var v any
		b, _ := json.Marshal(o)
		if err := json.Unmarshal(b, &v); err != nil {
			return "", err
		}
		strip(v)
		c, err := json.Marshal(v)
		if err != nil {
			return "", err
		}
		objs = append(objs, string(c))
	}
	if len(objs) == 0 {
		return "", ErrMissing
	}
	return strings.Join(objs, "\n"), nil
}

func strip(v any) {
	switch x := v.(type) {
	case map[string]any:
		delete(x, "handle")
		for _, c := range x {
			strip(c)
		}
	case []any:
		for _, c := range x {
			strip(c)
		}
	}
}

// DefaultUplink returns the interface of the IPv4 default route with the lowest metric.
func DefaultUplink() (string, error) {
	f, err := os.Open("/proc/net/route")
	if err != nil {
		return "", err
	}
	defer f.Close()
	return parseRoutes(f)
}

func parseRoutes(r interface{ Read([]byte) (int, error) }) (string, error) {
	sc := bufio.NewScanner(r)
	best, bestMetric := "", -1
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		f := strings.Fields(sc.Text())
		if len(f) < 8 || f[1] != "00000000" || f[7] != "00000000" {
			continue
		}
		m, err := strconv.Atoi(f[6])
		if err != nil {
			continue
		}
		if bestMetric < 0 || m < bestMetric {
			best, bestMetric = f[0], m
		}
	}
	if best == "" {
		return "", errors.New("hostnet: no IPv4 default route")
	}
	if !ValidIfName(best) {
		return "", fmt.Errorf("hostnet: default route interface %q has an unexpected name", best)
	}
	return best, nil
}

// Forwarding reports whether IPv4 forwarding is on.
func Forwarding() (bool, error) {
	b, err := os.ReadFile("/proc/sys/net/ipv4/ip_forward")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(string(b)) == "1", nil
}

// Slot is one guest's network: tap kjh<n>, gateway (host side) and guest addresses of its /30.
type Slot struct {
	Tap     string
	Gateway netip.Addr
	Guest   netip.Addr
}

// SlotNet returns slot n's /30 in pool.
func SlotNet(pool netip.Prefix, n int) (Slot, error) {
	if n < 0 || n >= 1<<(32-pool.Bits())/4 {
		return Slot{}, errors.New("hostnet: slot outside the guest pool")
	}
	base := pool.Addr().As4()
	v := uint32(base[0])<<24 | uint32(base[1])<<16 | uint32(base[2])<<8 | uint32(base[3])
	v += uint32(n) * 4
	ip := func(x uint32) netip.Addr {
		return netip.AddrFrom4([4]byte{byte(x >> 24), byte(x >> 16), byte(x >> 8), byte(x)})
	}
	return Slot{Tap: TapPrefix + strconv.Itoa(n), Gateway: ip(v + 1), Guest: ip(v + 2)}, nil
}

// MAC is the guest's locally administered MAC for slot s (06:00 + its IPv4 address).
func (s Slot) MAC() string {
	a := s.Guest.As4()
	return fmt.Sprintf("06:00:%02x:%02x:%02x:%02x", a[0], a[1], a[2], a[3])
}

// KernelIP is the guest kernel's `ip=` argument: static address, gateway, /30 mask, eth0, no
// autoconfiguration, and the resolvers as dns0/dns1 (kete-job-init writes resolv.conf from them).
func (s Slot) KernelIP(resolvers []netip.Addr) string {
	dns := []string{"", ""}
	for i, r := range resolvers {
		if i < 2 {
			dns[i] = r.String()
		}
	}
	return fmt.Sprintf("ip=%s::%s:255.255.255.252::eth0:off:%s:%s", s.Guest, s.Gateway, dns[0], dns[1])
}
