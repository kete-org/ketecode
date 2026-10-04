package registry

import (
	"bufio"
	"net/http"
	"strings"
	"testing"
)

// req parses a raw HTTP/1.1 request the way the proxy's server does, so RequestURI, RawQuery,
// ContentLength and TransferEncoding are exactly what the proxy sees.
func req(t *testing.T, raw string) *http.Request {
	t.Helper()
	r, err := http.ReadRequest(bufio.NewReader(strings.NewReader(raw)))
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return r
}

func get(t *testing.T, target string) *http.Request {
	return req(t, "GET "+target+" HTTP/1.1\r\nHost: r.test\r\n\r\n")
}

func rulesFor(t *testing.T, kind Kind, shapes []string, limit int) *Rules {
	t.Helper()
	r, err := NewRules(map[string]Spec{"r.test": {Kind: kind, Shapes: shapes}}, limit)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

const pypiHash = "0e2d847013cb52cd35b38c009bb167a1a26b2ce6cd6965bf26b47bc0bf44"

func TestShapesAllowRealPaths(t *testing.T) {
	if len(pypiHash) != 60 {
		t.Fatalf("setup: hash is %d chars", len(pypiHash))
	}
	cases := map[Kind][]string{
		NPM: {
			"/left-pad",
			"/@types/node",
			"/@types%2fnode",
			"/@types%2Fnode",
			"/left-pad/-/left-pad-1.3.0.tgz",
			"/@types/node/-/node-20.11.0.tgz",
			"/lodash.merge",
		},
		PyPI: {
			"/simple/",
			"/simple/requests/",
			"/pypi/requests/json",
			"/pypi/requests/2.31.0/json",
			"/packages/70/8e/" + pypiHash + "/requests-2.31.0-py3-none-any.whl",
			"/packages/70/8e/" + pypiHash + "/requests-2.31.0-py3-none-any.whl.metadata",
			"/packages/70/8e/" + pypiHash + "/requests-2.31.0.tar.gz",
		},
		Crates: {
			"/config.json",
			"/1/a",
			"/2/ab",
			"/3/a/abc",
			"/se/rd/serde",
			"/crates/serde/serde-1.0.197.crate",
			"/api/v1/crates/serde/1.0.197/download",
			"/crates/serde/1.0.197/download",
		},
		RubyGems: {
			"/versions",
			"/info/rails",
			"/names",
			"/gems/rails-7.1.3.gem",
			"/quick/Marshal.4.8/rails-7.1.3.gemspec.rz",
			"/specs.4.8.gz",
			"/latest_specs.4.8.gz",
			"/prerelease_specs.4.8.gz",
		},
	}
	for kind, paths := range cases {
		r := rulesFor(t, kind, nil, DefaultCap)
		for _, p := range paths {
			if st, reason := r.Check("r.test", get(t, p)); st != 0 {
				t.Errorf("%s %s refused: %d %s", kind, p, st, reason)
			}
			head := req(t, "HEAD "+p+" HTTP/1.1\r\nHost: r.test\r\n\r\n")
			if st, reason := r.Check("r.test", head); st != 0 {
				t.Errorf("%s HEAD %s refused: %d %s", kind, p, st, reason)
			}
		}
	}
}

func TestShapesRefuse(t *testing.T) {
	cases := map[Kind][]string{
		NPM: {
			"/-/npm/v1/security/advisories/bulk",
			"/-/whoami",
			"/left-pad/1.3.0",
			"/left-pad/-/left-pad-1.3.0.tar",
			"/@types",
			"/",
		},
		PyPI: {
			"/simple",
			"/simple/requests",
			"/packages/70/8e/abc/requests.whl",
			"/legacy/",
			"/pypi/requests/json/x",
		},
		Crates: {
			"/api/v1/crates/new",
			"/api/v1/crates?q=serde",
			"/abc/rd/serde",
			"/crates/serde/serde.zip",
			"/crates/serde/1.0.197/download/extra",
			"/crates/serde/1.0.197/upload",
			"/crates/serde/../download",
			"/api/v1/crates/serde/./download",
		},
		RubyGems: {
			"/api/v1/gems",
			"/gems/rails.zip",
			"/specs.4.8",
		},
	}
	for kind, paths := range cases {
		r := rulesFor(t, kind, nil, DefaultCap)
		for _, p := range paths {
			if st, _ := r.Check("r.test", get(t, p)); st == 0 {
				t.Errorf("%s %s allowed", kind, p)
			}
		}
	}
}

func TestRequestRules(t *testing.T) {
	r := rulesFor(t, NPM, nil, DefaultCap)
	cases := []struct {
		name   string
		raw    string
		status int
		reason string
	}{
		{"POST audit", "POST /-/npm/v1/security/audits/quick HTTP/1.1\r\nHost: r.test\r\nContent-Length: 2\r\n\r\n{}", 405, ReasonMethod},
		{"PUT", "PUT /left-pad HTTP/1.1\r\nHost: r.test\r\n\r\n", 405, ReasonMethod},
		{"DELETE", "DELETE /left-pad HTTP/1.1\r\nHost: r.test\r\n\r\n", 405, ReasonMethod},
		{"OPTIONS", "OPTIONS /left-pad HTTP/1.1\r\nHost: r.test\r\n\r\n", 405, ReasonMethod},
		{"query", "GET /left-pad?x=1 HTTP/1.1\r\nHost: r.test\r\n\r\n", 403, ReasonQuery},
		{"bare ?", "GET /left-pad? HTTP/1.1\r\nHost: r.test\r\n\r\n", 403, ReasonQuery},
		{"GET with body", "GET /left-pad HTTP/1.1\r\nHost: r.test\r\nContent-Length: 5\r\n\r\nhello", 403, ReasonBody},
		{"GET chunked", "GET /left-pad HTTP/1.1\r\nHost: r.test\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", 403, ReasonBody},
		{"dotdot", "GET /left-pad/../x HTTP/1.1\r\nHost: r.test\r\n\r\n", 403, ReasonPath},
		{"dot", "GET /./left-pad HTTP/1.1\r\nHost: r.test\r\n\r\n", 403, ReasonPath},
		{"double slash", "GET //left-pad HTTP/1.1\r\nHost: r.test\r\n\r\n", 403, ReasonPath},
		{"percent", "GET /left%2dpad HTTP/1.1\r\nHost: r.test\r\n\r\n", 403, ReasonPath},
		{"encoded dotdot", "GET /%2e%2e/x HTTP/1.1\r\nHost: r.test\r\n\r\n", 403, ReasonPath},
		{"unknown shape", "GET /-/whoami HTTP/1.1\r\nHost: r.test\r\n\r\n", 403, ReasonPathShape},
	}
	for _, c := range cases {
		st, reason := r.Check("r.test", req(t, c.raw))
		if st != c.status || reason != c.reason {
			t.Errorf("%s: %d %q, want %d %q", c.name, st, reason, c.status, c.reason)
		}
	}
}

func TestCleanPath(t *testing.T) {
	for _, p := range []string{"/left-pad%2", "/left-pad%", "/a%2", "/a#b", "a", "/a//b", "/a/.."} {
		if cleanPath(p) {
			t.Errorf("cleanPath(%q) = true", p)
		}
	}
	for _, p := range []string{"/@a%2fb", "/@a%2Fb", "/simple/", "/a/b.c"} {
		if !cleanPath(p) {
			t.Errorf("cleanPath(%q) = false", p)
		}
	}
}

func TestTargetLengthBoundary(t *testing.T) {
	r := rulesFor(t, NPM, nil, DefaultCap)
	at := "/" + strings.Repeat("a", MaxTarget-1)
	over := "/" + strings.Repeat("a", MaxTarget)
	// 1024 bytes passes the length rule (and then fails the shape: an npm name is ≤ 214).
	if st, reason := r.Check("r.test", get(t, at)); st != http.StatusForbidden || reason != ReasonPathShape {
		t.Errorf("1024 bytes: %d %s, want 403 path_shape", st, reason)
	}
	if st, reason := r.Check("r.test", get(t, over)); st != http.StatusRequestURITooLong || reason != ReasonPathLength {
		t.Errorf("1025 bytes: %d %s, want 414", st, reason)
	}
}

func TestCap(t *testing.T) {
	const n = 7
	r := rulesFor(t, NPM, nil, n)
	for i := 1; i <= n; i++ {
		if st, reason := r.Check("r.test", get(t, "/left-pad")); st != 0 {
			t.Fatalf("request %d refused: %d %s", i, st, reason)
		}
	}
	if st, reason := r.Check("r.test", get(t, "/left-pad")); st != http.StatusTooManyRequests || reason != ReasonCap {
		t.Errorf("request %d: %d %s, want 429", n+1, st, reason)
	}
	// Refused shapes don't count toward the cap.
	r2 := rulesFor(t, NPM, nil, 1)
	for i := 0; i < 5; i++ {
		r2.Check("r.test", get(t, "/-/whoami"))
	}
	if st, _ := r2.Check("r.test", get(t, "/left-pad")); st != 0 {
		t.Errorf("refused shapes consumed the cap")
	}
}

func TestNonRegistryHostUntouched(t *testing.T) {
	r := rulesFor(t, NPM, nil, DefaultCap)
	if r.IsRegistry("other.test") {
		t.Fatal("other.test is a registry")
	}
	post := req(t, "POST /anything?x=1 HTTP/1.1\r\nHost: other.test\r\nContent-Length: 1\r\n\r\nx")
	if st, _ := r.Check("other.test", post); st != 0 {
		t.Errorf("a non-registry host got registry rules")
	}
}

func TestNarrowedShapes(t *testing.T) {
	r := rulesFor(t, NPM, []string{"package", "tarball"}, DefaultCap)
	if st, _ := r.Check("r.test", get(t, "/left-pad")); st != 0 {
		t.Error("kept shape refused")
	}
	if st, reason := r.Check("r.test", get(t, "/@types/node")); st != http.StatusForbidden || reason != ReasonPathShape {
		t.Errorf("removed shape: %d %s, want 403 path_shape", st, reason)
	}
}

// D9: the configuration can only narrow the built-in rules.
func TestValidateRefusesWidening(t *testing.T) {
	ok := []struct {
		host string
		spec Spec
	}{
		{"registry.npmjs.org", Spec{Kind: NPM}},
		{"registry.npmjs.org", Spec{Kind: NPM, Shapes: []string{"package"}}},
		{"mirror.example", Spec{Kind: PyPI, Shapes: []string{"simple_index", "simple_project", "file"}}},
		{"static.crates.io", Spec{Kind: Crates, Shapes: []string{"crate_file"}}},
	}
	for _, c := range ok {
		if err := Validate(c.host, c.spec); err != nil {
			t.Errorf("Validate(%s, %+v): %v", c.host, c.spec, err)
		}
	}
	bad := []struct {
		name string
		host string
		spec Spec
	}{
		{"unknown kind", "mirror.example", Spec{Kind: "maven"}},
		{"empty kind", "mirror.example", Spec{}},
		{"unknown shape", "registry.npmjs.org", Spec{Kind: NPM, Shapes: []string{"package", "publish"}}},
		{"shape of another kind", "registry.npmjs.org", Spec{Kind: NPM, Shapes: []string{"simple_index"}}},
		{"regex as shape", "registry.npmjs.org", Spec{Kind: NPM, Shapes: []string{".*"}}},
		{"duplicate shape", "registry.npmjs.org", Spec{Kind: NPM, Shapes: []string{"package", "package"}}},
		{"empty shapes", "registry.npmjs.org", Spec{Kind: NPM, Shapes: []string{}}},
		{"reclassified built-in host", "registry.npmjs.org", Spec{Kind: PyPI}},
		{"reclassified pypi files host", "files.pythonhosted.org", Spec{Kind: Crates}},
	}
	for _, c := range bad {
		if err := Validate(c.host, c.spec); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
		if _, err := NewRules(map[string]Spec{c.host: c.spec}, DefaultCap); err == nil {
			t.Errorf("%s: NewRules accepted", c.name)
		}
	}
}

func TestBuiltinHostsHaveKnownKinds(t *testing.T) {
	for host, kind := range BuiltinHosts {
		if ShapeNames(kind) == nil {
			t.Errorf("%s: kind %q has no shapes", host, kind)
		}
	}
}
