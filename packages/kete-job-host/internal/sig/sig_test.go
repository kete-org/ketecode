package sig

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/vectors"
)

func loadSignatures(t *testing.T) vectors.Signatures {
	t.Helper()
	var v vectors.Signatures
	if err := vectors.Load("signatures.json", &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func seedKey(t *testing.T, seedHex string) ed25519.PrivateKey {
	t.Helper()
	seed, err := hex.DecodeString(seedHex)
	if err != nil || len(seed) != ed25519.SeedSize {
		t.Fatalf("bad seed %q", seedHex)
	}
	return ed25519.NewKeyFromSeed(seed)
}

func TestVectorKeys(t *testing.T) {
	v := loadSignatures(t)
	k := seedKey(t, v.Keys.Ed25519SeedHex)
	if got := EncodeKey(k.Public().(ed25519.PublicKey)); got != v.Keys.Ed25519Public {
		t.Fatalf("ed25519 public = %s, want %s", got, v.Keys.Ed25519Public)
	}
	if got := EncodeKey(seedKey(t, v.Keys.OtherEd25519SeedHex).Public().(ed25519.PublicKey)); got != v.Keys.OtherEd25519Public {
		t.Fatalf("other ed25519 public = %s", got)
	}
	xRaw, _ := hex.DecodeString(v.Keys.X25519PrivateHex)
	x, err := ecdh.X25519().NewPrivateKey(xRaw)
	if err != nil {
		t.Fatal(err)
	}
	if got := EncodeKey(x.PublicKey().Bytes()); got != v.Keys.X25519Public {
		t.Fatalf("x25519 public = %s, want %s", got, v.Keys.X25519Public)
	}
	if got := Fingerprint(k.Public().(ed25519.PublicKey), x.PublicKey().Bytes()); got != v.Keys.Fingerprint {
		t.Fatalf("fingerprint = %s, want %s", got, v.Keys.Fingerprint)
	}
	if g := GroupFingerprint(v.Keys.Fingerprint); len(g) != 64+15 || g[:9] != "03f1 3569" {
		t.Fatalf("grouped fingerprint = %q", g)
	}
}

// TestVectorSign re-signs both requests: Ed25519 is deterministic, so the headers, the signature
// base and the signature must be byte for byte the vector's.
func TestVectorSign(t *testing.T) {
	v := loadSignatures(t)
	key := seedKey(t, v.Keys.Ed25519SeedHex)
	for _, r := range v.Requests {
		t.Run(r.Name, func(t *testing.T) {
			p := Params{Created: r.Params.Created, Expires: r.Params.Expires, Nonce: r.Params.Nonce, KeyID: r.Params.KeyID}
			h, base, err := Sign(key, r.Authority, r.Path, []byte(r.Body), p)
			if err != nil {
				t.Fatal(err)
			}
			if base != r.SignatureBase {
				t.Errorf("signature base:\n%s\nwant:\n%s", base, r.SignatureBase)
			}
			got := map[string]string{"content-type": h.ContentType, "content-digest": h.ContentDigest, "signature-input": h.SignatureInput, "signature": h.Signature}
			for name, want := range r.Headers {
				if got[name] != want {
					t.Errorf("%s = %q, want %q", name, got[name], want)
				}
			}
			if len(got) != len(r.Headers) {
				t.Errorf("headers %v, vector %v", got, r.Headers)
			}
		})
	}
}

func requestFrom(r vectors.SignedRequest) Request {
	return Request{
		Method: r.Method, Authority: r.Authority, Path: r.Path, Body: []byte(r.Body), Now: r.VerifyAt,
		Headers: Headers{
			ContentType: r.Headers["content-type"], ContentDigest: r.Headers["content-digest"],
			SignatureInput: r.Headers["signature-input"], Signature: r.Headers["signature"],
		},
	}
}

func verifyVector(r Request, name, pollKeyID, key string) error {
	if name == "enroll" {
		_, _, err := VerifyEnrollment(r)
		return err
	}
	_, err := Verify(r, func(keyid string) string {
		if keyid == pollKeyID {
			return key
		}
		return ""
	})
	return err
}

func TestVectorVerify(t *testing.T) {
	v := loadSignatures(t)
	for _, r := range v.Requests {
		t.Run(r.Name, func(t *testing.T) {
			if err := verifyVector(requestFrom(r), r.Name, r.Params.KeyID, v.Keys.Ed25519Public); err != nil {
				t.Fatalf("verify: %v", err)
			}
		})
	}
	// The enrollment fingerprint is returned for the platform to store.
	_, fp, err := VerifyEnrollment(requestFrom(v.Requests[0]))
	if err != nil || fp != v.Keys.Fingerprint {
		t.Fatalf("enrollment fingerprint %q, %v", fp, err)
	}
}

// TestVectorRefusals applies each refusal's override to its request and expects its reason.
func TestVectorRefusals(t *testing.T) {
	v := loadSignatures(t)
	byName := map[string]vectors.SignedRequest{}
	for _, r := range v.Requests {
		byName[r.Name] = r
	}
	if len(v.Refusals) != 16 {
		t.Fatalf("%d refusals, the contract has 16", len(v.Refusals))
	}
	for _, ref := range v.Refusals {
		t.Run(ref.Name, func(t *testing.T) {
			name := ref.Request
			if name == "" {
				name = "poll"
			}
			base := byName[name]
			r := requestFrom(base)
			o := ref.Override
			if o.Body != nil {
				r.Body = []byte(*o.Body)
			}
			if o.Path != nil {
				r.Path = *o.Path
			}
			if o.Authority != nil {
				r.Authority = *o.Authority
			}
			if o.VerifyAt != nil {
				r.Now = *o.VerifyAt
			}
			for h, val := range o.Headers {
				switch h {
				case "content-type":
					r.Headers.ContentType = val
				case "content-digest":
					r.Headers.ContentDigest = val
				case "signature-input":
					r.Headers.SignatureInput = val
				case "signature":
					r.Headers.Signature = val
				default:
					t.Fatalf("unknown header override %s", h)
				}
			}
			key := v.Keys.Ed25519Public
			if o.PublicKey != nil {
				key = *o.PublicKey
			}
			err := verifyVector(r, name, base.Params.KeyID, key)
			var f Failure
			if !errors.As(err, &f) || string(f) != ref.Reason {
				t.Fatalf("got %v, want %s", err, ref.Reason)
			}
		})
	}
}

func TestReferenceRFC9421B26(t *testing.T) {
	v := loadSignatures(t).Reference.RFC9421B26
	seed, _ := base64.RawURLEncoding.DecodeString(v.Ed25519Seed)
	k := ed25519.NewKeyFromSeed(seed)
	if EncodeKey(k.Public().(ed25519.PublicKey)) != v.Ed25519Public {
		t.Fatal("public key mismatch")
	}
	if got := base64.StdEncoding.EncodeToString(ed25519.Sign(k, []byte(v.SignatureBase))); got != v.SignatureBase64 {
		t.Fatalf("signature %s, want %s", got, v.SignatureBase64)
	}
}

func TestReferenceRFC9530B1(t *testing.T) {
	v := loadSignatures(t).Reference.RFC9530B1
	if got := ContentDigest([]byte(v.Body)); got != v.ContentDigest {
		t.Fatalf("digest %s, want %s", got, v.ContentDigest)
	}
}

func TestAcceptablePublicKey(t *testing.T) {
	for _, h := range []string{
		"0000000000000000000000000000000000000000000000000000000000000000",
		"0100000000000000000000000000000000000000000000000000000000000080", // identity with the sign bit
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // y ≥ p, not small order
		"f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", // same with sign bit
	} {
		b, _ := hex.DecodeString(h)
		if AcceptablePublicKey(b) {
			t.Errorf("%s accepted", h)
		}
	}
	if AcceptablePublicKey(make([]byte, 31)) {
		t.Error("31 bytes accepted")
	}
	v := loadSignatures(t)
	k, _ := DecodeKey(v.Keys.Ed25519Public)
	if !AcceptablePublicKey(k) {
		t.Error("vector key refused")
	}
}

func TestCanonicalS(t *testing.T) {
	s := make([]byte, 64)
	if !CanonicalS(s) {
		t.Error("S = 0 refused")
	}
	copy(s[32:], groupOrderL[:])
	if CanonicalS(s) {
		t.Error("S = L accepted")
	}
	s[32]--
	if !CanonicalS(s) {
		t.Error("S = L-1 refused")
	}
}

func TestParamsAndParsing(t *testing.T) {
	good := Params{Created: 1790992800, Expires: 1790992860, Nonce: "000102030405060708090a0b0c0d0e0f", KeyID: "7d0f3c2e-5b1a-4c8e-9f60-2a4b6c8d0e1f"}
	if p, ok := ParseSignatureInput(good.SignatureInput()); !ok || p != good {
		t.Fatalf("round trip %v %v", p, ok)
	}
	for _, p := range []Params{
		{Created: good.Created, Expires: good.Created, Nonce: good.Nonce, KeyID: good.KeyID},
		{Created: good.Created, Expires: good.Created + 61, Nonce: good.Nonce, KeyID: good.KeyID},
		{Created: good.Created, Expires: good.Expires, Nonce: "ABCDEF0102030405060708090a0b0c0d", KeyID: good.KeyID},
		{Created: good.Created, Expires: good.Expires, Nonce: good.Nonce, KeyID: "7D0F3C2E-5B1A-4C8E-9F60-2A4B6C8D0E1F"},
	} {
		if _, _, err := Sign(ed25519.NewKeyFromSeed(make([]byte, 32)), "a.example", contract.PollPath, nil, p); err == nil {
			t.Errorf("signed invalid params %v", p)
		}
	}
	if ParseSignature("kete=:"+base64.StdEncoding.EncodeToString(make([]byte, 63))+":") != nil {
		t.Error("63-byte signature parsed")
	}
	n1, _ := RandomNonce()
	n2, _ := RandomNonce()
	if !contract.ValidNonce(n1) || n1 == n2 {
		t.Errorf("nonces %s %s", n1, n2)
	}
	if !bytes.Equal([]byte(ContentDigest(nil)), []byte("sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:")) {
		t.Error("empty digest")
	}
}
