// Package sig is the job-host request signature profile (RFC 9421 with `ed25519`, RFC 9530
// `Content-Digest`; `docs/platform/job-host-v1.md` "Signatures"). job-host-v2 uses the same profile
// with another `tag` (`docs/platform/job-host-v2.md` "Version negotiation and signatures"): V1 and
// V2 are the two Profiles, and the package-level functions are V1's. The profile is fixed — one
// label, one component list, one parameter order — so signing is string building and
// verification is one regular expression, never a general structured-field parser. The agent
// only signs; Verify exists for the fake platform and the shared test vectors, and follows the
// contract's verification order and reasons exactly (kete-code-platform `job-host-crypto.ts`).
package sig

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// Profile constants. Tag is v1's; TagV2 is v2's (the tag is the contract version).
const (
	Label = "kete"
	Alg   = "ed25519"
	Tag   = "kete-job-host-v1"
	TagV2 = "kete-job-host-v2"
)

// Profile is one signature profile: v1's components and parameters under one tag. The tag is
// covered by the signature, and each profile's verifier refuses the other's tag
// (signature_malformed), so a request is verified under exactly the contract it names.
type Profile struct {
	tag     string
	inputRe *regexp.Regexp
}

func newProfile(tag string) Profile {
	return Profile{tag: tag, inputRe: regexp.MustCompile(`^kete=\("@method" "@authority" "@path" "content-type" "content-digest"\);created=([1-9][0-9]{0,15});expires=([1-9][0-9]{0,15});nonce="([0-9a-f]{32})";keyid="([0-9a-f-]{36}|[0-9a-f]{64})";alg="ed25519";tag="` + regexp.QuoteMeta(tag) + `"$`)}
}

// V1 and V2 are the job-host-v1 and job-host-v2 profiles.
var (
	V1 = newProfile(Tag)
	V2 = newProfile(TagV2)
)

// Tag is the profile's `tag` parameter.
func (pr Profile) Tag() string { return pr.tag }

// Params are the signature parameters (`created`, `expires`, `nonce`, `keyid`).
type Params struct {
	Created int64
	Expires int64
	Nonce   string
	KeyID   string
}

// Valid applies JobHostSignatureParams: positive times, expires 1–60 s after created, a 32-hex
// nonce and a keyid that is a lowercase UUID or a fingerprint.
func (p Params) Valid() bool {
	return p.Created > 0 && p.Expires > p.Created && p.Expires-p.Created <= contract.SignatureWindow &&
		p.Expires <= 1<<53-1 && contract.ValidNonce(p.Nonce) &&
		(contract.ValidUUID(p.KeyID) || contract.ValidFingerprint(p.KeyID))
}

// ParamsValue is the v1 `@signature-params` value (also the `Signature-Input` member's value).
func (p Params) ParamsValue() string { return V1.ParamsValue(p) }

// SignatureInput is the v1 `Signature-Input` header value.
func (p Params) SignatureInput() string { return V1.SignatureInput(p) }

// ParamsValue is the `@signature-params` value under the profile.
func (pr Profile) ParamsValue(p Params) string {
	return `("@method" "@authority" "@path" "content-type" "content-digest");created=` + strconv.FormatInt(p.Created, 10) +
		`;expires=` + strconv.FormatInt(p.Expires, 10) + `;nonce="` + p.Nonce + `";keyid="` + p.KeyID +
		`";alg="` + Alg + `";tag="` + pr.tag + `"`
}

// SignatureInput is the `Signature-Input` header value under the profile.
func (pr Profile) SignatureInput(p Params) string { return Label + "=" + pr.ParamsValue(p) }

// ParseSignatureInput parses the header under the v1 profile, or reports false (signature_malformed).
func ParseSignatureInput(h string) (Params, bool) { return V1.ParseSignatureInput(h) }

// ParseSignatureInput parses the header under the profile (exactly its tag), or reports false
// (signature_malformed).
func (pr Profile) ParseSignatureInput(h string) (Params, bool) {
	m := pr.inputRe.FindStringSubmatch(h)
	if m == nil {
		return Params{}, false
	}
	created, err1 := strconv.ParseInt(m[1], 10, 64)
	expires, err2 := strconv.ParseInt(m[2], 10, 64)
	if err1 != nil || err2 != nil {
		return Params{}, false
	}
	p := Params{Created: created, Expires: expires, Nonce: m[3], KeyID: m[4]}
	if !p.Valid() {
		return Params{}, false
	}
	return p, true
}

var signatureRe = regexp.MustCompile(`^kete=:([A-Za-z0-9+/]{86}==):$`)

// ParseSignature returns the 64-byte signature from a `Signature` header, or nil.
func ParseSignature(h string) []byte {
	m := signatureRe.FindStringSubmatch(h)
	if m == nil {
		return nil
	}
	b, err := base64.StdEncoding.Strict().DecodeString(m[1])
	if err != nil || len(b) != ed25519.SignatureSize {
		return nil
	}
	return b
}

var contentDigestRe = regexp.MustCompile(`^sha-256=:([A-Za-z0-9+/]{43}=):$`)

// ContentDigest is the RFC 9530 header value for body: `sha-256=:<base64>:`.
func ContentDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return "sha-256=:" + base64.StdEncoding.EncodeToString(sum[:]) + ":"
}

// ValidContentDigestHeader reports exactly one well-formed `sha-256` member.
func ValidContentDigestHeader(h string) bool { return contentDigestRe.MatchString(h) }

// Components are the covered request components.
type Components struct {
	Authority     string // the platform's configured public host: lowercase, no port
	Path          string // the route path, no query
	ContentDigest string
}

// Base is the v1 RFC 9421 signature base.
func Base(c Components, p Params) string { return V1.Base(c, p) }

// Base is the RFC 9421 signature base under the profile: one line per component, `\n`-joined, no
// trailing newline.
func (pr Profile) Base(c Components, p Params) string {
	return strings.Join([]string{
		`"@method": POST`,
		`"@authority": ` + c.Authority,
		`"@path": ` + c.Path,
		`"content-type": ` + contract.ContentType,
		`"content-digest": ` + c.ContentDigest,
		`"@signature-params": ` + pr.ParamsValue(p),
	}, "\n")
}

// Headers are the four headers a signed request carries.
type Headers struct {
	ContentType    string
	ContentDigest  string
	SignatureInput string
	Signature      string
}

// Sign signs body for authority and path with key under p and the v1 profile.
func Sign(key ed25519.PrivateKey, authority, path string, body []byte, p Params) (Headers, string, error) {
	return V1.Sign(key, authority, path, body, p)
}

// Sign signs body for authority and path with key under p and the profile.
func (pr Profile) Sign(key ed25519.PrivateKey, authority, path string, body []byte, p Params) (Headers, string, error) {
	if !p.Valid() {
		return Headers{}, "", errors.New("sig: invalid signature parameters")
	}
	digest := ContentDigest(body)
	base := pr.Base(Components{Authority: authority, Path: path, ContentDigest: digest}, p)
	s := ed25519.Sign(key, []byte(base))
	return Headers{
		ContentType:    contract.ContentType,
		ContentDigest:  digest,
		SignatureInput: pr.SignatureInput(p),
		Signature:      Label + "=:" + base64.StdEncoding.EncodeToString(s) + ":",
	}, base, nil
}

// NewNonce returns 16 random bytes in lowercase hex.
func NewNonce(r io.Reader) (string, error) {
	var b [16]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// RandomNonce is NewNonce from crypto/rand.
func RandomNonce() (string, error) { return NewNonce(rand.Reader) }

// ---------------------------------------------------------------- key hygiene

// smallOrder is the libsodium blocklist of small-order Ed25519 points, sign bit cleared (the
// same list as kete-code-platform `isAcceptableEd25519PublicKey`).
var smallOrder = [][32]byte{
	mustHex32("0000000000000000000000000000000000000000000000000000000000000000"),
	mustHex32("0100000000000000000000000000000000000000000000000000000000000000"),
	mustHex32("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
	mustHex32("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
	mustHex32("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
	mustHex32("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
	mustHex32("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
}

func mustHex32(s string) [32]byte {
	var out [32]byte
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 32 {
		panic("sig: bad constant")
	}
	copy(out[:], b)
	return out
}

// AcceptablePublicKey reports a public key verification may use: 32 bytes, canonical (y < p) and
// not of small order. Go's crypto/ed25519, like Web Crypto, accepts the identity key with the
// forged signature R = identity, S = 0 for any message, so this check is explicit.
func AcceptablePublicKey(raw []byte) bool {
	if len(raw) != ed25519.PublicKeySize {
		return false
	}
	var u [32]byte
	copy(u[:], raw)
	u[31] &= 0x7f
	for _, so := range smallOrder {
		if u == so {
			return false
		}
	}
	// y ≥ p = 2^255 − 19: bytes 1–30 all 0xff, the last 0x7f, the first ≥ 0xed.
	if u[31] == 0x7f && u[0] >= 0xed && bytes.Count(u[1:31], []byte{0xff}) == 30 {
		return false
	}
	return true
}

// groupOrderL is the Ed25519 group order, little-endian.
var groupOrderL = [32]byte{
	0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
}

// CanonicalS reports S (the signature's second half, little-endian) below L (RFC 8032 §5.1.7).
func CanonicalS(s []byte) bool {
	if len(s) != ed25519.SignatureSize {
		return false
	}
	for i := 31; i >= 0; i-- {
		a, b := s[32+i], groupOrderL[i]
		if a != b {
			return a < b
		}
	}
	return false
}

// DecodeKey decodes a canonical unpadded base64url 32-byte key.
func DecodeKey(s string) ([]byte, bool) {
	if !contract.ValidBase64Url32(s) {
		return nil, false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(b) != 32 {
		return nil, false
	}
	return b, true
}

// EncodeKey is unpadded base64url.
func EncodeKey(raw []byte) string { return base64.RawURLEncoding.EncodeToString(raw) }

// Fingerprint is the lowercase hex SHA-256 of the raw Ed25519 public key followed by the raw
// X25519 public key.
func Fingerprint(signing, sealing []byte) string {
	h := sha256.New()
	h.Write(signing)
	h.Write(sealing)
	return hex.EncodeToString(h.Sum(nil))
}

// GroupFingerprint shows a fingerprint in groups of 4, as the admin page does.
func GroupFingerprint(fp string) string {
	var parts []string
	for i := 0; i < len(fp); i += 4 {
		parts = append(parts, fp[i:min(i+4, len(fp))])
	}
	return strings.Join(parts, " ")
}

// ---------------------------------------------------------------- verification

// Request is a received request as a verifier sees it. A header given more than once must be
// refused by the caller as signature_malformed before Verify (Go's http.Header keeps all values).
type Request struct {
	Method    string
	Authority string // the verifier's configured public host, never the received Host header
	Path      string
	Headers   Headers
	Body      []byte
	Now       int64
}

// Failure is a verification failure reason (contract error reasons).
type Failure string

// Error implements error.
func (f Failure) Error() string { return string(f) }

// dummyPublic is RFC 9421's published test key: an unknown or unacceptable key is verified
// against it and the result discarded, so it costs the same as a wrong signature.
var dummyPublic = mustDecodeKey("JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs")

func mustDecodeKey(s string) []byte {
	b, ok := DecodeKey(s)
	if !ok {
		panic("sig: bad dummy key")
	}
	return b
}

// Verify checks a request in the contract's order: content type (malformed_request), digest
// header (signature_malformed) and value (digest_mismatch), signature headers
// (signature_malformed), window (clock_skew), key and signature (signature_invalid). keyFor
// returns the base64url public key for a keyid, or "" when none is known. This is the v1 profile.
func Verify(r Request, keyFor func(keyid string) string) (Params, error) { return V1.Verify(r, keyFor) }

// Verify is the package Verify under the profile: a request signed under another tag is
// signature_malformed.
func (pr Profile) Verify(r Request, keyFor func(keyid string) string) (Params, error) {
	if r.Method != "POST" || r.Headers.ContentType != contract.ContentType {
		return Params{}, Failure(contract.ErrMalformedRequest)
	}
	if !ValidContentDigestHeader(r.Headers.ContentDigest) {
		return Params{}, Failure(contract.ErrSignatureMalformed)
	}
	if ContentDigest(r.Body) != r.Headers.ContentDigest {
		return Params{}, Failure(contract.ErrDigestMismatch)
	}
	p, ok := pr.ParseSignatureInput(r.Headers.SignatureInput)
	s := ParseSignature(r.Headers.Signature)
	if !ok || s == nil {
		return Params{}, Failure(contract.ErrSignatureMalformed)
	}
	if abs(r.Now-p.Created) > contract.SignatureWindow || r.Now > p.Expires {
		return Params{}, Failure(contract.ErrClockSkew)
	}
	key, real := dummyPublic, false
	if k, ok := DecodeKey(keyFor(p.KeyID)); ok && AcceptablePublicKey(k) {
		key, real = k, true
	}
	base := pr.Base(Components{Authority: r.Authority, Path: r.Path, ContentDigest: r.Headers.ContentDigest}, p)
	valid := ed25519.Verify(ed25519.PublicKey(key), []byte(base), s)
	if !valid || !real || !CanonicalS(s) {
		return Params{}, Failure(contract.ErrSignatureInvalid)
	}
	return p, nil
}

// VerifyEnrollment verifies an enroll request: the key is the body's `signing_key`, and `keyid`
// must equal the fingerprint of the body's two keys (proof of possession); anything else is
// signature_invalid (kete-code-platform `verifyJobHostEnrollment`). It returns the fingerprint.
// The caller then parses the body strictly (malformed_request). This is the v1 profile.
func VerifyEnrollment(r Request) (Params, string, error) { return V1.VerifyEnrollment(r) }

// VerifyEnrollment is the package VerifyEnrollment under the profile.
func (pr Profile) VerifyEnrollment(r Request) (Params, string, error) {
	var keys struct {
		SigningKey any `json:"signing_key"`
		SealingKey any `json:"sealing_key"`
	}
	_ = json.Unmarshal(r.Body, &keys) // a body that isn't JSON leaves both empty: no key, signature_invalid
	signing, _ := keys.SigningKey.(string)
	sealing, _ := keys.SealingKey.(string)
	fp := ""
	if sk, ok1 := DecodeKey(signing); ok1 {
		if xk, ok2 := DecodeKey(sealing); ok2 {
			fp = Fingerprint(sk, xk)
		}
	}
	p, err := pr.Verify(r, func(keyid string) string {
		if fp != "" && keyid == fp {
			return signing
		}
		return ""
	})
	if err != nil {
		return Params{}, "", err
	}
	return p, fp, nil
}

func abs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// String helps logging a Params without anything secret (none of it is).
func (p Params) String() string {
	return fmt.Sprintf("created=%d expires=%d keyid=%s", p.Created, p.Expires, p.KeyID)
}
