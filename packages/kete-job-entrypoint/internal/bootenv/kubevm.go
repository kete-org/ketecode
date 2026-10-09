package bootenv

// The kubevm machine configuration (module README "kubevm"; enterprise runtime spec §4.5 and
// Appendix A "entrypoint machine config"): the Kubernetes runner writes it into the per-job
// Secret as config.json — the platform's sealed fields, the node's boot ID, and a local section
// that never comes from or goes to the platform (the repository the runner resolved, its clone
// credential, the data boundary, the enterprise proxy, CA bundle and internal ranges, the node's
// addresses for the host-boundary probe). The entrypoint reads it with --config-file.

import (
	"crypto/x509"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
)

// Limits of the kubevm configuration. The whole configuration crosses the boot handover pipe in
// one write, so it stays below a pipe's 64 KiB.
const (
	MaxKubeVMConfig = 48 << 10
	maxCABundle     = 32 << 10
	maxProxyAuth    = 1024
	maxNodeAddrs    = 16
	maxInternal     = 32
	maxInternalPort = 16
)

// Local is the kubevm configuration's local section.
type Local struct {
	Repository LocalRepository `json:"repository"`
	Boundary   LocalBoundary   `json:"boundary"`
	Egress     *LocalEgress    `json:"egress,omitempty"`
	// NodeAddresses are the node's addresses (Node.status.addresses), probed on sample ports by
	// the host-boundary probe and the isolation check: none may answer.
	NodeAddresses []string `json:"node_addresses,omitempty"`
	// SharedKernelTest asks for the test-only shared-kernel mode (kind CI). A release build
	// refuses the configuration (ValidateLocal); a kete_testdriver build then requires the pod's
	// boot ID to equal the node's (hostprofile.KubeVMKernel).
	SharedKernelTest bool `json:"shared_kernel_test,omitempty"`
}

// LocalRepository is the repository the runner looked up for this machine: the claim must name
// exactly Name (jobs-v1 "Fail closed (kubevm)"); the entrypoint clones CloneURL at Ref with the
// read credential and records the commit it got as the job's base.
type LocalRepository struct {
	Name     string `json:"name"`
	CloneURL string `json:"clone_url"`
	Ref      string `json:"ref"`
	Username string `json:"username"`
	Token    string `json:"token"`
	// BaseSHA is the commit the runner resolved Ref to before starting the pod (P3): the job
	// works on exactly it ("" from an older runner: the clone's head is the base).
	BaseSHA string `json:"base_sha,omitempty"`
}

// LocalBoundary is the runner's effective data boundary (JobDataBoundary).
type LocalBoundary struct {
	Summary     string `json:"summary"`
	Denials     string `json:"denials"`
	PublishRefs string `json:"publish_refs"`
}

// LocalEgress is the enterprise network: the upstream proxy (http(s)://host:port, optional
// `username:password`), extra roots for upstream TLS, and the internal ranges (egress
// configuration v2) — the same ranges the runner's NetworkPolicy opens.
type LocalEgress struct {
	Proxy     string          `json:"proxy,omitempty"`
	ProxyAuth string          `json:"proxy_auth,omitempty"`
	CABundle  string          `json:"ca_bundle,omitempty"`
	Internal  []InternalRange `json:"internal,omitempty"`
}

// InternalRange is one egress configuration v2 `internal` entry.
type InternalRange struct {
	CIDR  string `json:"cidr"`
	Ports []int  `json:"ports"`
}

var (
	runtimeRepoNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,19}:[A-Za-z0-9_][A-Za-z0-9._-]*(?:/[A-Za-z0-9_][A-Za-z0-9._-]*)*$`)
	gitRefCharsRe     = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,255}$`)
	gitRefBadRe       = regexp.MustCompile(`(^[-/.]|/$|\.$|//|\.\.|/\.|\.lock(/|$)|@\{)`)
	proxyURLRe        = regexp.MustCompile(`^https?://[a-z0-9.-]+:[1-9][0-9]{0,4}$`)
)

// ValidRuntimeRepoName is jobs-v1 JobRuntimeRepoName (internal/platform has the same rule).
func ValidRuntimeRepoName(s string) bool { return len(s) <= 200 && runtimeRepoNameRe.MatchString(s) }

func validGitRef(s string) bool { return gitRefCharsRe.MatchString(s) && !gitRefBadRe.MatchString(s) }

func printableASCII(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

func printableNoColon(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e || s[i] == ':' {
			return false
		}
	}
	return true
}

// CloneTarget checks a kubevm clone URL — https, a plain DNS host, an optional port 1-65535, a
// path, no userinfo, query, fragment or `..` — and returns it with its egress allowlist entry
// (the bare host for 443, `host:port` otherwise).
func CloneTarget(raw string) (string, string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return "", "", errors.New("clone_url must be https without userinfo, query or fragment")
	}
	host := u.Hostname()
	if !ValidHost(host) {
		return "", "", errors.New("clone_url must name a plain DNS host")
	}
	entry := host
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 || p[0] == '0' {
			return "", "", errors.New("clone_url has an invalid port")
		}
		if n != 443 {
			entry = host + ":" + p
		}
	}
	path := u.EscapedPath()
	if path == "" || path == "/" || strings.Contains(path, "..") {
		return "", "", errors.New("clone_url must carry a repository path without ..")
	}
	return "https://" + entry + path, entry, nil
}

// ValidateLocal checks the local section.
func ValidateLocal(l *Local) error {
	if l == nil {
		return errors.New("local section missing")
	}
	r := l.Repository
	if !ValidRuntimeRepoName(r.Name) {
		return errors.New("local.repository.name")
	}
	if _, _, err := CloneTarget(r.CloneURL); err != nil {
		return fmt.Errorf("local.repository: %w", err)
	}
	if !validGitRef(r.Ref) {
		return errors.New("local.repository.ref")
	}
	if !printableNoColon(r.Username, 128) {
		return errors.New("local.repository.username")
	}
	if !printableASCII(r.Token, 4096) {
		return errors.New("local.repository.token")
	}
	if r.BaseSHA != "" && (len(r.BaseSHA) != 40 || strings.Trim(r.BaseSHA, "0123456789abcdef") != "") {
		return errors.New("local.repository.base_sha")
	}
	b := l.Boundary
	if !slices.Contains([]string{"none", "redacted", "full"}, b.Summary) || !slices.Contains([]string{"count", "actions", "full"}, b.Denials) || !slices.Contains([]string{"omit", "send"}, b.PublishRefs) {
		return errors.New("local.boundary")
	}
	if e := l.Egress; e != nil {
		if e.Proxy != "" && !proxyURLRe.MatchString(e.Proxy) {
			return errors.New("local.egress.proxy must be http(s)://host:port")
		}
		if e.ProxyAuth != "" {
			i := strings.IndexByte(e.ProxyAuth, ':')
			if e.Proxy == "" || i < 1 || len(e.ProxyAuth) > maxProxyAuth || strings.ContainsAny(e.ProxyAuth, "\r\n") {
				return errors.New("local.egress.proxy_auth must be username:password with a proxy")
			}
		}
		if e.CABundle != "" {
			if len(e.CABundle) > maxCABundle || !x509.NewCertPool().AppendCertsFromPEM([]byte(e.CABundle)) {
				return errors.New("local.egress.ca_bundle must hold PEM certificates (at most 32 KiB)")
			}
			if e.Proxy == "" {
				// kete-egress configuration v2 carries the bundle with the upstream proxy only.
				return errors.New("local.egress.ca_bundle needs a proxy")
			}
		}
		if len(e.Internal) > maxInternal {
			return errors.New("local.egress.internal: too many ranges")
		}
		for _, r := range e.Internal {
			p, err := netip.ParsePrefix(r.CIDR)
			if err != nil || p.Masked() != p || len(r.Ports) < 1 || len(r.Ports) > maxInternalPort {
				return errors.New("local.egress.internal: a range is not a canonical CIDR with 1-16 ports")
			}
			for _, port := range r.Ports {
				if port < 1 || port > 65535 {
					return errors.New("local.egress.internal: a port is not 1-65535")
				}
			}
		}
	}
	if len(l.NodeAddresses) > maxNodeAddrs {
		return errors.New("local.node_addresses: too many")
	}
	for _, a := range l.NodeAddresses {
		ad, err := netip.ParseAddr(a)
		if err != nil || ad.Zone() != "" || ad.String() != a {
			return errors.New("local.node_addresses: not an IP address")
		}
	}
	if l.SharedKernelTest && !hostprofile.SharedKernelTestBuild {
		return errors.New("local.shared_kernel_test: this build runs only in VM-isolated pods")
	}
	return nil
}

// validateKubeVM checks the kubevm fields: exactly for kubevm a node boot ID and a local section.
func validateKubeVM(profile, nodeBootID string, l *Local) error {
	if profile != string(hostprofile.KubeVM) {
		if nodeBootID != "" || l != nil {
			return errors.New("node_boot_id and local are only for kubevm")
		}
		return nil
	}
	if !hostprofile.ValidBootID(nodeBootID) {
		return errors.New("node_boot_id must be a boot ID")
	}
	return ValidateLocal(l)
}

// validKubeAPI checks KUBERNETES_SERVICE_HOST:PORT as the boot stage recorded it.
func validKubeAPI(s string) bool {
	if s == "" {
		return true
	}
	ap, err := netip.ParseAddrPort(s)
	return err == nil && ap.Addr().Zone() == "" && ap.Port() != 0 && ap.String() == s
}

// KubeAPIFromEnv is the Kubernetes API the kubelet names in every pod's environment
// (KUBERNETES_SERVICE_HOST/PORT, set even with enableServiceLinks off), as ip:port, or "" when
// absent or not an IP and port.
func KubeAPIFromEnv(getenv func(string) string) string {
	h, p := getenv("KUBERNETES_SERVICE_HOST"), getenv("KUBERNETES_SERVICE_PORT")
	a, err := netip.ParseAddr(h)
	n, perr := strconv.Atoi(p)
	if err != nil || perr != nil || n < 1 || n > 65535 || a.Zone() != "" {
		return ""
	}
	return netip.AddrPortFrom(a.Unmap(), uint16(n)).String()
}
