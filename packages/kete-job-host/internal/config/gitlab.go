package config

// The runner's repository registry for GitLab self-managed (enterprise runtime P3, spec §5): where
// each repository's REST API lives, how the job's read credential is obtained (a static deploy
// token, or a project access token minted per job) and which Secret the publisher's writer
// credential is in. Shared by the controller's configuration and the publisher's.

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// Clone credential modes.
const (
	// CloneStatic: a read-only deploy token (username, token) the enterprise rotates, from a Secret
	// in the controller's namespace.
	CloneStatic = "static"
	// CloneMinted: a project access token minted per job (scope read_repository, Reporter, next-day
	// expiry) with a Maintainer token from a Secret in the controller's namespace, revoked once the
	// job reports clone_done and again when its pod ends.
	CloneMinted = "minted"
	// ProviderGitLab is the only repository provider (others implement internal/repo later).
	ProviderGitLab = "gitlab"
)

var projectSegmentRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$`)

// ValidAPIURL is a GitLab instance URL: https, a plain DNS host, an optional port, an optional
// relative URL root path; no userinfo, query or fragment, no `..`.
func ValidAPIURL(raw string) bool {
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
	return !strings.Contains(u.EscapedPath(), "..") && !strings.HasSuffix(u.Path, "/")
}

// GitLabProject derives a GitLab repository's API base URL and project path from its clone URL
// (`https://host[:port]/<root>/<group>/…/<project>.git`) and, when GitLab lives under a relative
// URL root, its instance URL: the clone URL must be `<api>/<project path>.git`. Without apiURL the
// instance is the clone URL's origin.
func GitLabProject(cloneURL, apiURL string) (string, string, error) {
	if !ValidCloneURL(cloneURL) {
		return "", "", errors.New("clone_url must be https://host[:port]/path without credentials")
	}
	cu, _ := url.Parse(cloneURL)
	base := cu.Scheme + "://" + cu.Host
	if apiURL != "" {
		if !ValidAPIURL(apiURL) {
			return "", "", errors.New("api_url must be https://host[:port][/path] without credentials, query or trailing slash")
		}
		base = apiURL
	}
	bu, _ := url.Parse(base)
	if bu.Host != cu.Host {
		return "", "", errors.New("api_url and clone_url must name the same host and port")
	}
	if !strings.HasSuffix(cu.Path, ".git") || !strings.HasPrefix(cu.Path, bu.Path+"/") {
		return "", "", errors.New("clone_url must be <api_url>/<group>/…/<project>.git")
	}
	project := strings.TrimSuffix(strings.TrimPrefix(cu.Path, bu.Path+"/"), ".git")
	parts := strings.Split(project, "/")
	if len(parts) < 2 || len(parts) > 20 {
		return "", "", errors.New("the project path needs a namespace and a project (group/…/project)")
	}
	for _, p := range parts {
		if !projectSegmentRe.MatchString(p) || strings.HasSuffix(p, ".") || strings.HasSuffix(p, ".atom") {
			return "", "", fmt.Errorf("project path segment %q is not a GitLab path", p)
		}
	}
	return base, project, nil
}

// checkSourceP3 applies the P3 rules to one repository source: the provider, the clone credential
// mode and its Secret, the writer Secret's name, and the GitLab project derivation.
func checkSourceP3(src *RepositorySourceFile) error {
	if src.Provider != "" && src.Provider != ProviderGitLab {
		return fmt.Errorf("repository source %q: provider must be gitlab", src.Name)
	}
	switch src.CloneMode {
	case "", CloneStatic:
		if !contract.ValidKubernetesName(src.CloneSecret) || src.MinterSecret != "" {
			return fmt.Errorf("repository source %q: a static clone credential needs clone_secret (and no minter_secret)", src.Name)
		}
	case CloneMinted:
		if src.CloneSecret != "" || !contract.ValidKubernetesName(src.MinterSecret) {
			return fmt.Errorf("repository source %q: a minted clone credential needs minter_secret (and no clone_secret)", src.Name)
		}
	default:
		return fmt.Errorf("repository source %q: clone_mode must be static or minted", src.Name)
	}
	if src.WriterSecret != "" && !contract.ValidKubernetesName(src.WriterSecret) {
		return fmt.Errorf("repository source %q: writer_secret is not a Secret name", src.Name)
	}
	if src.CloneMode == CloneMinted || src.WriterSecret != "" || src.APIURL != "" {
		// Minting and publishing call GitLab's API: its project must be derivable.
		if _, _, err := GitLabProject(src.CloneURL, src.APIURL); err != nil {
			return fmt.Errorf("repository source %q: %w", src.Name, err)
		}
	}
	return nil
}

// PublisherFile configures the publisher pods (P3): what the controller needs to start one. The
// publisher's own configuration (repositories, proxy, CA) is a ConfigMap in the jobs namespace the
// chart renders and the controller can't change; the controller only names it.
type PublisherFile struct {
	// Image is the runner image by digest: publisher pods run it (`kete-job-host publish`).
	Image string `json:"image"`
	// ConfigMap is the publisher configuration's ConfigMap in the jobs namespace.
	ConfigMap string `json:"config_map"`
	// CASecret and ProxyAuthSecret are optional Secrets in the jobs namespace the publisher mounts
	// (the enterprise CA bundle, key ca.crt; the proxy credential, key auth).
	CASecret        string `json:"ca_secret,omitempty"`
	ProxyAuthSecret string `json:"proxy_auth_secret,omitempty"`
	CPU             string `json:"cpu,omitempty"`
	Memory          string `json:"memory,omitempty"`
	// TimeoutSeconds bounds a publisher pod (default 900).
	TimeoutSeconds int `json:"timeout_seconds,omitempty"`
}

// Publisher is the validated publisher section.
type Publisher struct {
	Image, ConfigMap, CASecret, ProxyAuthSecret string
	CPU, Memory                                 string
	TimeoutSeconds                              int
}

func parsePublisher(f *PublisherFile, needed bool) (*Publisher, error) {
	if f == nil {
		if needed {
			return nil, errors.New("config: a repository source names a writer_secret: the publisher section is required")
		}
		return nil, nil
	}
	p := &Publisher{Image: f.Image, ConfigMap: f.ConfigMap, CASecret: f.CASecret, ProxyAuthSecret: f.ProxyAuthSecret, CPU: f.CPU, Memory: f.Memory, TimeoutSeconds: f.TimeoutSeconds}
	if !contract.ValidImageRef(p.Image) {
		return nil, errors.New("config: publisher image must be the runner image by digest")
	}
	for _, n := range []string{p.ConfigMap, p.CASecret, p.ProxyAuthSecret} {
		if n != "" && !contract.ValidKubernetesName(n) {
			return nil, fmt.Errorf("config: publisher object name %q is invalid", n)
		}
	}
	if p.ConfigMap == "" {
		return nil, errors.New("config: publisher config_map is required")
	}
	if p.CPU == "" {
		p.CPU = "500m"
	}
	if p.Memory == "" {
		p.Memory = "512Mi"
	}
	if !quantityRe.MatchString(p.CPU) || !quantityRe.MatchString(p.Memory) {
		return nil, errors.New("config: publisher cpu and memory must be Kubernetes quantities")
	}
	if p.TimeoutSeconds == 0 {
		p.TimeoutSeconds = 900
	}
	if p.TimeoutSeconds < 60 || p.TimeoutSeconds > 3600 {
		return nil, errors.New("config: publisher timeout_seconds must be 60-3600")
	}
	return p, nil
}

// MatchNoProxy reports whether host is in a no-proxy list: an exact name, or `.suffix` for the
// suffix's subdomains.
func MatchNoProxy(host string, list []string) bool {
	host = strings.ToLower(host)
	for _, e := range list {
		if strings.HasPrefix(e, ".") {
			if strings.HasSuffix(host, e) {
				return true
			}
		} else if host == e {
			return true
		}
	}
	return false
}

// validNoProxy checks no_proxy entries: lowercase DNS names, optionally with a leading dot.
func validNoProxy(list []string) error {
	if len(list) > 64 {
		return errors.New("config: no_proxy: at most 64 entries")
	}
	for _, e := range list {
		if !hostRe.MatchString(strings.TrimPrefix(e, ".")) || strings.ToLower(e) != e {
			return fmt.Errorf("config: no_proxy entry %q must be a lowercase DNS name or .suffix", e)
		}
	}
	return nil
}
