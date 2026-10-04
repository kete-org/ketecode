package netrules

import (
	"flag"
	"os"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
)

var update = flag.Bool("update", false, "rewrite the golden files")

func cfgWith(t *testing.T, resolvers string) *config.Config {
	t.Helper()
	c, err := config.Parse(strings.NewReader(`{
  "version": 1,
  "uids": { "proxy": 990, "kete": 991, "tool": 992 },
  "ports": { "kete": 81, "tool": 82, "root": 83 },
  "resolvers": ` + resolvers + `,
  "phases": { "agent": { "kete": ["gateway.example"] } }
}`))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestGolden(t *testing.T) {
	cases := map[string]string{
		"v4":    `["198.51.100.53:53"]`,
		"v6":    `["[fdaa::3]:53"]`,
		"mixed": `["[fdaa::3]:53", "198.51.100.53:53", "198.51.100.54:53", "[2001:db8::53]:53"]`,
	}
	for name, res := range cases {
		got := Generate(cfgWith(t, res))
		path := "testdata/" + name + ".nft"
		if *update {
			if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v (run with -update to create)", name, err)
		}
		if got != string(want) {
			t.Errorf("%s: ruleset differs from %s:\n%s", name, path, got)
		}
	}
}

func TestShape(t *testing.T) {
	out := Generate(cfgWith(t, `["[fdaa::3]:53", "198.51.100.53:53"]`))
	lines := strings.Split(out, "\n")
	// Re-install is atomic: declare, delete, then the full table.
	if lines[1] != "table inet kete_egress" || lines[2] != "delete table inet kete_egress" {
		t.Errorf("preamble = %q", lines[:3])
	}
	must := []string{
		"type filter hook output priority -155; policy drop;",
		"meta skuid 990 jump proxy_out",
		"meta skuid 991 jump kete_out",
		"meta skuid 992 jump tool_out",
		"meta skuid 0 jump root_out",
		"ip daddr 127.0.0.1 tcp dport 81 accept",
		"ip daddr 127.0.0.1 tcp dport 82 accept",
		"ip daddr 127.0.0.1 tcp dport 83 accept",
		"type filter hook input priority filter; policy drop;",
		"type filter hook forward priority filter; policy drop;",
		"fc00::/7",
		"meta l4proto tcp reject with tcp reset",
		"reject with icmpx port-unreachable",
		"169.254.0.0/16",
	}
	for _, m := range must {
		if !strings.Contains(out, m) {
			t.Errorf("missing %q", m)
		}
	}
	// The resolver exception must come before the blocked-range drops (Fly's resolver is inside
	// fdaa::/16), and only for port 53.
	dns6 := strings.Index(out, "ip6 daddr { fdaa::3 } meta l4proto { udp, tcp } th dport 53 accept")
	dns4 := strings.Index(out, "ip daddr { 198.51.100.53 } meta l4proto { udp, tcp } th dport 53 accept")
	drop6 := strings.Index(out, "ip6 daddr @blocked_v6 jump refuse")
	drop4 := strings.Index(out, "ip daddr @blocked_v4 jump refuse")
	https := strings.Index(out, "tcp dport 443 accept")
	if dns6 < 0 || dns4 < 0 || drop6 < 0 || drop4 < 0 || https < 0 {
		t.Fatalf("proxy_out incomplete:\n%s", out)
	}
	if dns6 > drop6 || dns4 > drop4 || drop4 > https || drop6 > https {
		t.Error("proxy_out order: DNS exception, then blocked drops, then 443")
	}
	// Everything a user chain doesn't accept ends in the refuse chain (fail fast), with the
	// drop policy only as a backstop.
	if !strings.Contains(out, "meta skuid 0 jump root_out\n\t\tjump refuse\n\t}") {
		t.Error("output chain doesn't end by jumping to refuse")
	}
	// Nothing but the proxy's chain opens 443 or 53.
	if strings.Count(out, "dport 443") != 1 || strings.Count(out, "dport 53") != 2 {
		t.Error("443/53 opened more than once")
	}
}

func TestNoEmptyResolverSet(t *testing.T) {
	out := Generate(cfgWith(t, `["198.51.100.53:53"]`))
	if strings.Contains(out, "ip6 daddr {") {
		t.Error("an empty IPv6 resolver set was emitted")
	}
}
