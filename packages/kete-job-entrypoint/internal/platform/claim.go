package platform

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
)

// ClaimResponse is claim's 200 body (unknown fields are ignored).
type ClaimResponse struct {
	Spec          json.RawMessage `json:"spec"`
	GatewayKey    string          `json:"gateway_key"`
	CallbackToken string          `json:"callback_token"`
	Clone         struct {
		URL     string `json:"url"`
		Token   string `json:"token"`
		Ref     string `json:"ref"`
		BaseSHA string `json:"base_sha"`
	} `json:"clone"`
	GatewayURL  string `json:"gateway_url"`
	PlatformURL string `json:"platform_url"`
	Deadline    string `json:"deadline"`
}

// ParseClaim decodes the body.
func ParseClaim(data []byte) (*ClaimResponse, error) {
	var c ClaimResponse
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, errors.New("platform: claim response is not JSON")
	}
	return &c, nil
}

// Claim is a validated claim response.
type Claim struct {
	CallbackToken string
	Spec          map[string]any
	SpecRaw       json.RawMessage
	Branch        string
	PolicyTimeout int
	GatewayKey    string
	GatewayURL    string
	GatewayHost   string
	CloneURL      string
	CloneHost     string
	CloneToken    string
	Ref           string
	BaseSHA       string
	Deadline      time.Time
}

var shaPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// ValidRefName is the conservative branch-name subset `kete job run` checks (job-run.ts).
func ValidRefName(name string) bool {
	if name == "" || len(name) > 255 {
		return false
	}
	for _, r := range name {
		if r <= 0x20 || r == 0x7f || strings.ContainsRune("~^:?*[\\", r) {
			return false
		}
	}
	if strings.Contains(name, "..") || strings.Contains(name, "@{") || strings.Contains(name, "//") {
		return false
	}
	if strings.HasPrefix(name, "-") || strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") ||
		strings.HasSuffix(name, ".lock") || strings.HasSuffix(name, ".") || name == "@" {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	return true
}

func printable(s string, max int) bool {
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

// Validate checks every field (step 3b). On failure it returns the name of the first bad field,
// which goes into the result message (never a value).
func (c *ClaimResponse) Validate(machinePlatformURL, storageHost string, now time.Time) (*Claim, string) {
	out := &Claim{}
	if !printable(c.CallbackToken, 512) {
		return nil, "callback_token"
	}
	out.CallbackToken = c.CallbackToken
	pu, err := bootenv.NormalizeHTTPSURL(c.PlatformURL, false)
	if err != nil || pu != machinePlatformURL {
		return nil, "platform_url"
	}
	dl, err := time.Parse(time.RFC3339, c.Deadline)
	if err != nil || !dl.After(now) {
		return nil, "deadline"
	}
	out.Deadline = dl
	if !printable(c.GatewayKey, 4096) {
		return nil, "gateway_key"
	}
	out.GatewayKey = c.GatewayKey
	gu, err := bootenv.NormalizeHTTPSURL(c.GatewayURL, true)
	if err != nil {
		return nil, "gateway_url"
	}
	out.GatewayURL = gu
	if u, _ := url.Parse(gu); u != nil {
		out.GatewayHost = u.Hostname()
	}
	cu, err := bootenv.NormalizeHTTPSURL(c.Clone.URL, true)
	if err != nil {
		return nil, "clone.url"
	}
	out.CloneURL = cu
	if u, _ := url.Parse(cu); u != nil {
		out.CloneHost = u.Hostname()
	}
	if !printable(c.Clone.Token, 4096) {
		return nil, "clone.token"
	}
	out.CloneToken = c.Clone.Token
	if !ValidRefName(c.Clone.Ref) {
		return nil, "clone.ref"
	}
	out.Ref = c.Clone.Ref
	if !shaPattern.MatchString(c.Clone.BaseSHA) {
		return nil, "clone.base_sha"
	}
	out.BaseSHA = c.Clone.BaseSHA
	// The storage host (machine configuration) must not be a host the job's users or the clone
	// reach: root alone gets it, in the report phase only.
	apiHost, _ := RevokeURL(out.CloneHost)
	if storageHost == "" || storageHost == out.GatewayHost || storageHost == out.CloneHost || storageHost == apiHost {
		return nil, "storage_host"
	}

	var spec map[string]any
	if len(c.Spec) == 0 || json.Unmarshal(c.Spec, &spec) != nil || spec == nil {
		return nil, "spec"
	}
	if v, ok := spec["version"].(float64); !ok || v != 1 {
		return nil, "spec.version"
	}
	policy, ok := spec["policy"].(map[string]any)
	if !ok {
		return nil, "spec.policy"
	}
	t, ok := policy["timeout"].(float64)
	if !ok || t < 1 || t != float64(int(t)) || t > 24*60 {
		return nil, "spec.policy.timeout"
	}
	out.PolicyTimeout = int(t)
	branch, ok := spec["branch"].(string)
	if !ok || !ValidRefName(branch) {
		return nil, "spec.branch"
	}
	out.Branch = branch
	out.Spec = spec
	out.SpecRaw = c.Spec
	return out, ""
}

// Upload is one signed URL.
type Upload struct {
	URL       string `json:"url"`
	ExpiresAt string `json:"expires_at"`
}

// UploadURLs is the uploads response.
type UploadURLs struct {
	Audit    Upload  `json:"audit"`
	ProxyLog Upload  `json:"proxy_log"`
	Bundle   *Upload `json:"bundle"`
	Host     string  `json:"-"`
}

// ParseUploads decodes and checks the URLs: https, port 443, exactly storageHost (the machine
// configuration's KETE_JOB_STORAGE_HOST).
func ParseUploads(data []byte, bundle bool, storageHost string) (*UploadURLs, error) {
	var u UploadURLs
	if err := json.Unmarshal(data, &u); err != nil {
		return nil, errors.New("platform: uploads response is not JSON")
	}
	list := []string{u.Audit.URL, u.ProxyLog.URL}
	if bundle {
		if u.Bundle == nil {
			return nil, errors.New("platform: uploads response has no bundle URL")
		}
		list = append(list, u.Bundle.URL)
	} else {
		u.Bundle = nil
	}
	for _, raw := range list {
		p, err := url.Parse(raw)
		if err != nil || p.Scheme != "https" || p.User != nil || p.Fragment != "" || (p.Port() != "" && p.Port() != "443") || !bootenv.ValidHost(p.Hostname()) {
			return nil, errors.New("platform: bad upload URL")
		}
		if p.Hostname() != storageHost || p.Host != storageHost && p.Host != storageHost+":443" {
			return nil, errors.New("platform: an upload URL names another host")
		}
		u.Host = storageHost
	}
	return &u, nil
}
