package bundle

import (
	"bytes"
	"regexp"
)

// Secret shapes in a bundle's files (platform secrets.ts, decision G10): distinctive,
// length-bounded prefixes only. The platform's regular expressions use lookbehind (and one
// lookahead), which Go's RE2 lacks, so each shape is matched by hand here. Scanning bytes is
// equivalent to the platform scanning the decoded text (or, for non-UTF-8 data, its latin1
// reading): every pattern character is ASCII, so a non-ASCII character (one UTF-16 unit there,
// several bytes ≥ 0x80 here) never matches a class and never counts as a boundary-breaking
// character, and a leading BOM the platform's decoder drops is three such bytes.

// boundary is the platform's B: (?<![A-Za-z0-9_-]).
func boundaryChar(c byte) bool { return alnum(c) || c == '_' || c == '-' }

func alnum(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
}

func upperDigit(c byte) bool { return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') }

// run counts the bytes from i on that satisfy class.
func run(b []byte, i int, class func(byte) bool) int {
	n := 0
	for i+n < len(b) && class(b[i+n]) {
		n++
	}
	return n
}

type shape struct {
	name  string
	first string // the bytes a match can start with
	// at reports a match starting at i (the boundary before i is already checked).
	at func(b []byte, i int) bool
}

func prefixRun(prefixes []string, min int, class func(byte) bool) func([]byte, int) bool {
	return func(b []byte, i int) bool {
		for _, p := range prefixes {
			if bytes.HasPrefix(b[i:], []byte(p)) && run(b, i+len(p), class) >= min {
				return true
			}
		}
		return false
	}
}

var privateKey = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)

// shapes in the platform's order. `sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}` is `sk-` plus 20 class
// characters: the optional prefixes are themselves class characters.
var shapes = []shape{
	{"openai_or_anthropic_key", "s", prefixRun([]string{"sk-"}, 20, boundaryChar)},
	{"stripe_key", "s", prefixRun([]string{"sk_live_", "sk_test_"}, 16, alnum)},
	{"github_token", "g", prefixRun([]string{"ghp_", "gho_", "ghu_", "ghs_", "ghr_"}, 36, alnum)},
	{"github_pat", "g", prefixRun([]string{"github_pat_"}, 22, func(c byte) bool { return alnum(c) || c == '_' })},
	{"slack_token", "x", prefixRun([]string{"xoxa-", "xoxb-", "xoxp-", "xoxr-", "xoxs-"}, 10, func(c byte) bool { return alnum(c) || c == '-' })},
	// AKIA[0-9A-Z]{16}(?![0-9A-Z]): exactly sixteen, then no seventeenth.
	{"aws_access_key", "A", func(b []byte, i int) bool {
		return bytes.HasPrefix(b[i:], []byte("AKIA")) && run(b, i+4, upperDigit) == 16
	}},
	{"kete_key", "k", prefixRun([]string{"kete_live_", "kete_test_"}, 20, boundaryChar)},
	{"gitlab_token", "g", prefixRun([]string{"glpat-"}, 20, boundaryChar)},
	{"google_api_key", "A", prefixRun([]string{"AIza"}, 35, boundaryChar)},
	// eyJ[cls]{10,}\.eyJ[cls]{10,}\.[cls]{10,}: '.' is outside the class, so each run is maximal.
	{"jwt", "e", func(b []byte, i int) bool {
		seg := func(at int) (int, bool) {
			if !bytes.HasPrefix(b[at:], []byte("eyJ")) {
				return 0, false
			}
			n := run(b, at+3, boundaryChar)
			if n < 10 || at+3+n >= len(b) || b[at+3+n] != '.' {
				return 0, false
			}
			return at + 3 + n + 1, true
		}
		at, ok := seg(i)
		if !ok {
			return false
		}
		if at, ok = seg(at); !ok {
			return false
		}
		return run(b, at, boundaryChar) >= 10
	}},
}

// FindSecretShape returns the name of the first secret shape in b (the platform's order), or "".
func FindSecretShape(b []byte) string {
	for _, s := range shapes {
		for i := range b {
			if b[i] != s.first[0] || (i > 0 && boundaryChar(b[i-1])) {
				continue
			}
			if s.at(b, i) {
				return s.name
			}
		}
	}
	if privateKey.Match(b) {
		return "private_key"
	}
	return ""
}
