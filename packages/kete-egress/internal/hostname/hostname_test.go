package hostname

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalize(t *testing.T) {
	ok := map[string]string{
		"github.com":         "github.com",
		"API.GitHub.com":     "api.github.com",
		"registry.npmjs.org": "registry.npmjs.org",
		"xn--bcher-kva.de":   "xn--bcher-kva.de",
		"a-b.c0.test":        "a-b.c0.test",
		"localhost":          "localhost",
		"1a.example":         "1a.example",
	}
	for in, want := range ok {
		got, err := Normalize(in)
		if err != nil || got != want {
			t.Errorf("Normalize(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	bad := []string{
		"",
		"github.com.",
		"bücher.de",
		"127.0.0.1",
		"10.1",
		"2130706433",
		"::1",
		"fe80::1",
		"a..b",
		".a",
		"a_b.com",
		"a b.com",
		"a:443",
		"a/b",
		"a%2eb",
		strings.Repeat("a", 64) + ".com",
		strings.Repeat("a.", 127) + "ab",
	}
	for _, in := range bad {
		if got, err := Normalize(in); err == nil {
			t.Errorf("Normalize(%q) = %q, want an error", in, got)
		}
	}
	// The longest names allowed.
	if _, err := Normalize(strings.Repeat("a", 63) + ".com"); err != nil {
		t.Errorf("63-byte label refused: %v", err)
	}
	long := strings.Repeat("a.", 126) + "a" // 253 bytes
	if len(long) != 253 {
		t.Fatalf("setup: %d", len(long))
	}
	if _, err := Normalize(long); err != nil {
		t.Errorf("253-byte name refused: %v", err)
	}
}

func TestAuthority(t *testing.T) {
	h, err := Authority("GitHub.com:443")
	if err != nil || h != "github.com" {
		t.Fatalf("Authority = %q, %v", h, err)
	}
	if _, err := Authority("github.com:80"); !errors.Is(err, ErrPort) {
		t.Errorf("port 80: %v, want ErrPort", err)
	}
	for _, in := range []string{"github.com", "[::1]:443", "127.0.0.1:443", ":443", "github.com.:443", "github.com:443:443"} {
		if _, err := Authority(in); err == nil {
			t.Errorf("Authority(%q) accepted", in)
		}
	}
}

func TestHostHeader(t *testing.T) {
	for in, want := range map[string]string{"a.test": "a.test", "A.test:443": "a.test"} {
		got, err := HostHeader(in)
		if err != nil || got != want {
			t.Errorf("HostHeader(%q) = %q, %v", in, got, err)
		}
	}
	for _, in := range []string{"a.test:8443", "a.test:", "[::1]", "[::1]:443", "1.2.3.4", ""} {
		if _, err := HostHeader(in); err == nil {
			t.Errorf("HostHeader(%q) accepted", in)
		}
	}
}

func TestEntryForms(t *testing.T) {
	for in, want := range map[string]string{"gitlab.corp.example:8443": "gitlab.corp.example:8443", "a.example:443": "a.example", "A.Example:443": "a.example"} {
		got, host, err := AuthorityEntry(in)
		if err != nil || got != want || host == "" {
			t.Errorf("AuthorityEntry(%q) = %q %q %v", in, got, host, err)
		}
	}
	for _, bad := range []string{"a.example:0", "a.example:08443", "a.example:65536", "10.0.0.1:443", "a.example"} {
		if _, _, err := AuthorityEntry(bad); err == nil {
			t.Errorf("AuthorityEntry(%q) accepted", bad)
		}
	}
	for in, want := range map[string]string{"a.example": "a.example", "a.example:443": "a.example", "a.example:8443": "a.example:8443"} {
		if got, err := HostHeaderEntry(in); err != nil || got != want {
			t.Errorf("HostHeaderEntry(%q) = %q %v", in, got, err)
		}
	}
	if _, err := HostHeaderEntry("[::1]:443"); err == nil {
		t.Error("an IP literal Host was accepted")
	}
}
