package netrules

import (
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
)

const v2Doc = `{
  "version": 2,
  "uids": { "proxy": 990, "kete": 991, "tool": 992 },
  "ports": { "kete": 81, "tool": 82, "root": 83 },
  "resolvers": ["10.96.0.10:53"],
  "phases": {
    "clone": { "root": ["gitlab.corp.example:8443", "portal.kete.example"] },
    "agent": { "kete": ["portal.kete.example"] }
  },
  "upstream": { "proxy": "http://10.20.0.5:3128" },
  "internal": [
    { "cidr": "10.20.0.0/16", "ports": [443, 3128, 8443] },
    { "cidr": "fd12:3456:789a::/48", "ports": [443] }
  ]
}`

func TestGenerateV2(t *testing.T) {
	c, err := config.Load(strings.NewReader(v2Doc))
	if err != nil {
		t.Fatal(err)
	}
	got := Generate(c)
	proxyOut := got[strings.Index(got, "chain proxy_out {"):]
	proxyOut = proxyOut[:strings.Index(proxyOut, "\n\t}")]
	want := []string{
		"ip daddr @forbidden_v4 jump refuse",
		"ip6 daddr @forbidden_v6 jump refuse",
		"ip daddr 10.20.0.0/16 tcp dport { 443, 3128, 8443 } accept",
		"ip6 daddr fd12:3456:789a::/48 tcp dport { 443 } accept",
		"ip daddr 10.20.0.5 tcp dport 3128 accept",
		"ip daddr @blocked_v4 jump refuse",
		"tcp dport 443 accept",
	}
	last := -1
	for _, w := range want {
		i := strings.Index(proxyOut, w)
		if i < 0 || i < last {
			t.Fatalf("proxy_out lacks %q in order:\n%s", w, proxyOut)
		}
		last = i
	}
	if !strings.Contains(got, "config v2") || !strings.Contains(got, "set forbidden_v4") || strings.Contains(got, "::1/128") {
		t.Errorf("v2 header, forbidden sets or overlap handling wrong:\n%s", got)
	}
	// The other users' chains are v1's: an internal range is for the proxy user only.
	for _, ch := range []string{"chain kete_out {", "chain tool_out {", "chain root_out {"} {
		body := got[strings.Index(got, ch):]
		body = body[:strings.Index(body, "\n\t}")]
		if strings.Contains(body, "10.20.0.0") || strings.Contains(body, "3128") {
			t.Errorf("%s names an internal destination:\n%s", ch, body)
		}
	}
}

func TestGenerateV1Unchanged(t *testing.T) {
	got := Generate(cfgWith(t, `["198.51.100.53:53"]`))
	if strings.Contains(got, "forbidden") || !strings.Contains(got, "config v1") {
		t.Errorf("v1 output changed:\n%s", got)
	}
}
