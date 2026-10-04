package config

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/registry"
)

const valid = `{
  "version": 1,
  "uids": { "proxy": 990, "kete": 991, "tool": 992 },
  "ports": { "kete": 81, "tool": 82, "root": 83 },
  "resolvers": ["[fdaa::3]:53", "198.51.100.53:53"],
  "phases": {
    "clone":  { "kete": [], "tool": [], "root": ["github.com", "api.github.com", "Platform.example"] },
    "agent":  { "kete": ["gateway.example", "platform.example"], "tool": ["registry.npmjs.org", "pypi.org"], "root": ["platform.example"] },
    "report": { "root": ["platform.example", "storage.example"] }
  },
  "registries": [ { "host": "registry.npmjs.org", "kind": "npm", "shapes": ["package", "tarball"] } ],
  "limits": { "registry_requests": 100, "log_max_bytes": 5000000 }
}`

func parse(s string) (*Config, error) { return Parse(strings.NewReader(s)) }

func TestValid(t *testing.T) {
	c, err := parse(valid)
	if err != nil {
		t.Fatal(err)
	}
	if c.UIDs != (UIDs{Proxy: 990, Kete: 991, Tool: 992}) {
		t.Errorf("uids = %+v", c.UIDs)
	}
	if c.Ports[PortKete] != 81 || c.Ports[PortTool] != 82 || c.Ports[PortRoot] != 83 {
		t.Errorf("ports = %v", c.Ports)
	}
	if len(c.Resolvers) != 2 || c.Resolvers[0].String() != "[fdaa::3]:53" {
		t.Errorf("resolvers = %v", c.Resolvers)
	}
	if !c.Allow[phase.Clone][PortRoot]["platform.example"] {
		t.Error("clone/root platform.example (normalised) not allowed")
	}
	if c.Allow[phase.Clone][PortKete]["github.com"] {
		t.Error("clone/kete github.com allowed")
	}
	if len(c.Allow[phase.Report][PortKete]) != 0 {
		t.Error("report/kete (omitted) not empty")
	}
	if got := c.Registries["registry.npmjs.org"]; got.Kind != registry.NPM || len(got.Shapes) != 2 {
		t.Errorf("npm registry = %+v", got)
	}
	// pypi.org is allowlisted but not declared: the built-in rules apply to it anyway.
	if got, ok := c.Registries["pypi.org"]; !ok || got.Kind != registry.PyPI || got.Shapes != nil {
		t.Errorf("pypi.org registry = %+v, %v", got, ok)
	}
	if c.Limits.RegistryRequests != 100 || c.Limits.LogMaxBytes != 5000000 {
		t.Errorf("limits = %+v", c.Limits)
	}
	want := []string{"api.github.com", "gateway.example", "github.com", "platform.example", "pypi.org", "registry.npmjs.org", "storage.example"}
	if got := c.AllHosts(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("AllHosts = %v", got)
	}
}

func TestDefaults(t *testing.T) {
	c, err := parse(mutate(t, func(m map[string]any) { delete(m, "limits"); delete(m, "registries") }))
	if err != nil {
		t.Fatal(err)
	}
	if c.Limits.RegistryRequests != 20000 || c.Limits.LogMaxBytes != 10_000_000 {
		t.Errorf("default limits = %+v", c.Limits)
	}
	if got := c.Registries["registry.npmjs.org"]; got.Kind != registry.NPM || got.Shapes != nil {
		t.Errorf("built-in npm registry = %+v", got)
	}
}

// mutate applies f to the valid config's JSON object and re-encodes it.
func mutate(t *testing.T, f func(map[string]any)) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(valid), &m); err != nil {
		t.Fatal(err)
	}
	f(m)
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func sub(m map[string]any, key string) map[string]any { return m[key].(map[string]any) }

func TestRefusals(t *testing.T) {
	cases := map[string]func(map[string]any){
		"unknown top-level field": func(m map[string]any) { m["extra"] = 1 },
		"unknown uid field":       func(m map[string]any) { sub(m, "uids")["root"] = 0 },
		"no version":              func(m map[string]any) { delete(m, "version") },
		"version 2":               func(m map[string]any) { m["version"] = 2 },
		"no uids":                 func(m map[string]any) { delete(m, "uids") },
		"missing uid":             func(m map[string]any) { delete(sub(m, "uids"), "tool") },
		"uid 0":                   func(m map[string]any) { sub(m, "uids")["kete"] = 0 },
		"negative uid":            func(m map[string]any) { sub(m, "uids")["kete"] = -5 },
		"uid 2^32-1":              func(m map[string]any) { sub(m, "uids")["kete"] = 4294967295 },
		"identical uids":          func(m map[string]any) { sub(m, "uids")["tool"] = 991 },
		"proxy uid = kete uid":    func(m map[string]any) { sub(m, "uids")["proxy"] = 991 },
		"no ports":                func(m map[string]any) { delete(m, "ports") },
		"missing port":            func(m map[string]any) { delete(sub(m, "ports"), "root") },
		"port 0":                  func(m map[string]any) { sub(m, "ports")["kete"] = 0 },
		"port 1024":               func(m map[string]any) { sub(m, "ports")["kete"] = 1024 },
		"duplicate ports":         func(m map[string]any) { sub(m, "ports")["tool"] = 81 },
		"no resolvers":            func(m map[string]any) { m["resolvers"] = []string{} },
		"resolver name":           func(m map[string]any) { m["resolvers"] = []string{"dns.example:53"} },
		"resolver no port":        func(m map[string]any) { m["resolvers"] = []string{"8.8.8.8"} },
		"resolver port 5353":      func(m map[string]any) { m["resolvers"] = []string{"8.8.8.8:5353"} },
		"resolver loopback":       func(m map[string]any) { m["resolvers"] = []string{"127.0.0.53:53"} },
		"resolver v6 loopback":    func(m map[string]any) { m["resolvers"] = []string{"[::1]:53"} },
		"resolver unspecified":    func(m map[string]any) { m["resolvers"] = []string{"0.0.0.0:53"} },
		"resolver multicast":      func(m map[string]any) { m["resolvers"] = []string{"224.0.0.251:53"} },
		"resolver zone":           func(m map[string]any) { m["resolvers"] = []string{"[fe80::1%eth0]:53"} },
		"resolver mapped v4":      func(m map[string]any) { m["resolvers"] = []string{"[::ffff:8.8.8.8]:53"} },
		"resolver twice":          func(m map[string]any) { m["resolvers"] = []string{"8.8.8.8:53", "8.8.8.8:53"} },
		"no phases":               func(m map[string]any) { delete(m, "phases") },
		"unknown phase":           func(m map[string]any) { sub(m, "phases")["build"] = map[string]any{} },
		"unknown port in phase":   func(m map[string]any) { sub(sub(m, "phases"), "clone")["proxy"] = []string{"a.example"} },
		"IP host":                 func(m map[string]any) { sub(sub(m, "phases"), "clone")["root"] = []string{"10.0.0.1"} },
		"wildcard host":           func(m map[string]any) { sub(sub(m, "phases"), "clone")["root"] = []string{"*.github.com"} },
		"trailing-dot host":       func(m map[string]any) { sub(sub(m, "phases"), "clone")["root"] = []string{"github.com."} },
		"host with port":          func(m map[string]any) { sub(sub(m, "phases"), "clone")["root"] = []string{"github.com:443"} },
		"duplicate host":          func(m map[string]any) { sub(sub(m, "phases"), "clone")["root"] = []string{"a.example", "A.example"} },
		"no hosts at all":         func(m map[string]any) { m["phases"] = map[string]any{} },
		"registry bad host":       func(m map[string]any) { m["registries"] = []any{map[string]any{"host": "1.2.3.4", "kind": "npm"}} },
		"registry twice": func(m map[string]any) {
			m["registries"] = []any{map[string]any{"host": "r.example", "kind": "npm"}, map[string]any{"host": "R.example", "kind": "npm"}}
		},
		"limits unknown field":        func(m map[string]any) { sub(m, "limits")["max_body"] = 1 },
		"registry_requests raised":    func(m map[string]any) { sub(m, "limits")["registry_requests"] = 20001 },
		"registry_requests 0":         func(m map[string]any) { sub(m, "limits")["registry_requests"] = 0 },
		"log_max_bytes raised":        func(m map[string]any) { sub(m, "limits")["log_max_bytes"] = 10_000_001 },
		"log_max_bytes too small":     func(m map[string]any) { sub(m, "limits")["log_max_bytes"] = 4095 },
		"version as string":           func(m map[string]any) { m["version"] = "1" },
		"resolvers not a list":        func(m map[string]any) { m["resolvers"] = "8.8.8.8:53" },
		"hosts not a list":            func(m map[string]any) { sub(sub(m, "phases"), "clone")["root"] = "github.com" },
		"phase value not an object":   func(m map[string]any) { sub(m, "phases")["clone"] = []string{} },
		"registries entry not object": func(m map[string]any) { m["registries"] = []any{"registry.npmjs.org"} },
	}
	for name, f := range cases {
		if _, err := parse(mutate(t, f)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// D9: registry rules are built-in; the configuration may only narrow them.
func TestRegistryWideningRefused(t *testing.T) {
	widen := map[string]any{
		"unknown kind":             map[string]any{"host": "r.example", "kind": "maven"},
		"shape not built in":       map[string]any{"host": "registry.npmjs.org", "kind": "npm", "shapes": []string{"package", "publish"}},
		"regex instead of a shape": map[string]any{"host": "registry.npmjs.org", "kind": "npm", "shapes": []string{"^/.*$"}},
		"pattern field":            map[string]any{"host": "registry.npmjs.org", "kind": "npm", "pattern": "^/.*$"},
		"methods field":            map[string]any{"host": "registry.npmjs.org", "kind": "npm", "methods": []string{"POST"}},
		"max_path field":           map[string]any{"host": "registry.npmjs.org", "kind": "npm", "max_path": 4096},
		"allow_query field":        map[string]any{"host": "registry.npmjs.org", "kind": "npm", "allow_query": true},
		"reclassify built-in":      map[string]any{"host": "registry.npmjs.org", "kind": "rubygems"},
		"empty shapes":             map[string]any{"host": "registry.npmjs.org", "kind": "npm", "shapes": []string{}},
		"duplicate shape":          map[string]any{"host": "registry.npmjs.org", "kind": "npm", "shapes": []string{"package", "package"}},
	}
	for name, entry := range widen {
		_, err := parse(mutate(t, func(m map[string]any) { m["registries"] = []any{entry} }))
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Narrowing is accepted: a subset of shapes, or a non-built-in host (e.g. a mirror) put under
	// registry rules.
	narrow := []any{
		map[string]any{"host": "registry.npmjs.org", "kind": "npm", "shapes": []string{"tarball"}},
		map[string]any{"host": "mirror.example", "kind": "pypi"},
	}
	c, err := parse(mutate(t, func(m map[string]any) { m["registries"] = narrow }))
	if err != nil {
		t.Fatalf("narrowing refused: %v", err)
	}
	if got := c.Registries["registry.npmjs.org"].Shapes; len(got) != 1 || got[0] != "tarball" {
		t.Errorf("narrowed shapes = %v", got)
	}
}

func TestToolReachesRegistriesOnly(t *testing.T) {
	bad := map[string]func(map[string]any){
		"tool host not a registry": func(m map[string]any) {
			sub(sub(m, "phases"), "agent")["tool"] = []string{"registry.npmjs.org", "evil.example"}
		},
		"tool list in clone": func(m map[string]any) {
			sub(sub(m, "phases"), "clone")["tool"] = []string{"registry.npmjs.org"}
		},
		"tool list in report": func(m map[string]any) {
			sub(sub(m, "phases"), "report")["tool"] = []string{"registry.npmjs.org"}
		},
		"tool gets the gateway": func(m map[string]any) {
			sub(sub(m, "phases"), "agent")["tool"] = []string{"gateway.example"}
		},
	}
	for name, f := range bad {
		if _, err := parse(mutate(t, f)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A declared (non-built-in) registry host is fine for the tool user.
	ok := mutate(t, func(m map[string]any) {
		sub(sub(m, "phases"), "agent")["tool"] = []string{"mirror.example", "pypi.org"}
		m["registries"] = []any{map[string]any{"host": "mirror.example", "kind": "npm"}}
	})
	if _, err := parse(ok); err != nil {
		t.Errorf("declared registry for tool refused: %v", err)
	}
}

func TestTrailingDataAndSize(t *testing.T) {
	if _, err := parse(valid + ` {}`); err == nil {
		t.Error("trailing object accepted")
	}
	if _, err := parse(valid + ` x`); err == nil {
		t.Error("trailing garbage accepted")
	}
	if _, err := parse(strings.Repeat(" ", MaxBytes+1) + valid); err == nil {
		t.Error("oversized config accepted")
	}
	if _, err := parse(""); err == nil {
		t.Error("empty config accepted")
	}
}

func TestUIDsForPort(t *testing.T) {
	u := UIDs{Proxy: 1, Kete: 2, Tool: 3}
	if u.ForPort(PortKete) != 2 || u.ForPort(PortTool) != 3 || u.ForPort(PortRoot) != 0 {
		t.Error("ForPort")
	}
}
