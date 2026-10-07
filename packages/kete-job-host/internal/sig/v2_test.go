package sig

import (
	"crypto/ed25519"
	"errors"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/vectors"
)

func loadSignaturesV2(t *testing.T) vectors.SignaturesV2 {
	t.Helper()
	var v vectors.SignaturesV2
	if err := vectors.LoadV2("signatures.json", &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func verifyVectorV2(pr Profile, r Request, name, pollKeyID, key string) error {
	if name == "enroll" {
		_, _, err := pr.VerifyEnrollment(r)
		return err
	}
	_, err := pr.Verify(r, func(keyid string) string {
		if keyid == pollKeyID {
			return key
		}
		return ""
	})
	return err
}

// TestV2VectorSign re-signs both v2 requests with v1's key under the v2 profile: headers, base
// and signature byte for byte the vector's.
func TestV2VectorSign(t *testing.T) {
	v := loadSignaturesV2(t)
	key := seedKey(t, v.Keys.Ed25519SeedHex)
	if EncodeKey(key.Public().(ed25519.PublicKey)) != v.Keys.Ed25519Public {
		t.Fatal("v2 keys are not v1's")
	}
	for _, r := range v.Requests {
		t.Run(r.Name, func(t *testing.T) {
			p := Params{Created: r.Params.Created, Expires: r.Params.Expires, Nonce: r.Params.Nonce, KeyID: r.Params.KeyID}
			h, base, err := V2.Sign(key, r.Authority, r.Path, []byte(r.Body), p)
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

// TestV2VectorVerify: the v2 verifier accepts both requests; the v1 verifier answers
// v1_verifier_reason (the v2 tag is outside its profile), and the v1 package functions are V1's.
func TestV2VectorVerify(t *testing.T) {
	v := loadSignaturesV2(t)
	if v.V1VerifierReason != contract.ErrSignatureMalformed {
		t.Fatalf("v1_verifier_reason %q", v.V1VerifierReason)
	}
	for _, r := range v.Requests {
		t.Run(r.Name, func(t *testing.T) {
			req := requestFrom(r)
			if err := verifyVectorV2(V2, req, r.Name, r.Params.KeyID, v.Keys.Ed25519Public); err != nil {
				t.Fatalf("v2 verify: %v", err)
			}
			for _, verify := range []func() error{
				func() error { return verifyVectorV2(V1, req, r.Name, r.Params.KeyID, v.Keys.Ed25519Public) },
				func() error { return verifyVector(req, r.Name, r.Params.KeyID, v.Keys.Ed25519Public) },
			} {
				var f Failure
				if err := verify(); !errors.As(err, &f) || string(f) != v.V1VerifierReason {
					t.Errorf("v1 verifier: %v, want %s", err, v.V1VerifierReason)
				}
			}
		})
	}
	_, fp, err := V2.VerifyEnrollment(requestFrom(v.Requests[0]))
	if err != nil || fp != v.Keys.Fingerprint {
		t.Fatalf("enrollment fingerprint %q, %v", fp, err)
	}
}

// TestV2VectorRefusals applies each refusal's override and expects its reason from the v2
// verifier (a request signed under the v1 profile included).
func TestV2VectorRefusals(t *testing.T) {
	v := loadSignaturesV2(t)
	byName := map[string]vectors.SignedRequest{}
	for _, r := range v.Requests {
		byName[r.Name] = r
	}
	if len(v.Refusals) != 8 {
		t.Fatalf("%d refusals, the contract has 8", len(v.Refusals))
	}
	for _, ref := range v.Refusals {
		t.Run(ref.Name, func(t *testing.T) {
			name := ref.Request
			if name == "" {
				name = "poll"
			}
			base, ok := byName[name]
			if !ok {
				t.Fatalf("no request %s", name)
			}
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
			err := verifyVectorV2(V2, r, name, base.Params.KeyID, key)
			var f Failure
			if !errors.As(err, &f) || string(f) != ref.Reason {
				t.Fatalf("got %v, want %s", err, ref.Reason)
			}
		})
	}
}

// TestV2SignatureInputParse: each profile parses only its own tag.
func TestV2SignatureInputParse(t *testing.T) {
	p := Params{Created: 1791363600, Expires: 1791363660, Nonce: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", KeyID: "c2a7e9d4-3b5f-4a18-9c60-7e1d2f3a4b5c"}
	if got, ok := V2.ParseSignatureInput(V2.SignatureInput(p)); !ok || got != p {
		t.Fatal("v2 round trip")
	}
	if _, ok := V2.ParseSignatureInput(V1.SignatureInput(p)); ok {
		t.Error("v2 parsed a v1 header")
	}
	if _, ok := ParseSignatureInput(V2.SignatureInput(p)); ok {
		t.Error("v1 parsed a v2 header")
	}
	if p.SignatureInput() != V1.SignatureInput(p) || V2.Tag() != TagV2 || V1.Tag() != Tag {
		t.Error("v1 defaults")
	}
}
