package seal

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hpke"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/vectors"
)

func loadHPKEV2(t *testing.T) vectors.HPKEV2 {
	t.Helper()
	var v vectors.HPKEV2
	if err := vectors.LoadV2("hpke.json", &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// TestV2VectorOpen opens the kubevm seal under the v2 label: info, envelope, plaintext and its
// canonical JSON exactly the vector's.
func TestV2VectorOpen(t *testing.T) {
	v := loadHPKEV2(t)
	if v.Suite.Mode != 0 || v.Suite.KemID != contract.HPKEKemID || v.Suite.KdfID != contract.HPKEKdfID || v.Suite.AeadID != contract.HPKEAeadID {
		t.Fatalf("suite %+v", v.Suite)
	}
	sk := unhex(t, v.Recipient.SKHex)
	k, err := ecdh.X25519().NewPrivateKey(sk)
	if err != nil || hex.EncodeToString(k.PublicKey().Bytes()) != v.Recipient.PKHex || base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()) != v.Recipient.Public {
		t.Fatal("recipient keys")
	}
	if len(v.Cases) != 1 || v.Cases[0].Name != ProfileKubeVM {
		t.Fatalf("cases %d", len(v.Cases))
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			b := binding(c.Binding)
			info, err := b.InfoV2()
			if err != nil || string(info) != c.Info || hex.EncodeToString(info) != c.InfoHex || c.AADHex != "" {
				t.Fatalf("info %q (%v), want %q", info, err, c.Info)
			}
			sc := envelope(t, c)
			if err := sc.Validate(); err != nil {
				t.Fatal(err)
			}
			if base64.RawURLEncoding.EncodeToString(unhex(t, c.PKEHex)) != sc.Enc ||
				base64.RawURLEncoding.EncodeToString(unhex(t, c.CiphertextHex)) != sc.Ciphertext {
				t.Fatal("wire envelope differs from the hex fields")
			}
			kem := hpke.DHKEM(ecdh.X25519())
			if e, err := kem.DeriveKeyPair(unhex(t, c.IKMEHex)); err != nil || hex.EncodeToString(e.PublicKey().Bytes()) != c.PKEHex {
				t.Fatal("ephemeral key derivation")
			}
			pt, err := OpenV2(sk, b, sc)
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			if string(pt) != c.Plaintext {
				t.Fatalf("plaintext %q", pt)
			}
			cfg, err := ParseMachineConfig(pt)
			if err != nil || cfg.ValidateV2() != nil || cfg.HostProfile != ProfileKubeVM || !cfg.FitsBinding(b) {
				t.Fatalf("config %+v: %v / %v", cfg, err, cfg.ValidateV2())
			}
			if cfg.Validate() == nil {
				t.Error("v1 accepted a kubevm configuration")
			}
			if canon, _ := cfg.Canonical(); !bytes.Equal(canon, pt) {
				t.Fatalf("canonical %s differs from the plaintext", canon)
			}
			// The same seal never opens under the v1 label.
			if _, err := Open(sk, b, sc); !errors.Is(err, ErrUndecryptable) {
				t.Errorf("opened under v1: %v", err)
			}
		})
	}
}

// TestV2VectorRefusals: each refusal fails to open, as the one ErrUndecryptable. An `info`
// override replaces the whole info string (the v1 label must not open a v2 seal).
func TestV2VectorRefusals(t *testing.T) {
	v := loadHPKEV2(t)
	if len(v.Refusals) != 5 {
		t.Fatalf("%d refusals, the contract has 5", len(v.Refusals))
	}
	base := v.Cases[0]
	for _, r := range v.Refusals {
		t.Run(r.Name, func(t *testing.T) {
			b := binding(base.Binding)
			for k, val := range r.Override.Binding {
				switch k {
				case "host_id":
					b.HostID = val
				case "machine_id":
					b.MachineID = val
				case "job_id":
					b.JobID = val
				case "generation":
					b.Generation = val
				default:
					t.Fatalf("unknown binding override %s", k)
				}
			}
			sc := envelope(t, base)
			if r.Override.CiphertextHex != nil {
				sc.Ciphertext = base64.RawURLEncoding.EncodeToString(unhex(t, *r.Override.CiphertextHex))
			}
			sk := unhex(t, v.Recipient.SKHex)
			if r.Override.RecipientSKHex != nil {
				sk = unhex(t, *r.Override.RecipientSKHex)
			}
			var pt []byte
			var err error
			if r.Override.Info != nil {
				// The only info a host builds besides v2's is v1's: check that it is the override.
				v1info, _ := b.Info()
				if string(v1info) != *r.Override.Info {
					t.Fatalf("info override is not the v1 info: %q", *r.Override.Info)
				}
				pt, err = Open(sk, b, sc)
			} else {
				pt, err = OpenV2(sk, b, sc)
			}
			if !errors.Is(err, ErrUndecryptable) || pt != nil {
				t.Fatalf("opened (%q, %v)", pt, err)
			}
		})
	}
}

// TestV2SealRoundTrip: SealV2 opens with OpenV2 only.
func TestV2SealRoundTrip(t *testing.T) {
	v := loadHPKEV2(t)
	c := v.Cases[0]
	b := binding(c.Binding)
	sc, err := SealV2(unhex(t, v.Recipient.PKHex), b, []byte(c.Plaintext))
	if err != nil {
		t.Fatal(err)
	}
	sk := unhex(t, v.Recipient.SKHex)
	if pt, err := OpenV2(sk, b, sc); err != nil || string(pt) != c.Plaintext {
		t.Fatalf("open v2: %q, %v", pt, err)
	}
	if _, err := Open(sk, b, sc); !errors.Is(err, ErrUndecryptable) {
		t.Fatalf("a v2 seal opened under v1: %v", err)
	}
	v1, err := Seal(unhex(t, v.Recipient.PKHex), b, []byte(c.Plaintext))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenV2(sk, b, v1); !errors.Is(err, ErrUndecryptable) {
		t.Fatalf("a v1 seal opened under v2: %v", err)
	}
}
