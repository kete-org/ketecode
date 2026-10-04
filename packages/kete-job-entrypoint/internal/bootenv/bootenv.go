// Package bootenv reads and validates the machine configuration (module README "Machine
// configuration", D3): KETE_JOB_ID, KETE_JOB_PLATFORM_URL, KETE_JOB_CLAIM_TOKEN and
// KETE_JOB_STORAGE_HOST (the only host signed upload URLs may name), plus the host profile
// (KETE_JOB_HOST_PROFILE, ADR 0023 rule 16). On Fly they come from the machine's environment
// (FromEnv); on every other host from a config pipe (--config-fd: Config, FromConfig) written by
// kete-job-init or the host agent. Of the rest of the environment, only whether Fly's own machine
// variables (FlyVars) are set is kept (Values.OnFly: a Fly signal); their values are never read.
// The boot stage hands the values to the re-executed `__run` stage over a pipe
// (handover_linux.go), so the claim token never stays in the kernel's copy of the process
// environment.
package bootenv

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
)

const (
	VarJobID       = "KETE_JOB_ID"
	VarPlatformURL = "KETE_JOB_PLATFORM_URL"
	VarClaimToken  = "KETE_JOB_CLAIM_TOKEN"
	VarStorageHost = "KETE_JOB_STORAGE_HOST"

	minTokenLen = 32
	maxTokenLen = 512
	maxPayload  = 4096
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// hostPattern is a plain DNS name: lowercase labels of letters, digits and hyphens, at least two
// labels, no trailing dot. IP literals and anything non-ASCII are refused.
var hostPattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$`)

// Values is the validated machine configuration.
type Values struct {
	JobID       string `json:"job_id"`
	PlatformURL string `json:"platform_url"` // normalized: https://host (no trailing slash)
	ClaimToken  string `json:"claim_token"`
	StorageHost string `json:"storage_host"`
	// OnFly: one of FlyVars is set, so this is a Fly machine and Fly's API socket must be where
	// the guard expects it (module README "Fly guard").
	OnFly bool `json:"on_fly"`
	// The host profile (hostprofile.Name), where the values came from, and the profile's own
	// values: cloudvm's provider, dedicated's reset generation. Empty only in values built by Read
	// alone, which setup refuses (step setup_host, code invalid).
	Profile    string `json:"host_profile,omitempty"`
	Source     string `json:"source,omitempty"`
	Provider   string `json:"host_provider,omitempty"`
	Generation string `json:"host_generation,omitempty"`
}

// FlyVars are variables Fly sets in every machine (fly.io/docs/machines/runtime-environment).
// Any one of them non-empty means the entrypoint runs on Fly.
var FlyVars = []string{"FLY_MACHINE_ID", "FLY_ALLOC_ID", "FLY_APP_NAME", "FLY_REGION", "FLY_PRIVATE_IP"}

// OnFly reports whether any of FlyVars is set.
func OnFly(getenv func(string) string) bool {
	for _, k := range FlyVars {
		if getenv(k) != "" {
			return true
		}
	}
	return false
}

// PlatformHost is the platform URL's host.
func (v Values) PlatformHost() string { return strings.TrimPrefix(v.PlatformURL, "https://") }

// Read validates the three variables from getenv.
func Read(getenv func(string) string) (Values, error) {
	v := Values{JobID: getenv(VarJobID), ClaimToken: getenv(VarClaimToken), StorageHost: getenv(VarStorageHost), OnFly: OnFly(getenv)}
	if err := ValidateJobID(v.JobID); err != nil {
		return Values{}, err
	}
	u, err := NormalizeHTTPSURL(getenv(VarPlatformURL), false)
	if err != nil {
		return Values{}, fmt.Errorf("%s: %w", VarPlatformURL, err)
	}
	v.PlatformURL = u
	if err := ValidateToken(v.ClaimToken); err != nil {
		return Values{}, fmt.Errorf("%s: %w", VarClaimToken, err)
	}
	if !ValidHost(v.StorageHost) {
		return Values{}, fmt.Errorf("%s must be a plain DNS host", VarStorageHost)
	}
	return v, nil
}

// ValidateJobID checks a UUID.
func ValidateJobID(id string) error {
	if !uuidPattern.MatchString(id) {
		return fmt.Errorf("%s must be a UUID", VarJobID)
	}
	return nil
}

// ValidateToken checks printable ASCII, 32-512 bytes.
func ValidateToken(t string) error {
	if len(t) < minTokenLen || len(t) > maxTokenLen {
		return fmt.Errorf("must be %d-%d bytes", minTokenLen, maxTokenLen)
	}
	for i := 0; i < len(t); i++ {
		if t[i] < 0x21 || t[i] > 0x7e {
			return errors.New("must be printable ASCII without spaces")
		}
	}
	return nil
}

// ValidHost reports whether h is a plain lowercase DNS name.
func ValidHost(h string) bool { return len(h) <= 253 && hostPattern.MatchString(h) }

// NormalizeHTTPSURL checks an `https://` URL with a plain DNS host, port 443 or none, no userinfo,
// query or fragment. With allowPath false the path must be empty or "/"; the result is then
// `https://host`. With allowPath true the path is kept (used for clone URLs).
func NormalizeHTTPSURL(raw string, allowPath bool) (string, error) {
	if raw == "" {
		return "", errors.New("is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("is not a URL")
	}
	if u.Scheme != "https" {
		return "", errors.New("must be https")
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return "", errors.New("must not carry userinfo, a query or a fragment")
	}
	if p := u.Port(); p != "" && p != "443" {
		return "", errors.New("must use port 443")
	}
	host := u.Hostname()
	if !ValidHost(host) {
		return "", errors.New("must name a plain DNS host")
	}
	if !allowPath {
		if u.Path != "" && u.Path != "/" {
			return "", errors.New("must not carry a path")
		}
		return "https://" + host, nil
	}
	if strings.Contains(u.EscapedPath(), "..") {
		return "", errors.New("must not carry a .. path segment")
	}
	return "https://" + host + u.EscapedPath(), nil
}

// Config is the config pipe's payload (--config-fd; the microvm config disk's JSON after
// hostprofile.ConfigDiskHeader; cloudvm's user data): exactly these fields, one JSON object.
type Config struct {
	JobID          string `json:"job_id"`
	PlatformURL    string `json:"platform_url"`
	ClaimToken     string `json:"claim_token"`
	StorageHost    string `json:"storage_host"`
	HostProfile    string `json:"host_profile"`
	HostProvider   string `json:"host_provider,omitempty"`
	HostGeneration string `json:"host_generation,omitempty"`
}

// MaxConfig is the largest config payload accepted.
const MaxConfig = maxPayload

// DecodeConfig reads one config object strictly: at most MaxConfig bytes, no unknown field, no
// trailing data, every field validated (ValidateConfig).
func DecodeConfig(r io.Reader) (Config, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxConfig+1))
	if err != nil {
		return Config{}, err
	}
	if len(data) > MaxConfig {
		return Config{}, errors.New("config too large")
	}
	return ParseConfig(data)
}

// ParseConfig is DecodeConfig over bytes already read.
func ParseConfig(data []byte) (Config, error) {
	if len(data) > MaxConfig {
		return Config{}, errors.New("config too large")
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	var c Config
	if err := dec.Decode(&c); err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	if dec.More() {
		return Config{}, errors.New("config: trailing data")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("config: trailing data")
	}
	if err := ValidateConfig(c); err != nil {
		return Config{}, err
	}
	return c, nil
}

// ValidateConfig checks the four values as Read does, and the profile fields: a profile that takes
// a pipe (not fly), a provider exactly for cloudvm, a generation exactly for dedicated.
func ValidateConfig(c Config) error {
	if _, err := Read(c.getenv); err != nil {
		return err
	}
	return validateProfileFields(c.HostProfile, string(hostprofile.SourcePipe), c.HostProvider, c.HostGeneration)
}

func (c Config) getenv(name string) string {
	switch name {
	case VarJobID:
		return c.JobID
	case VarPlatformURL:
		return c.PlatformURL
	case VarClaimToken:
		return c.ClaimToken
	case VarStorageHost:
		return c.StorageHost
	}
	return ""
}

func validateProfileFields(profile, source, provider, generation string) error {
	n, err := hostprofile.Parse(profile)
	if err != nil {
		return err
	}
	if source != string(hostprofile.SourceFor(n)) {
		return fmt.Errorf("host profile %s takes its values from the %s", n, hostprofile.SourceFor(n))
	}
	if _, ok := hostprofile.Providers[provider]; (n == hostprofile.CloudVM) != ok || (n != hostprofile.CloudVM && provider != "") {
		return errors.New("host_provider must name a provider exactly for cloudvm")
	}
	if (n == hostprofile.Dedicated) != hostprofile.ValidGeneration(generation) || (n != hostprofile.Dedicated && generation != "") {
		return errors.New("host_generation is required exactly for dedicated")
	}
	return nil
}

// FromEnv is the boot stage without a config pipe: the four values from the environment (Read),
// the profile from KETE_JOB_HOST_PROFILE resolved by hostprofile.Resolve (flyDir: /.fly exists),
// and it must be fly: every other profile takes its values from a pipe.
func FromEnv(getenv func(string) string, flyDir bool) (Values, error) {
	v, err := Read(getenv)
	if err != nil {
		return Values{}, err
	}
	n, err := hostprofile.Resolve(getenv(hostprofile.Var), v.OnFly || flyDir)
	if err != nil {
		return Values{}, err
	}
	if n != hostprofile.Fly {
		return Values{}, fmt.Errorf("host profile %s takes its values from --config-fd", n)
	}
	v.Profile, v.Source = string(n), string(hostprofile.SourceEnv)
	return v, nil
}

// FromConfig is the boot stage with a config pipe: the values from c; none of the four may also
// be in the environment (ambiguous: refused), and KETE_JOB_HOST_PROFILE, when set, must name the
// same profile. Fly's variables are still noted (OnFly), so setup refuses a non-fly profile on Fly.
func FromConfig(c Config, getenv func(string) string) (Values, error) {
	if err := ValidateConfig(c); err != nil {
		return Values{}, err
	}
	for _, k := range []string{VarJobID, VarPlatformURL, VarClaimToken, VarStorageHost} {
		if getenv(k) != "" {
			return Values{}, fmt.Errorf("%s is set together with --config-fd", k)
		}
	}
	if p := getenv(hostprofile.Var); p != "" && p != c.HostProfile {
		return Values{}, fmt.Errorf("%s differs from the config's host_profile", hostprofile.Var)
	}
	v, err := Read(c.getenv)
	if err != nil {
		return Values{}, err
	}
	v.OnFly = OnFly(getenv)
	v.Profile, v.Source, v.Provider, v.Generation = c.HostProfile, string(hostprofile.SourcePipe), c.HostProvider, c.HostGeneration
	return v, nil
}

// Encode serializes the values for the handover pipe.
func Encode(v Values) ([]byte, error) { return json.Marshal(v) }

// Decode reads and re-validates the values from the handover pipe.
func Decode(r io.Reader) (Values, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxPayload+1))
	if err != nil {
		return Values{}, err
	}
	if len(data) > maxPayload {
		return Values{}, errors.New("handover payload too large")
	}
	var v Values
	if err := json.Unmarshal(data, &v); err != nil {
		return Values{}, err
	}
	out, err := Read(func(name string) string {
		switch name {
		case VarJobID:
			return v.JobID
		case VarPlatformURL:
			return v.PlatformURL
		case VarClaimToken:
			return v.ClaimToken
		case VarStorageHost:
			return v.StorageHost
		}
		return ""
	})
	if err != nil {
		return Values{}, err
	}
	out.OnFly = v.OnFly
	if v.Profile != "" || v.Source != "" || v.Provider != "" || v.Generation != "" {
		if err := validateProfileFields(v.Profile, v.Source, v.Provider, v.Generation); err != nil {
			return Values{}, err
		}
	}
	out.Profile, out.Source, out.Provider, out.Generation = v.Profile, v.Source, v.Provider, v.Generation
	return out, nil
}
