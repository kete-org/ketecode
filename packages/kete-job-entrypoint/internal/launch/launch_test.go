package launch

import "testing"

func TestValidate(t *testing.T) {
	ok := Spec{Path: "/bin/true", Argv: []string{"true"}, UID: 5, GID: 5, Umask: 0o022}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	root := Spec{Path: "/bin/true", Argv: []string{"true"}, KeepRoot: true}
	if err := root.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := []Spec{
		{Path: "true", Argv: []string{"true"}, UID: 5, GID: 5},
		{Path: "/bin/true", UID: 5, GID: 5},
		{Path: "/bin/true", Argv: []string{"true"}},
		{Path: "/bin/true", Argv: []string{"true"}, KeepRoot: true, UID: 5},
		{Path: "/bin/true", Argv: []string{"true"}, UID: 5, GID: 5, OOMScoreAdj: -1001},
		{Path: "/bin/true", Argv: []string{"true"}, UID: 5, GID: 5, Umask: 0o1000},
	}
	for i, s := range bad {
		if s.Validate() == nil {
			t.Errorf("bad[%d] accepted", i)
		}
	}
}

func TestDecodeStatus(t *testing.T) {
	err := decodeStatus([]byte(`{"code":"identity","errno":1}`))
	if e, ok := err.(*Error); !ok || e.Code != "identity" || e.Errno != 1 {
		t.Errorf("err = %v", err)
	}
	if e, ok := decodeStatus([]byte(`junk`)).(*Error); !ok || e.Code != "internal" {
		t.Error("junk status")
	}
}
