// Package hostname is the one normalisation every host name in the proxy goes through: the
// config's allowlists, the CONNECT authority, the TLS SNI and every request's Host (module README
// "Security model"). Hosts then compare by exact string equality; there are no wildcards.
package hostname

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

const (
	maxName  = 253
	maxLabel = 63
)

// ErrPort is returned by Authority when the authority names a port other than 443.
var ErrPort = errors.New("port is not 443")

// Normalize lowercases ASCII and refuses anything that isn't a plain DNS name: an empty name,
// non-ASCII (IDNs must arrive as punycode), a trailing dot, an IP literal, an empty label, a label
// longer than 63 bytes, a name longer than 253 bytes, and characters outside [a-z0-9.-].
func Normalize(name string) (string, error) {
	if name == "" {
		return "", errors.New("empty host name")
	}
	if len(name) > maxName {
		return "", fmt.Errorf("host name longer than %d bytes", maxName)
	}
	b := []byte(name)
	for i, c := range b {
		switch {
		case c >= 'A' && c <= 'Z':
			b[i] = c + ('a' - 'A')
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '-':
		default:
			return "", fmt.Errorf("host name %q has a character outside [a-z0-9.-]", name)
		}
	}
	out := string(b)
	if strings.HasSuffix(out, ".") {
		return "", fmt.Errorf("host name %q has a trailing dot", name)
	}
	if _, err := netip.ParseAddr(out); err == nil || net.ParseIP(out) != nil || looksNumeric(out) {
		return "", fmt.Errorf("host name %q is an IP literal", name)
	}
	for _, label := range strings.Split(out, ".") {
		if label == "" {
			return "", fmt.Errorf("host name %q has an empty label", name)
		}
		if len(label) > maxLabel {
			return "", fmt.Errorf("host name %q has a label longer than %d bytes", name, maxLabel)
		}
	}
	return out, nil
}

// looksNumeric refuses names whose last label is all digits: inet_aton-style forms such as
// "127.1" or "2130706433" that some resolvers and clients treat as IPv4 addresses.
func looksNumeric(name string) bool {
	last := name
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		last = name[i+1:]
	}
	if last == "" {
		return false
	}
	for _, c := range last {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// Authority parses a CONNECT authority, which must be exactly "host:443", and returns the
// normalised host. A port other than 443 returns ErrPort (wrapped).
func Authority(authority string) (string, error) {
	host, port, err := net.SplitHostPort(authority)
	if err != nil {
		return "", fmt.Errorf("authority %q: %w", authority, err)
	}
	h, err := Normalize(host)
	if err != nil {
		return "", err
	}
	if port != "443" {
		return "", fmt.Errorf("authority %q: %w", authority, ErrPort)
	}
	return h, nil
}

// HostHeader normalises a request's Host value: a bare name, or "name:443". Any other port is
// refused.
func HostHeader(value string) (string, error) {
	if strings.ContainsAny(value, "[]") {
		return "", fmt.Errorf("host %q is an IP literal", value)
	}
	if i := strings.LastIndexByte(value, ':'); i >= 0 {
		if value[i+1:] != "443" {
			return "", fmt.Errorf("host %q: %w", value, ErrPort)
		}
		value = value[:i]
	}
	return Normalize(value)
}

// Entry is the allowlist spelling of a host and port (configuration v2): the bare host for 443,
// `host:port` otherwise.
func Entry(host string, port uint16) string {
	if port == 443 {
		return host
	}
	return host + ":" + strconv.Itoa(int(port))
}

// parsePort accepts 1-65535 without a leading zero.
func parsePort(s string) (uint16, error) {
	if s == "" || len(s) > 5 || s[0] == '0' {
		return 0, fmt.Errorf("port %q: %w", s, ErrPort)
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > 65535 {
		return 0, fmt.Errorf("port %q: %w", s, ErrPort)
	}
	return uint16(n), nil
}

// AuthorityEntry is Authority for configuration v2: a CONNECT authority `host:port` with any port
// 1-65535, returned as its allowlist spelling (Entry) and its host.
func AuthorityEntry(authority string) (entry, host string, err error) {
	h, p, err := net.SplitHostPort(authority)
	if err != nil {
		return "", "", fmt.Errorf("authority %q: %w", authority, err)
	}
	if host, err = Normalize(h); err != nil {
		return "", "", err
	}
	port, err := parsePort(p)
	if err != nil {
		return "", "", err
	}
	return Entry(host, port), host, nil
}

// HostHeaderEntry is HostHeader for configuration v2: `host` (443) or `host:port`, returned as
// its allowlist spelling (`host:443` is the bare host).
func HostHeaderEntry(value string) (string, error) {
	if strings.ContainsAny(value, "[]") {
		return "", fmt.Errorf("host %q is an IP literal", value)
	}
	port := uint16(443)
	if i := strings.LastIndexByte(value, ':'); i >= 0 {
		p, err := parsePort(value[i+1:])
		if err != nil {
			return "", err
		}
		port, value = p, value[:i]
	}
	h, err := Normalize(value)
	if err != nil {
		return "", err
	}
	return Entry(h, port), nil
}
