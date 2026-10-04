package policy

import (
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
)

const cfgJSON = `{
  "version": 1,
  "uids": { "proxy": 990, "kete": 991, "tool": 992 },
  "ports": { "kete": 81, "tool": 82, "root": 83 },
  "resolvers": ["198.51.100.53:53"],
  "phases": {
    "clone":  { "root": ["github.test", "platform.test"] },
    "agent":  { "kete": ["gateway.test", "platform.test"], "tool": ["registry.npm.test"], "root": ["platform.test"] },
    "report": { "root": ["platform.test", "storage.test"] }
  },
  "registries": [ { "host": "registry.npm.test", "kind": "npm" } ]
}`

func TestAllowed(t *testing.T) {
	cfg, err := config.Parse(strings.NewReader(cfgJSON))
	if err != nil {
		t.Fatal(err)
	}
	p := New(cfg)
	type c struct {
		ph   phase.Phase
		port config.Port
		host string
		want bool
	}
	cases := []c{
		{phase.Clone, config.PortRoot, "github.test", true},
		{phase.Clone, config.PortKete, "github.test", false},
		{phase.Clone, config.PortTool, "github.test", false},
		{phase.Clone, config.PortKete, "gateway.test", false},
		{phase.Agent, config.PortKete, "gateway.test", true},
		{phase.Agent, config.PortKete, "platform.test", true},
		{phase.Agent, config.PortKete, "github.test", false},
		{phase.Agent, config.PortTool, "registry.npm.test", true},
		{phase.Agent, config.PortTool, "gateway.test", false},
		{phase.Agent, config.PortRoot, "platform.test", true},
		{phase.Agent, config.PortRoot, "github.test", false},
		{phase.Agent, config.PortRoot, "storage.test", false},
		{phase.Report, config.PortRoot, "storage.test", true},
		{phase.Report, config.PortKete, "gateway.test", false},
		{phase.Report, config.PortTool, "registry.npm.test", false},
		// Exact match only: no suffix, prefix or case games (callers normalise first).
		{phase.Agent, config.PortKete, "evil.gateway.test", false},
		{phase.Agent, config.PortKete, "gateway.test.evil", false},
		{phase.Agent, config.PortKete, "GATEWAY.test", false},
		{phase.Agent, config.PortKete, "", false},
	}
	for _, ph := range []phase.Phase{phase.None, phase.Closed} {
		for _, port := range config.Ports {
			for _, h := range []string{"github.test", "gateway.test", "platform.test", "storage.test", "registry.npm.test"} {
				cases = append(cases, c{ph, port, h, false})
			}
		}
	}
	for _, tc := range cases {
		if got := p.Allowed(tc.ph, tc.port, tc.host); got != tc.want {
			t.Errorf("Allowed(%s, %s, %q) = %v, want %v", tc.ph, tc.port, tc.host, got, tc.want)
		}
	}
}
