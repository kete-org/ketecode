// Package seal is the job-host-v1 sealed configuration (RFC 9180 HPKE base mode,
// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, single-shot, empty AAD; the binding to
// host, machine, job and generation is the HPKE `info`), the machine configuration it carries
// (kete-code bootenv.Config, `docs/platform/job-host-v1.md` "Machine configuration") and the
// firecracker config disk. HPKE is Go's standard library `crypto/hpke` (Go 1.26), so no
// third-party cryptography is involved. Base mode does not authenticate the sender: what limits a
// forged configuration is the agent's own checks (platform origin, image allowlist, ADR 0023
// rules 13 and 17).
//
// job-host-v2 seals the same way under another `info` label (`docs/platform/job-host-v2.md`
// "Sealed configuration"): OpenV2 and SealV2, so a v1 seal never opens as v2 and the reverse. Its
// plaintext adds the `kubevm` profile (ValidateV2).
package seal

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hpke"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// Errors. Every failure to decrypt is the one ErrUndecryptable (no oracle).
var (
	ErrUndecryptable  = errors.New("config undecryptable")
	ErrInvalidBinding = errors.New("invalid config binding")
)

// Binding is what a sealed configuration is bound to.
type Binding struct {
	HostID     string
	MachineID  string
	JobID      string
	Generation string
}

// Valid reports lowercase UUID ids and a valid generation, so no value can inject a line into
// the info.
func (b Binding) Valid() bool {
	return contract.ValidUUID(b.HostID) && contract.ValidUUID(b.MachineID) && contract.ValidUUID(b.JobID) &&
		contract.ValidGeneration(b.Generation)
}

// Info is the v1 HPKE info: the label and the four bindings, one per line, no trailing newline.
func (b Binding) Info() ([]byte, error) { return b.info(contract.HPKEInfoLabel) }

// InfoV2 is the v2 HPKE info: v1's layout under the v2 label.
func (b Binding) InfoV2() ([]byte, error) { return b.info(contract.HPKEInfoLabelV2) }

func (b Binding) info(label string) ([]byte, error) {
	if !b.Valid() {
		return nil, ErrInvalidBinding
	}
	return []byte(strings.Join([]string{
		label,
		"host_id=" + b.HostID,
		"machine_id=" + b.MachineID,
		"job_id=" + b.JobID,
		"generation=" + b.Generation,
	}, "\n")), nil
}

func suite() (hpke.KEM, hpke.KDF, hpke.AEAD) {
	return hpke.DHKEM(ecdh.X25519()), hpke.HKDFSHA256(), hpke.AES128GCM()
}

// Open decrypts a sealed configuration with the host's raw X25519 private key. A binding that
// isn't valid is ErrInvalidBinding; every other failure (envelope, key, tag) is ErrUndecryptable.
// The caller owns (and should clear) the returned plaintext.
func Open(privateKey []byte, b Binding, sc contract.SealedConfig) ([]byte, error) {
	info, err := b.Info()
	if err != nil {
		return nil, err
	}
	return open(privateKey, info, sc)
}

// OpenV2 is Open under the v2 info label: a configuration sealed under v1 doesn't open
// (ErrUndecryptable).
func OpenV2(privateKey []byte, b Binding, sc contract.SealedConfig) ([]byte, error) {
	info, err := b.InfoV2()
	if err != nil {
		return nil, err
	}
	return open(privateKey, info, sc)
}

func open(privateKey, info []byte, sc contract.SealedConfig) ([]byte, error) {
	if sc.Validate() != nil || len(privateKey) != 32 {
		return nil, ErrUndecryptable
	}
	enc, err1 := base64.RawURLEncoding.Strict().DecodeString(sc.Enc)
	ct, err2 := base64.RawURLEncoding.Strict().DecodeString(sc.Ciphertext)
	if err1 != nil || err2 != nil || len(enc) != 32 {
		return nil, ErrUndecryptable
	}
	kem, kdf, aead := suite()
	sk, err := kem.NewPrivateKey(privateKey)
	if err != nil {
		return nil, ErrUndecryptable
	}
	r, err := hpke.NewRecipient(enc, sk, kdf, aead, info)
	if err != nil {
		return nil, ErrUndecryptable
	}
	pt, err := r.Open(nil, ct)
	if err != nil {
		return nil, ErrUndecryptable
	}
	return pt, nil
}

// Seal encrypts plaintext to a host's raw X25519 public key with a fresh ephemeral key (the fake
// platform and tests; the real platform seals in TypeScript, `job-host-crypto.ts`).
func Seal(publicKey []byte, b Binding, plaintext []byte) (contract.SealedConfig, error) {
	info, err := b.Info()
	if err != nil {
		return contract.SealedConfig{}, err
	}
	return seal(publicKey, info, plaintext)
}

// SealV2 is Seal under the v2 info label.
func SealV2(publicKey []byte, b Binding, plaintext []byte) (contract.SealedConfig, error) {
	info, err := b.InfoV2()
	if err != nil {
		return contract.SealedConfig{}, err
	}
	return seal(publicKey, info, plaintext)
}

func seal(publicKey, info, plaintext []byte) (contract.SealedConfig, error) {
	kem, kdf, aead := suite()
	pk, err := kem.NewPublicKey(publicKey)
	if err != nil {
		return contract.SealedConfig{}, fmt.Errorf("seal: %w", err)
	}
	enc, s, err := hpke.NewSender(pk, kdf, aead, info)
	if err != nil {
		return contract.SealedConfig{}, fmt.Errorf("seal: %w", err)
	}
	ct, err := s.Seal(nil, plaintext)
	if err != nil {
		return contract.SealedConfig{}, fmt.Errorf("seal: %w", err)
	}
	return contract.SealedConfig{
		KemID: contract.HPKEKemID, KdfID: contract.HPKEKdfID, AeadID: contract.HPKEAeadID,
		Enc: base64.RawURLEncoding.EncodeToString(enc), Ciphertext: base64.RawURLEncoding.EncodeToString(ct),
	}, nil
}

// ---------------------------------------------------------------- machine configuration

// Host profiles a sealed configuration may carry, and cloudvm's providers.
const (
	ProfileMicroVM   = "microvm"
	ProfileDedicated = "dedicated"
	ProfileCloudVM   = "cloudvm"
	// ProfileKubeVM is job-host-v2's `kubernetes` driver profile (JobMachineConfigV2): no
	// host_provider, no host_generation. v1 refuses it.
	ProfileKubeVM = "kubevm"
)

var providers = map[string]bool{"gcp": true, "digitalocean": true, "hetzner": true, "oci": true}

const dnsHost = `(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?`

var (
	platformURLRe = regexp.MustCompile(`^https://` + dnsHost + `$`)
	dnsHostRe     = regexp.MustCompile(`^` + dnsHost + `$`)
	claimTokenRe  = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// MachineConfig is JobMachineConfig, fields in the contract's order (so json.Marshal writes the
// canonical form).
type MachineConfig struct {
	JobID          string `json:"job_id"`
	PlatformURL    string `json:"platform_url"`
	ClaimToken     string `json:"claim_token"`
	StorageHost    string `json:"storage_host"`
	HostProfile    string `json:"host_profile"`
	HostProvider   string `json:"host_provider,omitempty"`
	HostGeneration string `json:"host_generation,omitempty"`
}

// ParseMachineConfig decodes one JSON object strictly (≤ MachineConfigMaxBytes, no unknown
// field, no trailing data). It checks structure only: the caller compares platform_url with its
// configured origin before Validate (ADR 0023 rule 13 order).
func ParseMachineConfig(data []byte) (MachineConfig, error) {
	if len(data) > contract.MachineConfigMaxBytes {
		return MachineConfig{}, errors.New("machine config too large")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var c MachineConfig
	if err := dec.Decode(&c); err != nil {
		return MachineConfig{}, errors.New("machine config: not a valid object")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return MachineConfig{}, errors.New("machine config: trailing data")
	}
	return c, nil
}

// Validate applies JobMachineConfig's field rules (v1: microvm, dedicated, cloudvm).
func (c MachineConfig) Validate() error {
	if c.HostProfile == ProfileKubeVM {
		return errors.New("machine config: host_profile")
	}
	return c.ValidateV2()
}

// ValidateV2 applies JobMachineConfigV2's field rules: v1's, with profile kubevm added.
func (c MachineConfig) ValidateV2() error {
	switch {
	case !contract.ValidUUID(c.JobID):
		return errors.New("machine config: job_id")
	case len(c.PlatformURL) > 261 || !platformURLRe.MatchString(c.PlatformURL):
		return errors.New("machine config: platform_url")
	case !claimTokenRe.MatchString(c.ClaimToken):
		return errors.New("machine config: claim_token")
	case len(c.StorageHost) > 253 || !dnsHostRe.MatchString(c.StorageHost):
		return errors.New("machine config: storage_host")
	case c.HostProfile != ProfileMicroVM && c.HostProfile != ProfileDedicated && c.HostProfile != ProfileCloudVM && c.HostProfile != ProfileKubeVM:
		return errors.New("machine config: host_profile")
	case (c.HostProfile == ProfileCloudVM) != providers[c.HostProvider] || (c.HostProfile != ProfileCloudVM && c.HostProvider != ""):
		return errors.New("machine config: host_provider exactly for cloudvm")
	case (c.HostProfile == ProfileDedicated) != contract.ValidGeneration(c.HostGeneration) ||
		(c.HostProfile != ProfileDedicated && c.HostGeneration != ""):
		return errors.New("machine config: host_generation exactly for dedicated")
	}
	return nil
}

// FitsBinding reports what the platform's sealer and opener require of a configuration for a
// binding (`fitsBinding`): the binding's job and, for dedicated, its generation. (Which profiles a
// host accepts is the driver's rule.)
func (c MachineConfig) FitsBinding(b Binding) bool {
	return c.JobID == b.JobID && (c.HostProfile != ProfileDedicated || c.HostGeneration == b.Generation)
}

// Canonical is the configuration's canonical JSON: compact, fields in order, absent optionals
// omitted (kete-code-platform `jobMachineConfigJson`; every field's character set needs no
// escaping, so Go and JavaScript encode it identically).
func (c MachineConfig) Canonical() ([]byte, error) { return json.Marshal(c) }

// ---------------------------------------------------------------- config disk

// ConfigDisk builds the firecracker config disk: the header, the configuration JSON, then NUL
// bytes to exactly ConfigDiskBytes (kete-code guestinit.ParseConfigDisk reads it).
func ConfigDisk(configJSON []byte) ([]byte, error) {
	if len(configJSON) == 0 || len(configJSON) > contract.MachineConfigMaxBytes || bytes.IndexByte(configJSON, 0) >= 0 {
		return nil, errors.New("config disk: invalid configuration JSON")
	}
	img := make([]byte, contract.ConfigDiskBytes)
	n := copy(img, contract.ConfigDiskHeader)
	copy(img[n:], configJSON)
	return img, nil
}
