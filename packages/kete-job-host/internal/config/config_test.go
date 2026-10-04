package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/testroot"
)

const base = `"platform_url":"https://portal.kete.example","image_allowlist":["ghcr.io/kete-org/kete-job@sha256:4f9c2b7a1e8d3c6f5a0b9e2d7c4f1a8b3e6d9c2f5a8b1e4d7c0f3a6b9e2d5c8f"]`
const fc = `"driver":"firecracker","slots":4,"reset":"none","versions":{"firecracker":"1.13.1","guest_kernel":"6.1.141-kete.1"}`

func TestParse(t *testing.T) {
	c, err := Parse([]byte(`{` + base + `,` + fc + `,"resolvers":["1.1.1.1","8.8.8.8"],"kernel_allowlist":["sha256:` + strings.Repeat("a", 64) + `"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.Origin != "https://portal.kete.example" || c.Authority != "portal.kete.example" || c.StateDir != DefaultStateDir || c.HostProfile() != "microvm" || len(c.Resolvers) != 2 {
		t.Fatalf("%+v", c)
	}
	d, err := Parse([]byte(`{` + base + `,"driver":"dedicated","slots":1,"reset":"provider_rebuild","generation":"g-1","versions":{}}`))
	if err != nil || d.HostProfile() != "dedicated" {
		t.Fatalf("dedicated: %v", err)
	}
	if o, h, err := NormalizeOrigin("https://portal.kete.example:443/"); err != nil || o != "https://portal.kete.example" || h != "portal.kete.example" {
		t.Errorf("normalize: %s %s %v", o, h, err)
	}
}

func TestParseRefusals(t *testing.T) {
	cases := map[string]string{
		"unknown field":           `{` + base + `,` + fc + `,"extra":1}`,
		"http":                    `{"platform_url":"http://portal.kete.example",` + fc + `,"image_allowlist":[]}`,
		"path":                    `{"platform_url":"https://portal.kete.example/api",` + fc + `,"image_allowlist":[]}`,
		"port":                    `{"platform_url":"https://portal.kete.example:8443",` + fc + `,"image_allowlist":[]}`,
		"ip host":                 `{"platform_url":"https://10.0.0.1",` + fc + `,"image_allowlist":[]}`,
		"uppercase host":          `{"platform_url":"https://Portal.kete.example",` + fc + `,"image_allowlist":[]}`,
		"userinfo":                `{"platform_url":"https://u:p@portal.kete.example",` + fc + `,"image_allowlist":[]}`,
		"firecracker reset":       `{` + base + `,"driver":"firecracker","slots":4,"reset":"provider_rebuild","versions":{"firecracker":"1","guest_kernel":"1"}}`,
		"firecracker no versions": `{` + base + `,"driver":"firecracker","slots":4,"reset":"none","versions":{}}`,
		"dedicated no reset":      `{` + base + `,"driver":"dedicated","slots":1,"reset":"none","generation":"g-1","versions":{}}`,
		"dedicated measured boot": `{` + base + `,"driver":"dedicated","slots":1,"reset":"measured_boot","generation":"g-1","versions":{}}`,
		"dedicated two slots":     `{` + base + `,"driver":"dedicated","slots":2,"reset":"provider_rebuild","generation":"g-1","versions":{}}`,
		"dedicated no generation": `{` + base + `,"driver":"dedicated","slots":1,"reset":"provider_rebuild","versions":{}}`,
		"unknown driver":          `{` + base + `,"driver":"docker","slots":1,"reset":"none","versions":{}}`,
		"slots":                   `{` + base + `,"driver":"firecracker","slots":33,"reset":"none","versions":{"firecracker":"1","guest_kernel":"1"}}`,
		"tag in allowlist":        `{"platform_url":"https://portal.kete.example",` + fc + `,"image_allowlist":["ghcr.io/kete-org/kete-job:latest"]}`,
		"private resolver":        `{` + base + `,` + fc + `,"resolvers":["10.0.0.53"]}`,
		"metadata resolver":       `{` + base + `,` + fc + `,"resolvers":["169.254.169.254"]}`,
		"ipv6 resolver":           `{` + base + `,` + fc + `,"resolvers":["2606:4700:4700::1111"]}`,
		"relative state dir":      `{` + base + `,` + fc + `,"state_dir":"var/lib/x"}`,
		"unclean state dir":       `{` + base + `,` + fc + `,"state_dir":"/var/lib/../x"}`,
		"starts_blocked other":    `{` + base + `,` + fc + `,"starts_blocked":"host_table"}`,
		"bad kernel digest":       `{` + base + `,` + fc + `,"kernel_allowlist":["sha256:abc"]}`,
		"trailing data":           `{` + base + `,` + fc + `} {}`,
	}
	for name, js := range cases {
		if _, err := Parse([]byte(js)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLoadFileRules(t *testing.T) {
	dir := testroot.Dir(t)
	p := filepath.Join(dir, "config.json")
	js := `{` + base + `,` + fc + `}`
	if err := os.WriteFile(p, []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err != nil {
		t.Fatalf("root 0644 config refused: %v", err)
	}
	_ = os.Chmod(p, 0o666)
	if _, err := Load(p); err == nil {
		t.Error("world-writable config accepted")
	}
	_ = os.Chmod(p, 0o644)
	_ = os.Chown(p, 1000, 1000)
	if _, err := Load(p); err == nil {
		t.Error("config owned by another user accepted")
	}
	_ = os.Chown(p, 0, 0)
	l := filepath.Join(dir, "link.json")
	_ = os.Symlink(p, l)
	if _, err := Load(l); err == nil {
		t.Error("symlinked config accepted")
	}
	_ = os.Chmod(dir, 0o777)
	if _, err := Load(p); err == nil {
		t.Error("config under a world-writable directory accepted")
	}
	_ = os.Chmod(dir, 0o700)
	d := filepath.Join(dir, "adir")
	_ = os.Mkdir(d, 0o755)
	if _, err := Load(d); err == nil {
		t.Error("directory accepted")
	}
}

func TestParseFirecrackerSection(t *testing.T) {
	c, err := Parse([]byte(`{` + base + `,` + fc + `,"resolvers":["1.1.1.1"],"firecracker":{"kernel":"/var/lib/kete-job-host/kernels/vmlinux"}}`))
	if err != nil {
		t.Fatal(err)
	}
	f := c.FC
	if f == nil || f.FirecrackerBin != "/usr/local/bin/firecracker" || f.JailerBin != "/usr/local/bin/jailer" || f.GuestNetwork.String() != "10.200.0.0/16" ||
		f.UIDBase != 900_000_000 || f.VMMOverheadMiB != 256 || f.MinFreeGiB != 10 || f.Uplink != "" {
		t.Fatalf("defaults: %+v", f)
	}
	sec := func(s string) string { return `{` + base + `,` + fc + `,"firecracker":{` + s + `}}` }
	for name, raw := range map[string]string{
		"no kernel":         sec(`"guest_network":"10.200.0.0/16"`),
		"relative kernel":   sec(`"kernel":"vmlinux"`),
		"unclean kernel":    sec(`"kernel":"/var/lib/../vmlinux"`),
		"renamed binary":    sec(`"kernel":"/k","firecracker_bin":"/usr/local/bin/fc"`),
		"public pool":       sec(`"kernel":"/k","guest_network":"203.0.113.0/24"`),
		"pool too small":    `{` + base + `,"driver":"firecracker","slots":4,"reset":"none","versions":{"firecracker":"1","guest_kernel":"1"},"firecracker":{"kernel":"/k","guest_network":"10.0.0.0/29"}}`,
		"v6 pool":           sec(`"kernel":"/k","guest_network":"fd00::/64"`),
		"bad uplink":        sec(`"kernel":"/k","uplink":"eth0;drop"`),
		"low uid base":      sec(`"kernel":"/k","uid_base":1000`),
		"unknown field":     sec(`"kernel":"/k","vsock":true`),
		"dedicated section": `{` + base + `,"driver":"dedicated","slots":1,"reset":"provider_rebuild","generation":"g-1","versions":{},"firecracker":{"kernel":"/k"}}`,
		"three resolvers":   `{` + base + `,` + fc + `,"resolvers":["1.1.1.1","8.8.8.8","9.9.9.9"]}`,
		"zero overhead":     sec(`"kernel":"/k","vmm_overhead_mib":-1`),
		"huge rate":         sec(`"kernel":"/k","net_mbps":1000000`),
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestParseDedicatedSection(t *testing.T) {
	ded := `"driver":"dedicated","slots":1,"reset":"provider_rebuild","generation":"g-1","versions":{},"resolvers":["1.1.1.1"]`
	c, err := Parse([]byte(`{` + base + `,` + ded + `}`))
	if err != nil {
		t.Fatal(err)
	}
	d := c.Ded
	if d == nil || d.GuestNetwork.String() != "10.200.0.0/30" || d.PidsMax != 32768 || d.MinFreeGiB != 10 || d.Uplink != "" || c.FC != nil {
		t.Fatalf("defaults: %+v", d)
	}
	c, err = Parse([]byte(`{` + base + `,` + ded + `,"dedicated":{"guest_network":"192.168.77.0/29","uplink":"enp1s0","pids_max":4096,"min_free_gib":2}}`))
	if err != nil || c.Ded.GuestNetwork.String() != "192.168.77.0/29" || c.Ded.Uplink != "enp1s0" || c.Ded.PidsMax != 4096 || c.Ded.MinFreeGiB != 2 {
		t.Fatalf("explicit: %+v %v", c.Ded, err)
	}
	sec := func(s string) string { return `{` + base + `,` + ded + `,"dedicated":{` + s + `}}` }
	for name, raw := range map[string]string{
		"public pool":         sec(`"guest_network":"203.0.113.0/30"`),
		"pool too small":      sec(`"guest_network":"10.0.0.0/31"`),
		"unmasked pool":       sec(`"guest_network":"10.0.0.1/30"`),
		"v6 pool":             sec(`"guest_network":"fd00::/64"`),
		"bad uplink":          sec(`"uplink":"eth0;drop"`),
		"few pids":            sec(`"pids_max":10`),
		"unknown field":       sec(`"privileged":true`),
		"on firecracker":      `{` + base + `,` + fc + `,"dedicated":{}}`,
		"measured boot":       `{` + base + `,"driver":"dedicated","slots":1,"reset":"measured_boot","generation":"g-1","versions":{},"dedicated":{}}`,
		"firecracker version": `{` + base + `,"driver":"dedicated","slots":1,"reset":"provider_rebuild","generation":"g-1","versions":{"firecracker":"1.17.0"}}`,
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
