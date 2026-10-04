package blocked

import (
	"net/netip"
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
