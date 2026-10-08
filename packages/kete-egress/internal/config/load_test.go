package config

import (
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
)

func TestLoadPicksTheVersion(t *testing.T) {
	v1 := `{"version":1,"uids":{"proxy":990,"kete":991,"tool":992},"ports":{"kete":81,"tool":82,"root":83},"resolvers":["10.96.0.10:53"],"phases":{"agent":{"kete":["a.example"]}}}`
	c, err := Load(strings.NewReader(v1))
	if err != nil || c.Version != Version || c.Upstream != nil {
		t.Fatalf("v1: %v %+v", err, c)
	}
	v2 := `{"version":2,"uids":{"proxy":990,"kete":991,"tool":992},"ports":{"kete":81,"tool":82,"root":83},"resolvers":["10.96.0.10:53"],
	  "phases":{"clone":{"root":["git.corp.example:8443"]},"agent":{"kete":["a.example"]}},
	  "upstream":{"proxy":"http://proxy.corp.example:3128","direct":["git.corp.example:8443"]},
	  "internal":[{"cidr":"10.20.0.0/16","ports":[3128,8443]}]}`
	c, err = Load(strings.NewReader(v2))
	if err != nil {
		t.Fatal(err)
	}
	if c.Version != VersionV2 || c.Upstream == nil || len(c.Internal) != 1 ||
		!c.Allow[phase.Clone][PortRoot]["git.corp.example:8443"] || !c.Allow[phase.Agent][PortKete]["a.example"] {
		t.Errorf("v2 runtime form: %+v", c)
	}
	hosts := c.AllHosts()
	if len(hosts) != 2 || hosts[0] != "a.example" || hosts[1] != "git.corp.example" {
		t.Errorf("AllHosts = %v (host names, ports dropped)", hosts)
	}
	// A v2 refusal stays a v2 refusal through Load.
	if _, err := Load(strings.NewReader(strings.Replace(v2, `"10.20.0.0/16"`, `"10.20.0.1/16"`, 1))); err == nil {
		t.Error("Load accepted a non-canonical internal CIDR")
	}
	if _, err := Load(strings.NewReader(`{"version":3}`)); err == nil {
		t.Error("Load accepted version 3")
	}
}
