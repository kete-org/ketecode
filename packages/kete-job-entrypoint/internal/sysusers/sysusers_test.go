package sysusers

import (
	"strings"
	"testing"
)

var names = Names{Kete: "kete", Tool: "kete-tool", Proxy: "kete-proxy", Group: "kete-job"}

const passwd = `root:x:0:0:root:/root:/bin/bash
kete-proxy:x:997:997::/nonexistent:/usr/sbin/nologin
kete:x:996:996::/nonexistent:/usr/sbin/nologin
kete-tool:x:995:995::/nonexistent:/usr/sbin/nologin
`

const groups = `root:x:0:
kete-job:x:998:kete,kete-tool
kete-proxy:x:997:
kete:x:996:
kete-tool:x:995:
`

func TestResolve(t *testing.T) {
	ids, err := Resolve(strings.NewReader(passwd), strings.NewReader(groups), names)
	if err != nil {
		t.Fatal(err)
	}
	if ids.Kete.UID != 996 || ids.Tool.UID != 995 || ids.Proxy.UID != 997 || ids.JobGID != 998 {
		t.Errorf("ids = %+v", ids)
	}
}

func TestResolveRefusals(t *testing.T) {
	cases := map[string][2]string{
		"missing user":       {strings.Replace(passwd, "kete-tool:x:995:995", "other:x:995:995", 1), groups},
		"uid 0":              {strings.Replace(passwd, "kete:x:996:996", "kete:x:0:996", 1), groups},
		"same uid":           {strings.Replace(passwd, "kete-tool:x:995", "kete-tool:x:996", 1), groups},
		"missing group":      {passwd, strings.Replace(groups, "kete-job:", "other-job:", 1)},
		"extra member":       {passwd, strings.Replace(groups, "kete,kete-tool", "kete,kete-tool,root", 1)},
		"proxy member":       {passwd, strings.Replace(groups, "kete,kete-tool", "kete,kete-tool,kete-proxy", 1)},
		"proxy supplemental": {passwd, strings.Replace(groups, "kete-tool:x:995:", "kete-tool:x:995:kete-proxy", 1)},
		"missing member":     {passwd, strings.Replace(groups, "kete,kete-tool", "kete", 1)},
		"primary job group":  {strings.Replace(passwd, "root:x:0:0", "root:x:0:998", 1), groups},
		"malformed":          {passwd + "broken\n", groups},
	}
	for name, c := range cases {
		if _, err := Resolve(strings.NewReader(c[0]), strings.NewReader(c[1]), names); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
