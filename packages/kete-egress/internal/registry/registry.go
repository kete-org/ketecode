// Package registry holds the package-registry rules (module README "Registry rules"; ADR 0019
// rule 4): GET/HEAD only, no query and no body, a request target of at most 1 KiB, a per-kind
// path-shape allowlist and a per-job request cap.
//
// The shapes, and the kind of each well-known public registry host, are built in. The
// configuration can only narrow them (decision D9): it can leave a registry out of every
// allowlist, restrict a host to a subset of its kind's shape names, and lower the cap. It can
// never add a shape, a kind, a method or a longer path, and it can't reclassify a built-in host
// or free it from registry rules — Validate refuses every such widening.
package registry

import (
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
)

// Kind names a registry protocol.
type Kind string

const (
	NPM      Kind = "npm"
	PyPI     Kind = "pypi"
	Crates   Kind = "crates"
	RubyGems Kind = "rubygems"
)

// MaxTarget is the longest request target (path) a registry request may have.
const MaxTarget = 1024

// DefaultCap is the default, and highest, number of registry requests per job.
const DefaultCap = 20000

// Refusal reasons, as they appear in the request log.
const (
	ReasonMethod     = "method"
	ReasonQuery      = "query"
	ReasonBody       = "body"
	ReasonPathLength = "path_length"
	ReasonPath       = "path"
	ReasonPathShape  = "path_shape"
	ReasonCap        = "registry_cap"
)

type shape struct {
	name string
	re   *regexp.Regexp
}

const (
	npmName   = `[A-Za-z0-9._~-]{1,214}`
	pypiName  = `[A-Za-z0-9._-]{1,128}`
	pypiVer   = `[A-Za-z0-9._+!-]{1,128}`
	pypiFile  = `[A-Za-z0-9._+!-]{1,255}`
	crateName = `[A-Za-z0-9_-]{1,64}`
	crateVer  = `[A-Za-z0-9][A-Za-z0-9.+-]{0,127}` // never "." or ".."
	gemName   = `[A-Za-z0-9._-]{1,128}`
	gemFile   = `[A-Za-z0-9._+-]{1,255}`
)

func s(name, pattern string) shape {
	return shape{name: name, re: regexp.MustCompile("^" + pattern + "$")}
}

// kinds is the built-in shape table. Each regex matches the raw request target (the path, with
// no query — a query is refused before shapes are checked).
var kinds = map[Kind][]shape{
	NPM: {
		s("package", `/`+npmName),
		s("scoped_package", `/@`+npmName+`/`+npmName),
		s("scoped_package_encoded", `/@`+npmName+`%2[fF]`+npmName),
		s("tarball", `/`+npmName+`/-/`+npmName+`\.tgz`),
		s("scoped_tarball", `/@`+npmName+`/`+npmName+`/-/`+npmName+`\.tgz`),
	},
	PyPI: {
		s("simple_index", `/simple/`),
		s("simple_project", `/simple/`+pypiName+`/`),
		s("json_project", `/pypi/`+pypiName+`/json`),
		s("json_release", `/pypi/`+pypiName+`/`+pypiVer+`/json`),
		// A files host: /packages/<2 hex>/<2 hex>/<60 hex>/<file>, which also covers the
		// "<file>.metadata" variant.
		s("file", `/packages/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{60}/`+pypiFile),
	},
	Crates: {
		s("config", `/config\.json`),
		s("index_1", `/1/`+crateName),
		s("index_2", `/2/`+crateName),
		s("index_3", `/3/[A-Za-z0-9_-]/`+crateName),
		s("index_4", `/[A-Za-z0-9_-]{2}/[A-Za-z0-9_-]{2}/`+crateName),
		s("crate_file", `/crates/`+crateName+`/`+crateName+`-`+crateVer+`\.crate`),
		s("api_download", `/api/v1/crates/`+crateName+`/`+crateVer+`/download`),
		// cargo's download path on the static host (the crates.io index's `dl` template).
		s("crate_download", `/crates/`+crateName+`/`+crateVer+`/download`),
	},
	RubyGems: {
		s("versions", `/versions`),
		s("info", `/info/`+gemName),
		s("names", `/names`),
		s("gem", `/gems/`+gemFile+`\.gem`),
		s("gemspec", `/quick/Marshal\.4\.8/`+gemFile+`\.gemspec\.rz`),
		s("specs", `/(specs|latest_specs|prerelease_specs)\.4\.8\.gz`),
	},
}

// BuiltinHosts are the well-known public registry hosts and their kinds. They don't allow
// anything on their own — only the configured allowlists do — but when one of them is
// allowlisted, registry rules always apply to it, and the configuration may not declare it as a
// different kind.
var BuiltinHosts = map[string]Kind{
	"registry.npmjs.org":     NPM,
	"registry.yarnpkg.com":   NPM,
	"pypi.org":               PyPI,
	"files.pythonhosted.org": PyPI,
	"index.crates.io":        Crates,
	"static.crates.io":       Crates,
	"crates.io":              Crates,
	"rubygems.org":           RubyGems,
	"index.rubygems.org":     RubyGems,
}

// ShapeNames lists a kind's built-in shape names, sorted; nil for an unknown kind.
func ShapeNames(k Kind) []string {
	list, ok := kinds[k]
	if !ok {
		return nil
	}
	out := make([]string, len(list))
	for i, sh := range list {
		out[i] = sh.name
	}
	sort.Strings(out)
	return out
}

// Spec is one registry host's rules: its kind and the subset of that kind's shapes it allows
// (nil means every built-in shape of the kind).
type Spec struct {
	Kind   Kind
	Shapes []string
}

// Validate checks that spec only narrows the built-in rules for host (already normalised).
func Validate(host string, spec Spec) error {
	shapes, ok := kinds[spec.Kind]
	if !ok {
		return fmt.Errorf("registry %q: unknown kind %q (built-in kinds: npm, pypi, crates, rubygems)", host, spec.Kind)
	}
	if builtin, ok := BuiltinHosts[host]; ok && builtin != spec.Kind {
		return fmt.Errorf("registry %q is a built-in %s registry; it can't be declared as %q", host, builtin, spec.Kind)
	}
	if spec.Shapes == nil {
		return nil
	}
	if len(spec.Shapes) == 0 {
		return fmt.Errorf("registry %q: shapes is empty (omit it for every built-in shape, or leave the host out of the allowlists)", host)
	}
	known := make(map[string]bool, len(shapes))
	for _, sh := range shapes {
		known[sh.name] = true
	}
	seen := make(map[string]bool, len(spec.Shapes))
	for _, name := range spec.Shapes {
		if !known[name] {
			return fmt.Errorf("registry %q: shape %q is not a built-in %s shape (the configuration may only remove shapes: %s)", host, name, spec.Kind, strings.Join(ShapeNames(spec.Kind), ", "))
		}
		if seen[name] {
			return fmt.Errorf("registry %q: duplicate shape %q", host, name)
		}
		seen[name] = true
	}
	return nil
}

type hostRules struct {
	shapes []shape
}

// Rules applies the registry rules to requests for registry hosts, and counts them.
type Rules struct {
	hosts map[string]hostRules
	cap   int64
	count atomic.Int64
}

// NewRules builds the rules for validated specs. limit is the per-job request cap.
func NewRules(specs map[string]Spec, limit int) (*Rules, error) {
	r := &Rules{hosts: make(map[string]hostRules, len(specs)), cap: int64(limit)}
	for host, spec := range specs {
		if err := Validate(host, spec); err != nil {
			return nil, err
		}
		all := kinds[spec.Kind]
		var chosen []shape
		if spec.Shapes == nil {
			chosen = all
		} else {
			want := make(map[string]bool, len(spec.Shapes))
			for _, n := range spec.Shapes {
				want[n] = true
			}
			for _, sh := range all {
				if want[sh.name] {
					chosen = append(chosen, sh)
				}
			}
		}
		r.hosts[host] = hostRules{shapes: chosen}
	}
	return r, nil
}

// IsRegistry reports whether host is subject to registry rules.
func (r *Rules) IsRegistry(host string) bool {
	_, ok := r.hosts[host]
	return ok
}

// Count is the number of registry requests admitted so far (including the one refused at the
// cap, which is counted).
func (r *Rules) Count() int64 { return r.count.Load() }

// Check applies the rules to one request for a registry host. It returns 0 and "" when the
// request is allowed (and counted), else the HTTP status and log reason. The caller has already
// checked that r.RequestURI is origin-form.
func (r *Rules) Check(host string, req *http.Request) (int, string) {
	hr, ok := r.hosts[host]
	if !ok {
		return 0, ""
	}
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		return http.StatusMethodNotAllowed, ReasonMethod
	}
	target := req.RequestURI
	if strings.Contains(target, "?") || req.URL.RawQuery != "" || req.URL.ForceQuery {
		return http.StatusForbidden, ReasonQuery
	}
	if req.ContentLength != 0 || len(req.TransferEncoding) > 0 || req.Header.Get("Transfer-Encoding") != "" {
		return http.StatusForbidden, ReasonBody
	}
	if len(target) > MaxTarget {
		return http.StatusRequestURITooLong, ReasonPathLength
	}
	if !cleanPath(target) {
		return http.StatusForbidden, ReasonPath
	}
	matched := false
	for _, sh := range hr.shapes {
		if sh.re.MatchString(target) {
			matched = true
			break
		}
	}
	if !matched {
		return http.StatusForbidden, ReasonPathShape
	}
	if r.count.Add(1) > r.cap {
		return http.StatusTooManyRequests, ReasonCap
	}
	return 0, ""
}

// cleanPath refuses "." and ".." segments, empty segments ("//"), a fragment, and any
// percent-escape except the npm scope separator %2f/%2F.
func cleanPath(target string) bool {
	if !strings.HasPrefix(target, "/") || strings.Contains(target, "//") || strings.Contains(target, "#") {
		return false
	}
	for _, seg := range strings.Split(target[1:], "/") {
		if seg == "." || seg == ".." {
			return false
		}
	}
	for i := 0; i < len(target); i++ {
		if target[i] != '%' {
			continue
		}
		if i+2 >= len(target) || target[i+1] != '2' || (target[i+2] != 'f' && target[i+2] != 'F') {
			return false
		}
	}
	return true
}
