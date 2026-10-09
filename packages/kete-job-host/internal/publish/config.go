// Package publish is the runner's publisher (enterprise runtime P3; spec §4.5 step 4, §5; ADR 0011
// decision 3): `kete-job-host publish`, run in a publisher pod after a job pod has ended and the
// platform has authorized publishing. It runs only Kete code, reads the job's outbox (mounted
// read-only) as hostile input, validates the change bundle with the Go port of the platform's
// validator (internal/bundle, held to the platform's vectors), checks it against the base tree,
// builds one commit on exactly the job's base commit, pushes a new branch create-only over git
// smart HTTP (pure Go, internal/gitproto: no git binary, no repository configuration, no hooks),
// checks the base and default branches' protection against the writer, opens a draft merge
// request, and reports a fixed-code outcome (job-host-v2 `JobHostPublishOutcome`) as its
// termination message. The writer credential exists only in this pod.
package publish

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// Fixed paths in the publisher pod (internal/driver/kubernetes publish.go mounts them; the chart's
// admission policy pins them).
const (
	ConfigFile    = "/etc/kete-publish/publish.json"
	WriterDir     = "/etc/kete-publish-writers"
	CAFile        = "/etc/kete-publish-ca/ca.crt"
	ProxyAuthFile = "/etc/kete-publish-proxy/auth"
	OutboxDir     = "/var/lib/kete-outbox"
	// DefaultIdentity is the author and committer of every job commit, as the platform's (spec D7).
	DefaultIdentity = "Kete Code <jobs@noreply.ketecode.ai>"
	maxConfig       = 256 << 10
)

// File is publish.json, rendered by the chart into a ConfigMap in the jobs namespace (the
// controller has no access to it).
type File struct {
	PlatformURL     string     `json:"platform_url"`
	Repositories    []RepoFile `json:"repositories"`
	Proxy           string     `json:"proxy,omitempty"`
	NoProxy         []string   `json:"no_proxy,omitempty"`
	CommitIdentity  string     `json:"commit_identity,omitempty"`
	CIOnJobBranches bool       `json:"ci_on_job_branches,omitempty"`
}

// RepoFile is one repository the publisher may push to.
type RepoFile struct {
	Name         string `json:"name"`
	CloneURL     string `json:"clone_url"`
	APIURL       string `json:"api_url,omitempty"`
	WriterSecret string `json:"writer_secret"`
	// Username is the writer's git user name (default kete-publisher; GitLab accepts any with a
	// personal or project access token).
	Username string `json:"username,omitempty"`
}

// Repo is a resolved repository.
type Repo struct {
	Name, CloneURL, APIBase, Project, WriterSecret, Username string
}

// Config is the validated publish.json.
type Config struct {
	PlatformURL     string
	Repos           map[string]Repo
	Proxy           *url.URL
	NoProxy         []string
	Identity        string
	CIOnJobBranches bool
}

var identityRe = func(s string) bool {
	// "Name <email>": printable, no angle brackets inside, no newline.
	open, close := strings.IndexByte(s, '<'), strings.IndexByte(s, '>')
	return len(s) <= 200 && open > 1 && close == len(s)-1 && strings.Count(s, "<") == 1 && strings.Count(s, ">") == 1 &&
		!strings.ContainsAny(s, "\x00\r\n") && s[open-1] == ' '
}

// ParseConfig parses and validates publish.json (strict: unknown fields refused).
func ParseConfig(data []byte) (Config, error) {
	if len(data) > maxConfig {
		return Config{}, errors.New("publish: configuration too large")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f File
	if err := dec.Decode(&f); err != nil {
		return Config{}, fmt.Errorf("publish: configuration: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("publish: configuration: trailing data")
	}
	origin, _, err := config.NormalizeOrigin(f.PlatformURL)
	if err != nil {
		return Config{}, fmt.Errorf("publish: platform_url %w", err)
	}
	c := Config{PlatformURL: origin, Repos: map[string]Repo{}, NoProxy: f.NoProxy, Identity: f.CommitIdentity, CIOnJobBranches: f.CIOnJobBranches}
	if c.Identity == "" {
		c.Identity = DefaultIdentity
	}
	if !identityRe(c.Identity) {
		return Config{}, errors.New("publish: commit_identity must be `Name <email>`")
	}
	for _, e := range f.NoProxy {
		if e == "" || strings.ContainsAny(e, " /:@") || strings.ToLower(e) != e {
			return Config{}, fmt.Errorf("publish: no_proxy entry %q", e)
		}
	}
	if f.Proxy != "" {
		u, err := url.Parse(f.Proxy)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
			return Config{}, errors.New("publish: proxy must be http(s)://host[:port] without credentials")
		}
		c.Proxy = u
	}
	if len(f.Repositories) == 0 || len(f.Repositories) > contract.V2MaxRepositories {
		return Config{}, errors.New("publish: 1-256 repositories")
	}
	for _, r := range f.Repositories {
		if !contract.ValidRuntimeRepoName(r.Name) || c.Repos[r.Name].Name != "" || !contract.ValidKubernetesName(r.WriterSecret) {
			return Config{}, fmt.Errorf("publish: repository %q is invalid, repeated or has no writer_secret", r.Name)
		}
		base, project, err := config.GitLabProject(r.CloneURL, r.APIURL)
		if err != nil {
			return Config{}, fmt.Errorf("publish: repository %q: %w", r.Name, err)
		}
		user := r.Username
		if user == "" {
			user = "kete-publisher"
		}
		if strings.ContainsAny(user, ":@/ \x00\r\n") || len(user) > 128 {
			return Config{}, fmt.Errorf("publish: repository %q: invalid username", r.Name)
		}
		c.Repos[r.Name] = Repo{Name: r.Name, CloneURL: r.CloneURL, APIBase: base, Project: project, WriterSecret: r.WriterSecret, Username: user}
	}
	return c, nil
}

// openNoFollow opens path read-only, refusing a symlink as its last component.
func openNoFollow(path string) (*os.File, error) {
	// O_NONBLOCK: a FIFO planted by a hostile job opens at once (and is refused as not regular)
	// instead of blocking the publisher until its deadline.
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
}

// resolveUnder resolves dir/name (a mounted Secret or ConfigMap key is a symlink into a hidden
// timestamped directory) and requires the result to stay inside dir.
func resolveUnder(dir, name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "/\x00") || name == "." || name == ".." {
		return "", errors.New("publish: bad file name")
	}
	d, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	p, err := filepath.EvalSymlinks(filepath.Join(d, name))
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(p, d+string(filepath.Separator)) {
		return "", fmt.Errorf("publish: %s/%s leaves its directory", dir, name)
	}
	return p, nil
}

// readSmall reads a small regular file without following a symlink at its last component.
func readSmall(path string, max int64) ([]byte, error) {
	f, err := openNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > max {
		return nil, fmt.Errorf("%s is not a regular file of at most %d bytes", path, max)
	}
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%s is larger than %d bytes", path, max)
	}
	return b, nil
}

// readSecretFile reads a mounted Secret's key. Kubernetes projects Secret keys as symlinks into a
// timestamped directory, so the path is resolved first and must stay under dir.
func readSecretFile(dir, key string, max int64) (string, error) {
	p, err := resolveUnder(dir, key)
	if err != nil {
		return "", err
	}
	b, err := readSmall(p, max)
	if err != nil {
		return "", err
	}
	v := strings.TrimSpace(string(b))
	clear(b)
	if v == "" || strings.ContainsAny(v, "\r\n\x00") {
		return "", fmt.Errorf("%s/%s is empty or not one line", dir, key)
	}
	return v, nil
}

// transport builds the HTTP transport for repository hosts: the proxy unless the host is in
// no_proxy, the system roots plus the mounted CA bundle, TLS verification always on.
func transport(c Config, caFile, proxyAuthFile string) (*http.Transport, error) {
	t := http.DefaultTransport.(*http.Transport).Clone()
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if p, err := resolveUnder(dirOf(caFile), baseOf(caFile)); err == nil {
		pem, err := readSmall(p, 512<<10)
		if err != nil {
			return nil, fmt.Errorf("publish: CA bundle: %w", err)
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("publish: the CA bundle holds no PEM certificate")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("publish: CA bundle: %w", err)
	}
	if t.TLSClientConfig == nil {
		t.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	t.TLSClientConfig.RootCAs = pool
	t.Proxy = nil
	if c.Proxy != nil {
		pu := *c.Proxy
		if v, err := readSecretFile(dirOf(proxyAuthFile), baseOf(proxyAuthFile), 1024); err == nil {
			user, pass, ok := strings.Cut(v, ":")
			if !ok || user == "" {
				return nil, errors.New("publish: the proxy credential must be username:password")
			}
			pu.User = url.UserPassword(user, pass)
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("publish: proxy credential: %w", err)
		}
		noProxy := c.NoProxy
		t.Proxy = func(r *http.Request) (*url.URL, error) {
			if config.MatchNoProxy(r.URL.Hostname(), noProxy) {
				return nil, nil
			}
			return &pu, nil
		}
	}
	return t, nil
}

func dirOf(p string) string  { return p[:strings.LastIndexByte(p, '/')] }
func baseOf(p string) string { return p[strings.LastIndexByte(p, '/')+1:] }

// HTTPClient is the publisher's client for GitLab: transport's proxy and roots, no redirects.
func HTTPClient(c Config, caFile, proxyAuthFile string) (*http.Client, error) {
	t, err := transport(c, caFile, proxyAuthFile)
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are not followed") }}, nil
}

// LoadConfig reads publish.json (a mounted ConfigMap key: a symlink inside its directory).
func LoadConfig(path string) (Config, error) {
	p, err := resolveUnder(dirOf(path), baseOf(path))
	if err != nil {
		return Config{}, fmt.Errorf("publish: configuration: %w", err)
	}
	b, err := readSmall(p, maxConfig)
	if err != nil {
		return Config{}, fmt.Errorf("publish: configuration: %w", err)
	}
	return ParseConfig(b)
}
