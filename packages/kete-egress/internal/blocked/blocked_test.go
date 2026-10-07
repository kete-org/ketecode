package blocked

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestContains(t *testing.T) {
	blocked := []string{
		"0.0.0.0", "10.9.9.9", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254",
		"172.16.0.1", "172.31.255.255", "192.0.0.8", "192.168.1.1", "198.18.0.1", "224.0.0.1",
		"255.255.255.255",
		"::", "::1", "::10.0.0.1", "::8.8.8.8", "2002:a09:909::1", "2002:808:808::1", "::ffff:8.8.8.8", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1",
		"100::1", "fdaa::3", "fc00::1", "fe80::1", "ff02::1",
	}
	allowed := []string{
		"8.8.8.8", "1.1.1.1", "198.51.100.10", "172.32.0.1", "100.128.0.1", "2001:db8::10",
		"2606:4700::1111", "2a00:1450:4001::200e",
	}
	for _, s := range blocked {
		if !Contains(netip.MustParseAddr(s)) {
			t.Errorf("%s not blocked", s)
		}
	}
	for _, s := range allowed {
		if Contains(netip.MustParseAddr(s)) {
			t.Errorf("%s blocked", s)
		}
	}
	if !Contains(netip.Addr{}) {
		t.Error("invalid address not blocked")
	}
	if !Contains(netip.MustParseAddr("2001:db8::10%eth0")) {
		t.Error("zoned address not blocked")
	}
}

// TestForbiddenMatchesContract: Forbidden is the contract's list, in order — the code block under
// "Forbidden ranges" in docs/platform/egress-config-v2.md (the platform's copy, byte for byte).
func TestForbiddenMatchesContract(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "platform", "egress-config-v2.md"))
	if err != nil {
		t.Fatal(err)
	}
	_, rest, ok := strings.Cut(string(doc), "## Forbidden ranges")
	if !ok {
		t.Fatal("no Forbidden ranges section")
	}
	_, rest, _ = strings.Cut(rest, "```text\n")
	block, _, ok := strings.Cut(rest, "```")
	if !ok {
		t.Fatal("no code block")
	}
	want := strings.Fields(block)
	if len(want) != len(Forbidden) {
		t.Fatalf("contract lists %d ranges, Forbidden %d", len(want), len(Forbidden))
	}
	for i, p := range Forbidden {
		// Compared as prefixes: Go writes ::ffff:0:0/96 as ::ffff:0.0.0.0/96.
		if w, err := netip.ParsePrefix(want[i]); err != nil || w != p {
			t.Errorf("Forbidden[%d] = %s, contract %s", i, p, want[i])
		}
	}
}

func TestForbidden(t *testing.T) {
	for _, s := range []string{"0.1.2.3", "127.0.0.1", "169.254.169.254", "168.63.129.16", "100.100.100.200", "239.1.1.1", "255.255.255.255",
		"::", "::1", "::ffff:10.0.0.1", "::a9fe:a9fe", "64:ff9b::1", "64:ff9b:1::1", "2002::1", "fe80::1", "fd00:ec2::254", "ff02::1"} {
		if !IsForbidden(netip.MustParseAddr(s)) {
			t.Errorf("%s not forbidden", s)
		}
	}
	// Private ranges are blocked by v1's firewall but an internal range may open them.
	for _, s := range []string{"10.20.0.5", "192.168.1.1", "100.64.0.1", "168.63.129.17", "fd00:ec2::253", "fd12:3456:789a::1", "8.8.8.8"} {
		if IsForbidden(netip.MustParseAddr(s)) {
			t.Errorf("%s forbidden", s)
		}
	}
	if !ForbiddenOverlaps(netip.MustParsePrefix("168.63.0.0/16")) || ForbiddenOverlaps(netip.MustParsePrefix("10.0.0.0/8")) {
		t.Error("ForbiddenOverlaps")
	}
}
