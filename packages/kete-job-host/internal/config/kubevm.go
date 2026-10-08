package config

// The kubevm pod driver's configuration (enterprise runtime P2): where each repository is cloned
// from, the job pods' size and outbox, and the internal destinations their egress may reach.

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

var quantityRe = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$`)

// forbidden are egress configuration v2's forbidden ranges (packages/kete-egress
// internal/blocked.Forbidden; docs/platform/egress-config-v2.md): no internal range may touch one.
var forbidden = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{"0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "168.63.129.16/32", "100.100.100.200/32",
		"224.0.0.0/4", "240.0.0.0/4", "::/96", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48",
		"2002::/16", "fe80::/10", "fd00:ec2::254/128", "ff00::/8"} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// ValidInternalCIDR is egress configuration v2's internal range rule: canonical, at least /8
// (IPv4) or /32 (IPv6), touching no forbidden range.
func ValidInternalCIDR(s string) bool {
	p, err := netip.ParsePrefix(s)
	if err != nil || p.Masked() != p || p.String() != s || p.Addr().Zone() != "" {
		return false
	}
	if (p.Addr().Is4() && p.Bits() < 8) || (!p.Addr().Is4() && p.Bits() < 32) {
		return false
	}
	for _, f := range forbidden {
		if f.Addr().Is4() == p.Addr().Is4() && f.Overlaps(p) {
			return false
		}
	}
	return true
}

// ValidCloneURL is a kubevm clone URL: https, a plain DNS host, an optional port, a path; no
// userinfo, query or fragment (the credential comes from a Secret, never the URL).
func ValidCloneURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || u.ForceQuery {
		return false
	}
	h := u.Hostname()
	if len(h) > 253 || !hostRe.MatchString(h) {
		return false
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 || p[0] == '0' {
			return false
		}
	}
	// As the entrypoint's CloneTarget: no `..` in the escaped path.
	return u.Path != "" && u.Path != "/" && !strings.Contains(u.EscapedPath(), "..")
}

func parseKubeVM(f KubernetesFile, k *Kubernetes) error {
	if k.PodDriver != PodDriverKubeVM {
		if f.JobPod != nil || len(f.RepositorySources) > 0 {
			return errors.New("config: job_pod and repository_sources are for the kubevm pod driver")
		}
		return nil
	}
	if f.JobPod == nil {
		return errors.New("config: the kubevm pod driver needs job_pod")
	}
	if k.Proxy != nil {
		// kete-egress configuration v2 takes a DNS name or an IPv4 literal for its upstream proxy.
		if a, err := netip.ParseAddr(k.Proxy.Hostname()); err == nil && !a.Is4() {
			return errors.New("config: the kubevm pod driver's jobs need a proxy named by DNS or an IPv4 address (egress configuration v2)")
		}
	}
	jp := f.JobPod
	for name, q := range map[string]string{"cpu": jp.CPU, "memory": jp.Memory, "ephemeral_storage": jp.EphemeralStorage, "outbox_size": jp.OutboxSize} {
		if !quantityRe.MatchString(q) {
			return fmt.Errorf("config: job_pod %s %q is not a Kubernetes quantity", name, q)
		}
	}
	if jp.OutboxStorageClass != "" && !contract.ValidKubernetesName(jp.OutboxStorageClass) {
		return errors.New("config: job_pod outbox_storage_class is not a valid name")
	}
	mode := jp.OutboxAccessMode
	switch mode {
	case "":
		mode = "ReadWriteOncePod"
	case "ReadWriteOncePod", "ReadWriteOnce":
	default:
		return errors.New("config: job_pod outbox_access_mode must be ReadWriteOncePod or ReadWriteOnce")
	}
	hold := 24
	if jp.OutboxHoldHours != 0 {
		if jp.OutboxHoldHours < 1 || jp.OutboxHoldHours > 720 {
			return errors.New("config: job_pod outbox_hold_hours must be 1-720")
		}
		hold = jp.OutboxHoldHours
	}
	if len(jp.Internal) > 32 {
		return errors.New("config: job_pod internal: at most 32 ranges")
	}
	var seen []netip.Prefix
	for _, r := range jp.Internal {
		if !ValidInternalCIDR(r.CIDR) {
			return fmt.Errorf("config: job_pod internal %q: not canonical, broader than /8 (/32 for IPv6) or touching a forbidden range", r.CIDR)
		}
		p := netip.MustParsePrefix(r.CIDR)
		for _, o := range seen {
			if o.Overlaps(p) {
				return fmt.Errorf("config: job_pod internal %q overlaps another range", r.CIDR)
			}
		}
		seen = append(seen, p)
		if len(r.Ports) < 1 || len(r.Ports) > 16 {
			return fmt.Errorf("config: job_pod internal %q needs 1-16 ports", r.CIDR)
		}
		for i, port := range r.Ports {
			if port < 1 || port > 65535 || slices.Contains(r.Ports[:i], port) {
				return fmt.Errorf("config: job_pod internal %q: port %d is invalid or repeated", r.CIDR, port)
			}
		}
	}
	k.JobPod = &JobPod{
		CPU: jp.CPU, Memory: jp.Memory, EphemeralStorage: jp.EphemeralStorage, OutboxSize: jp.OutboxSize,
		OutboxStorageClass: jp.OutboxStorageClass, OutboxAccessMode: mode, OutboxHold: time.Duration(hold) * time.Hour, Internal: jp.Internal,
	}
	k.Sources = map[string]RepositorySourceFile{}
	for _, src := range f.RepositorySources {
		if !slices.Contains(k.Repositories, src.Name) || k.Sources[src.Name].Name != "" {
			return fmt.Errorf("config: repository source %q names no served repository, or repeats one", src.Name)
		}
		if !ValidCloneURL(src.CloneURL) || !contract.ValidKubernetesName(src.CloneSecret) {
			return fmt.Errorf("config: repository source %q: clone_url must be https://host[:port]/path and clone_secret a Secret name", src.Name)
		}
		k.Sources[src.Name] = src
	}
	for _, r := range k.Repositories {
		if _, ok := k.Sources[r]; !ok {
			return fmt.Errorf("config: repository %q has no repository source (the kubevm pod driver clones only from a configured source)", r)
		}
	}
	return nil
}

// InternalOverlaps returns the first internal range containing an address, or "".
func InternalOverlaps(ranges []InternalRangeFile, addrs []netip.Addr) string {
	for _, r := range ranges {
		p, err := netip.ParsePrefix(r.CIDR)
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if p.Contains(a.Unmap()) {
				return r.CIDR
			}
		}
	}
	return ""
}

// InternalOverlapsPrefix returns the first internal range overlapping a prefix, or "".
func InternalOverlapsPrefix(ranges []InternalRangeFile, prefixes []netip.Prefix) string {
	for _, r := range ranges {
		p, err := netip.ParsePrefix(r.CIDR)
		if err != nil {
			continue
		}
		for _, q := range prefixes {
			if p.Overlaps(q) {
				return r.CIDR
			}
		}
	}
	return ""
}
