package bundle

import (
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// Bundle path rules (platform paths.ts; ADR 0021 rule 6): git's verify_path with core.protectHFS
// and core.protectNTFS, stricter where cheap. One fold serves protected names and case
// collisions: strip the HFS-ignorable code points and NTFS trailing dots and spaces, then
// case-fold as JavaScript's toUpperCase().toLowerCase() (full Unicode case mappings, so ß and SS
// meet).

// ProtectedNames are folded names refused as any component.
var ProtectedNames = []string{".git", ".kete", ".gitmodules", "kete.json", "kete.jsonc"}

// CIDirs are folded CI directories, refused as any non-final component.
var CIDirs = []string{".circleci", ".azure-pipelines", ".buildkite", ".woodpecker", ".teamcity", ".harness"}

// CIFiles are folded CI files, refused as any final component.
var CIFiles = []string{".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "jenkinsfile", ".drone.yml", ".woodpecker.yml", "appveyor.yml", "cloudbuild.yaml"}

// hfsIgnorable is git's is_hfs_dot_generic set: U+200C–U+200F, U+202A–U+202E, U+206A–U+206F,
// U+FEFF.
func hfsIgnorable(r rune) bool {
	return (r >= 0x200c && r <= 0x200f) || (r >= 0x202a && r <= 0x202e) || (r >= 0x206a && r <= 0x206f) || r == 0xfeff
}

// Fold is the one fold for protected names and collisions (platform `fold`).
func Fold(component string) string {
	s := strings.Map(func(r rune) rune {
		if hfsIgnorable(r) {
			return -1
		}
		return r
	}, component)
	s = strings.TrimRight(s, ". ")
	// A Caser keeps state: one per call (Fold runs concurrently).
	return cases.Lower(language.Und).String(cases.Upper(language.Und).String(s))
}

// isShortName is /^[^.~]{1,6}~[0-9]+(\.[^.]{0,3})?$/ matched as JavaScript does without the u
// flag: over UTF-16 code units.
func isShortName(name string) bool {
	u := utf16.Encode([]rune(name))
	i := 0
	for i < len(u) && u[i] != '.' && u[i] != '~' {
		i++
	}
	if i < 1 || i > 6 || i >= len(u) || u[i] != '~' {
		return false
	}
	i++
	d := i
	for i < len(u) && u[i] >= '0' && u[i] <= '9' {
		i++
	}
	if i == d {
		return false
	}
	if i == len(u) {
		return true
	}
	if u[i] != '.' {
		return false
	}
	rest := u[i+1:]
	return len(rest) <= 3 && !slices.Contains(rest, '.')
}

// CheckPath is "" when the bundle path is acceptable, else invalid_path, protected_path or
// ci_path. A path holding a lone surrogate (the manifest parser keeps one as WTF-8) is not valid
// UTF-8 and so invalid_path, as in the platform.
func CheckPath(path string) string {
	if path == "" || !utf8.ValidString(path) || norm.NFC.String(path) != path {
		return "invalid_path"
	}
	if len(path) > 4096 {
		return "invalid_path"
	}
	for i := 0; i < len(path); i++ {
		if c := path[i]; c < 0x20 || c == 0x7f || c == '\\' || c == ':' {
			return "invalid_path"
		}
	}
	if path[0] == '/' || path[len(path)-1] == '/' {
		return "invalid_path"
	}
	components := strings.Split(path, "/")
	for _, c := range components {
		if c == "" || c == "." || c == ".." || len(c) > 255 {
			return "invalid_path"
		}
	}
	folded := make([]string, len(components))
	for i, c := range components {
		folded[i] = Fold(c)
	}
	for _, name := range folded {
		if slices.Contains(ProtectedNames, name) || isShortName(name) {
			return "protected_path"
		}
		if name == "" {
			return "invalid_path"
		}
	}
	if folded[0] == ".github" {
		return "protected_path"
	}
	for _, name := range folded[:len(folded)-1] {
		if slices.Contains(CIDirs, name) {
			return "ci_path"
		}
	}
	if slices.Contains(CIFiles, folded[len(folded)-1]) {
		return "ci_path"
	}
	return ""
}

// foldPath folds each component of a path.
func foldPath(path string) string {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		parts[i] = Fold(p)
	}
	return strings.Join(parts, "/")
}
