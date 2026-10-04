package hostnet

import (
	"context"
	"errors"
	"flag"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite golden files")

var samples = map[string]Table{
	"two-resolvers": {Uplink: "eth0", Pool: netip.MustParsePrefix("10.200.0.0/16"), Resolvers: []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("1.1.1.1")}},
	"one-resolver":  {Uplink: "enp1s0", Pool: netip.MustParsePrefix("172.20.0.0/24"), Resolvers: []netip.Addr{netip.MustParseAddr("9.9.9.9")}},
}

func TestRenderGolden(t *testing.T) {
	for name, tb := range samples {
		t.Run(name, func(t *testing.T) {
			got, err := tb.Render()
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join("testdata", name+".nft")
			if *update {
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if got != string(want) {
				t.Fatalf("ruleset differs from %s (go test -update):\n%s", path, got)
			}
		})
	}
}

func TestRenderRefusals(t *testing.T) {
	ok := samples["two-resolvers"]
	for name, mut := range map[string]func(*Table){
		"tap uplink":       func(t *Table) { t.Uplink = "kjh0" },
		"quoted uplink":    func(t *Table) { t.Uplink = `eth0"; accept` },
		"no resolver":      func(t *Table) { t.Resolvers = nil },
		"private resolver": func(t *Table) { t.Resolvers = []netip.Addr{netip.MustParseAddr("10.0.0.53")} },
		"v6 resolver":      func(t *Table) { t.Resolvers = []netip.Addr{netip.MustParseAddr("2606:4700::1111")} },
		"metadata":         func(t *Table) { t.Resolvers = []netip.Addr{netip.MustParseAddr("169.254.169.254")} },
		"unmasked pool":    func(t *Table) { t.Pool = netip.MustParsePrefix("10.200.0.1/16") },
	} {
		t.Run(name, func(t *testing.T) {
			tb := ok
			mut(&tb)
			if _, err := tb.Render(); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

// nftUsable reports whether nft can talk to the kernel here (root with CAP_NET_ADMIN: CI runs
// the tests with sudo; locally a --privileged container, whose own network namespace keeps the
// table away from the host's).
func nftUsable(t *testing.T) Nft {
	t.Helper()
	bin, err := exec.LookPath("nft")
	if err != nil {
		t.Skip("nft not installed")
	}
	n := Nft{Bin: bin}
	if _, err := n.run(context.Background(), "", "list", "tables"); err != nil {
		t.Skipf("nft can't reach the kernel here: %v", err)
	}
	return n
}

func TestRenderParses(t *testing.T) {
	n := nftUsable(t)
	for name, tb := range samples {
		rs, _ := tb.Render()
		if err := n.CheckSyntax(context.Background(), rs); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestApplyAndCheck(t *testing.T) {
	n := nftUsable(t)
	ctx := context.Background()
	tb := samples["two-resolvers"]
	t.Cleanup(func() { _ = n.Delete(ctx) })
	listing, err := n.Apply(ctx, tb)
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Check(ctx, listing); err != nil {
		t.Fatalf("fresh table: %v", err)
	}
	again, err := n.Apply(ctx, tb) // idempotent
	if err != nil || again != listing {
		t.Fatalf("re-apply: %v (listing changed: %v)", err, again != listing)
	}
	if _, err := n.run(ctx, "", "add", "rule", "inet", TableName, "guest_out", "accept"); err != nil {
		t.Fatal(err)
	}
	if err := n.Check(ctx, listing); !errors.Is(err, ErrChanged) {
		t.Fatalf("changed table: %v", err)
	}
	if err := n.Delete(ctx); err != nil {
		t.Fatal(err)
	}
	if err := n.Check(ctx, listing); !errors.Is(err, ErrMissing) {
		t.Fatalf("missing table: %v", err)
	}
}

func TestCanonicalStripsHandles(t *testing.T) {
	a := `{"nftables":[{"metainfo":{"version":"1.0.6"}},{"table":{"family":"inet","name":"kete-job-host","handle":7}},{"rule":{"chain":"input","handle":3,"expr":[{"drop":null}]}}]}`
	b := strings.NewReplacer(`"handle":7`, `"handle":9`, `"handle":3`, `"handle":4`, `1.0.6`, `1.0.9`).Replace(a)
	ca, err := Canonical([]byte(a))
	if err != nil {
		t.Fatal(err)
	}
	cb, _ := Canonical([]byte(b))
	if ca != cb || strings.Contains(ca, "handle") {
		t.Fatalf("%s\n%s", ca, cb)
	}
	if _, err := Canonical([]byte(`{"nftables":[{"metainfo":{}}]}`)); !errors.Is(err, ErrMissing) {
		t.Fatal("empty listing must be missing")
	}
}

func TestSlotNet(t *testing.T) {
	pool := netip.MustParsePrefix("10.200.0.0/16")
	s, err := SlotNet(pool, 3)
	if err != nil {
		t.Fatal(err)
	}
	if s.Tap != "kjh3" || s.Gateway.String() != "10.200.0.13" || s.Guest.String() != "10.200.0.14" || s.MAC() != "06:00:0a:c8:00:0e" {
		t.Fatalf("%+v %s", s, s.MAC())
	}
	if got := s.KernelIP([]netip.Addr{netip.MustParseAddr("1.1.1.1")}); got != "ip=10.200.0.14::10.200.0.13:255.255.255.252::eth0:off:1.1.1.1:" {
		t.Fatal(got)
	}
	if _, err := SlotNet(netip.MustParsePrefix("10.0.0.0/29"), 2); err == nil {
		t.Fatal("slot outside the pool")
	}
}

func TestParseRoutes(t *testing.T) {
	routes := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"wlan0\t00000000\t0105A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n" +
		"eth0\t00000000\t0105A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n" +
		"eth0\t0005A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n"
	got, err := parseRoutes(strings.NewReader(routes))
	if err != nil || got != "eth0" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := parseRoutes(strings.NewReader("Iface\n")); err == nil {
		t.Fatal("no default route")
	}
}
