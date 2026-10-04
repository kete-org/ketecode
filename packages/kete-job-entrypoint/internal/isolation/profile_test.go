package isolation

import (
	"reflect"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
)

// TestBuildOffFly: off Fly no Fly resolver, 6PN sample or local fdaa::/16 address is probed, the
// profile's Extra targets are added once each, and the zero value (fly) is unchanged.
func TestBuildOffFly(t *testing.T) {
	fly := Build(inputs())
	in := inputs()
	in.OffFly, in.FlySockets = true, nil
	in.Resolvers = []string{"198.51.100.53:53"} // off Fly, resolv.conf names no fdaa::3
	in.Extra = []Probe{
		{Kind: KindTCP, Target: "10.0.0.1:443", Reason: phaselog.CodePrivateRange},
		{Kind: KindTCP, Target: "169.254.169.254:80", Reason: phaselog.CodeMetadata}, // already a metadata target
		{Kind: KindFile, Target: "/dev/vda", Reason: phaselog.CodeGuardedPath},
	}
	off := Build(in)
	for _, p := range off {
		if strings.Contains(p.Target, "fdaa") || p.Reason == phaselog.CodeSixPN || p.Reason == phaselog.CodeFlyAPI {
			t.Errorf("off Fly probes %v", p)
		}
	}
	count := map[string]int{}
	for _, p := range off {
		count[string(p.Kind)+" "+p.Target]++
	}
	for _, k := range []string{"tcp 10.0.0.1:443", "tcp 169.254.169.254:80", "file /dev/vda"} {
		if count[k] != 1 {
			t.Errorf("%s probed %d times", k, count[k])
		}
	}
	if err := NewRequest(off).Validate(); err != nil {
		t.Errorf("off-Fly request invalid: %v", err)
	}
	in2 := inputs()
	if !reflect.DeepEqual(Build(in2), fly) {
		t.Error("Build is not deterministic for fly")
	}
	sixpn := false
	for _, p := range fly {
		if p.Reason == phaselog.CodeSixPN {
			sixpn = true
		}
	}
	if !sixpn {
		t.Error("fly lost its 6PN probes")
	}
}

func TestCheckGuardedFile(t *testing.T) {
	req := NewRequest(append(Controls(control, unixControl), Probe{Kind: KindFile, Target: "/dev/vda", Reason: phaselog.CodeGuardedPath}))
	if got := Check(t.Context(), req, newNet("file /dev/vda")); got != phaselog.CodeGuardedPath {
		t.Errorf("readable block device: %s", got)
	}
	if got := Check(t.Context(), req, newNet()); got != OK {
		t.Errorf("unreadable block device: %s", got)
	}
}
