package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
)

// The egress-config-v2 vector, copied byte for byte from kete-code-platform
// docs/contracts/test-vectors/egress-config-v2/ (regenerate SHA256SUMS with
// `shasum -a 256 configs.json`).
var v2VectorDir = filepath.Join("testdata", "egress-config-v2")

type v2Vector struct {
	Base  map[string]json.RawMessage `json:"base"`
	Cases []struct {
		Name  string                     `json:"name"`
		Valid bool                       `json:"valid"`
		Field string                     `json:"field"`
		Set   map[string]json.RawMessage `json:"set"`
	} `json:"cases"`
}

func readV2Vector(t *testing.T) (v2Vector, []byte) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(v2VectorDir, "configs.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v v2Vector
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v, data
}

func TestV2VectorChecksum(t *testing.T) {
	_, data := readV2Vector(t)
	sums, err := os.ReadFile(filepath.Join(v2VectorDir, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if want := hex.EncodeToString(sum[:]) + "  configs.json\n"; string(sums) != want {
		t.Errorf("SHA256SUMS = %q, want %q (the vector drifted from the platform's copy)", sums, want)
	}
	if dir := os.Getenv("KETE_PLATFORM_EGRESS_VECTORS"); dir != "" {
		theirs, err := os.ReadFile(filepath.Join(dir, "configs.json"))
		if err != nil || !bytes.Equal(theirs, data) {
			t.Errorf("configs.json differs from the platform's copy (%v)", err)
		}
	}
}

// TestV2Vector: each case starts from `base`, replaces the top-level keys in `set` (null removes
// the key), and must be accepted or refused, at `field` (our path equals it or is under it).
func TestV2Vector(t *testing.T) {
	v, _ := readV2Vector(t)
	if len(v.Cases) != 50 {
		t.Fatalf("%d cases, the contract has 50", len(v.Cases))
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			doc := map[string]json.RawMessage{}
			for k, val := range v.Base {
				doc[k] = val
			}
			for k, val := range c.Set {
				if string(val) == "null" {
					delete(doc, k)
				} else {
					doc[k] = val
				}
			}
			b, _ := json.Marshal(doc)
			cfg, err := ParseV2(bytes.NewReader(b))
			if c.Valid {
				if err != nil {
					t.Fatalf("refused: %v", err)
				}
				if cfg == nil {
					t.Fatal("nil config")
				}
				return
			}
			var fe *FieldError
			if !errors.As(err, &fe) {
				t.Fatalf("got %v, want a refusal at %s", err, c.Field)
			}
			if fe.Field != c.Field && !strings.HasPrefix(fe.Field, c.Field+".") {
				t.Fatalf("refused at %s (%v), want %s", fe.Field, err, c.Field)
			}
			t.Log(err)
		})
	}
}

func baseV2(t *testing.T) []byte {
	t.Helper()
	v, _ := readV2Vector(t)
	b, _ := json.Marshal(v.Base)
	return b
}

// TestV2Base: the base document's values as the proxy and firewall will use them.
func TestV2Base(t *testing.T) {
	cfg, err := ParseV2(bytes.NewReader(baseV2(t)))
	if err != nil {
		t.Fatal(err)
	}
	up := cfg.Upstream
	if up == nil || up.Scheme != "http" || up.Host != "10.20.0.5" || up.Addr != netip.MustParseAddr("10.20.0.5") || up.Port != 3128 ||
		up.ProxyAuthFile != "/run/kete-egress/proxy-auth" || up.CABundleFile != "/run/kete-egress/upstream-ca.pem" || len(up.Direct) != 3 ||
		!up.Direct[Target{Host: "gitlab.corp.example", Port: 8443}] || !up.Direct[Target{Host: "llm.corp.example", Port: 443}] {
		t.Errorf("upstream %+v", up)
	}
	if len(cfg.Internal) != 2 || cfg.Internal[0].Prefix != netip.MustParsePrefix("10.20.0.0/16") || len(cfg.Internal[0].Ports) != 4 ||
		cfg.Internal[1].Prefix != netip.MustParsePrefix("fd12:3456:789a::/48") {
		t.Errorf("internal %+v", cfg.Internal)
	}
	if !cfg.Allow[phase.Clone][PortRoot][Target{Host: "gitlab.corp.example", Port: 8443}] || !cfg.Allow[phase.Agent][PortTool][Target{Host: "npm.corp.example", Port: 8081}] {
		t.Errorf("allow %+v", cfg.Allow)
	}
	if spec, ok := cfg.Registries[Target{Host: "npm.corp.example", Port: 8081}]; !ok || spec.Kind != "npm" {
		t.Errorf("registries %+v", cfg.Registries)
	}
	if got := cfg.AllTargets(); len(got) != 4 || got[0].String() != "gitlab.corp.example:8443" {
		t.Errorf("all targets %v", got)
	}
	if cfg.UIDs != (UIDs{Proxy: 990, Kete: 991, Tool: 992}) || cfg.Limits.LogMaxBytes != DefaultLogMaxBytes {
		t.Errorf("uids %+v limits %+v", cfg.UIDs, cfg.Limits)
	}
}

// TestV2Refusals: rules beyond the vector — nulls, more file-path shapes, v1's rules kept, and
// the two parsers reading only their own version.
func TestV2Refusals(t *testing.T) {
	base := string(baseV2(t))
	set := func(key, value string) string {
		var m map[string]json.RawMessage
		_ = json.Unmarshal([]byte(base), &m)
		m[key] = json.RawMessage(value)
		b, _ := json.Marshal(m)
		return string(b)
	}
	for name, doc := range map[string]string{
		"upstream null":             set("upstream", `null`),
		"proxy_auth_file null":      set("upstream", `{"proxy":"http://10.20.0.5:3128","proxy_auth_file":null}`),
		"auth file in /run itself":  set("upstream", `{"proxy":"http://10.20.0.5:3128","proxy_auth_file":"/run"}`),
		"auth file trailing slash":  set("upstream", `{"proxy":"http://10.20.0.5:3128","proxy_auth_file":"/run/kete/"}`),
		"auth file dot segment":     set("upstream", `{"proxy":"http://10.20.0.5:3128","proxy_auth_file":"/run/./x"}`),
		"auth file hidden":          set("upstream", `{"proxy":"http://10.20.0.5:3128","proxy_auth_file":"/run/.x"}`),
		"proxy with a query":        set("upstream", `{"proxy":"http://10.20.0.5:3128?x=1"}`),
		"proxy upper-case host":     set("upstream", `{"proxy":"http://Proxy.corp.example:3128"}`),
		"proxy IPv6 literal":        set("upstream", `{"proxy":"http://[fd12::5]:443"}`),
		"proxy leading-zero IPv4":   set("upstream", `{"proxy":"http://010.20.0.5:3128"}`),
		"proxy port leading zero":   set("upstream", `{"proxy":"http://10.20.0.5:03128"}`),
		"proxy 198.18 (v1 blocked)": set("upstream", `{"proxy":"http://198.18.0.5:443"}`),
		"direct as host:443":        set("upstream", `{"proxy":"http://10.20.0.5:3128","direct":["llm.corp.example:443"]}`),
		"no proxy":                  set("upstream", `{"direct":["llm.corp.example"]}`),
		"internal with a zone":      set("internal", `[{"cidr":"fe80::%eth0/64","ports":[443]}]`),
		"internal dotted v6":        set("internal", `[{"cidr":"10.20.0.0/16","ports":[443,3128,8081,8443]},{"cidr":"::ffff:10.0.0.0/104","ports":[443]}]`),
		"internal port 0":           set("internal", `[{"cidr":"10.20.0.0/16","ports":[0,443,3128,8081,8443]}]`),
		"internal 17 ports":         set("internal", `[{"cidr":"10.20.0.0/16","ports":[443,3128,8081,8443,1,2,3,4,5,6,7,8,9,10,11,12,13]}]`),
		"internal unknown field":    set("internal", `[{"cidr":"10.20.0.0/16","ports":[443,3128,8081,8443],"note":"x"}]`),
		"upper-case allowlist host": set("phases", `{"agent":{"kete":["LLM.corp.example"]}}`),
		"allowlist IP":              set("phases", `{"agent":{"kete":["10.20.0.9"]}}`),
		"duplicate uids (v1 rule)":  set("uids", `{"proxy":990,"kete":990,"tool":992}`),
		"resolver on 5353":          set("resolvers", `["10.96.0.10:5353"]`),
		"resolver upper-case v6":    set("resolvers", `["[FD12::1]:53"]`),
		"unknown top-level field":   set("proxy_password", `"x"`),
		"trailing data":             base + "{}",
	} {
		if _, err := ParseV2(strings.NewReader(doc)); err == nil {
			t.Errorf("%s accepted", name)
		} else if !errors.As(err, new(*FieldError)) {
			t.Errorf("%s: not a FieldError: %v", name, err)
		}
	}
	// v1's parser still refuses a v2 document, and the v2 parser a v1 one.
	if _, err := Parse(strings.NewReader(base)); err == nil {
		t.Error("v1 Parse accepted a v2 document")
	}
	if _, err := ParseV2(strings.NewReader(valid)); err == nil {
		t.Error("ParseV2 accepted a v1 document")
	}
}

func TestParseInternalCIDR(t *testing.T) {
	for _, ok := range []string{"10.0.0.0/8", "10.20.0.0/16", "192.168.4.0/24", "fd12:3456:789a::/48", "fd12::/32", "2001:db8::/32", "10.20.0.5/32"} {
		if _, err := ParseInternalCIDR(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"10.0.0.0/7", "10.20.0.1/16", "fd12:0:0::/48", "FD12::/32", "fd12::/31", "127.0.0.0/8", "169.254.0.0/16",
		"168.63.129.0/24", "100.100.100.0/24", "224.0.0.0/8", "240.0.0.0/8", "64:ff9b::/96", "2002::/16", "fe80::/10", "ff00::/8",
		"fd00:ec2::/32", "::ffff:a00:0/104", "::a00:0/104", "10.20.0.0/016", "10.20.0.0", "10.20.0.0/33"} {
		if _, err := ParseInternalCIDR(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
	for in, want := range map[string]string{"::": "::", "fd12:3456:789a::": "fd12:3456:789a::", "1:0:0:2:0:0:0:3": "1:0:0:2::3", "1:0:2:0:3:0:4:0": "1:0:2:0:3:0:4:0", "::ffff:10.0.0.0": "::ffff:a00:0"} {
		if got := formatAddr(netip.MustParseAddr(in)); got != want {
			t.Errorf("formatAddr(%s) = %s, want %s", in, got, want)
		}
	}
}

func TestParseTarget(t *testing.T) {
	for in, want := range map[string]Target{"llm.corp.example": {"llm.corp.example", 443}, "gitlab.corp.example:8443": {"gitlab.corp.example", 8443}, "a.b:1": {"a.b", 1}, "a.b:65535": {"a.b", 65535}} {
		if got, err := ParseTarget(in); err != nil || got != want || got.String() != in {
			t.Errorf("ParseTarget(%s) = %+v, %v", in, got, err)
		}
	}
	for _, bad := range []string{"a.b:443", "a.b:0", "a.b:65536", "a.b:080", "localhost", "10.0.0.1", "a.b.", "A.b", "a.b:", "[::1]:443", "a_b.c"} {
		if _, err := ParseTarget(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}
