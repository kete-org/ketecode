package proxy

import (
	"strings"
	"testing"
)

const goodStatus = `Name:	kete-egress
Umask:	0022
State:	R (running)
Uid:	990	990	990	990
Gid:	990	990	990	990
Groups:	
NoNewPrivs:	1
CapInh:	0000000000000000
CapPrm:	0000000000000000
CapEff:	0000000000000000
CapBnd:	000001ffffffffff
CapAmb:	0000000000000000
Seccomp:	0
`

func TestCheckStatus(t *testing.T) {
	if err := checkStatus(goodStatus, 990); err != nil {
		t.Fatalf("good status refused: %v", err)
	}
	bad := map[string][2]string{
		"root":           {"Uid:	990	990	990	990", "Uid:	0	0	0	0"},
		"saved uid root": {"Uid:	990	990	990	990", "Uid:	990	990	0	990"},
		"other uid":      {"Uid:	990	990	990	990", "Uid:	991	991	991	991"},
		"gid 0":          {"Gid:	990	990	990	990", "Gid:	0	0	0	0"},
		"saved gid 0":    {"Gid:	990	990	990	990", "Gid:	990	990	0	990"},
		"groups":         {"Groups:	", "Groups:	992 27"},
		"no NNP":         {"NoNewPrivs:	1", "NoNewPrivs:	0"},
		"CapEff":         {"CapEff:	0000000000000000", "CapEff:	0000000000000400"},
		"CapPrm":         {"CapPrm:	0000000000000000", "CapPrm:	0000000000000400"},
		"CapAmb":         {"CapAmb:	0000000000000000", "CapAmb:	0000000000000400"},
		"missing NNP":    {"NoNewPrivs:	1\n", ""},
		"missing Groups": {"Groups:	\n", ""},
		"bad cap number": {"CapEff:	0000000000000000", "CapEff:	zz"},
	}
	for name, r := range bad {
		st := strings.Replace(goodStatus, r[0], r[1], 1)
		if st == goodStatus {
			t.Fatalf("%s: replacement didn't apply", name)
		}
		if err := checkStatus(st, 990); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
