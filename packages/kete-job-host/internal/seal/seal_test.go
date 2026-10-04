package seal

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hpke"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/vectors"
)

func loadHPKE(t *testing.T) vectors.HPKE {
	t.Helper()
	var v vectors.HPKE
	if err := vectors.Load("hpke.json", &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func binding(b vectors.Binding) Binding {
	return Binding{HostID: b.HostID, MachineID: b.MachineID, JobID: b.JobID, Generation: b.Generation}
}

func envelope(t *testing.T, c vectors.HPKECase) contract.SealedConfig {
	t.Helper()
	var sc contract.SealedConfig
	if err := json.Unmarshal(c.Sealed, &sc); err != nil {
		t.Fatal(err)
	}
	return sc
}

func TestVectorOpen(t *testing.T) {
	v := loadHPKE(t)
	sk := unhex(t, v.Recipient.SKHex)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			b := binding(c.Binding)
			info, err := b.Info()
			if err != nil || string(info) != c.Info || hex.EncodeToString(info) != c.InfoHex {
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
			pt, err := Open(sk, b, sc)
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			if string(pt) != c.Plaintext {
				t.Fatalf("plaintext %q", pt)
			}
			cfg, err := ParseMachineConfig(pt)
			if err != nil || cfg.Validate() != nil || cfg.HostProfile != c.Name {
				t.Fatalf("config %+v: %v / %v", cfg, err, cfg.Validate())
			}
			if canon, _ := cfg.Canonical(); !bytes.Equal(canon, pt) {
				t.Fatalf("canonical %s differs from the plaintext", canon)
			}
		})
	}
}

// TestVectorKeyDerivation: DeriveKeyPair(ikm) gives the vector's recipient key and, for each
// case, enc = pk_e from ikm_e (RFC 9180 §7.1.3), so the vector's ephemeral keys are what the
// platform's sealer derives.
func TestVectorKeyDerivation(t *testing.T) {
	v := loadHPKE(t)
	kem := hpke.DHKEM(ecdh.X25519())
	check := func(ikmHex, pkHex string) {
		t.Helper()
		k, err := kem.DeriveKeyPair(unhex(t, ikmHex))
		if err != nil {
			t.Fatal(err)
		}
		if got := hex.EncodeToString(k.PublicKey().Bytes()); got != pkHex {
			t.Fatalf("derived pk %s, want %s", got, pkHex)
		}
	}
	check(v.Recipient.IKMHex, v.Recipient.PKHex)
	for _, c := range v.Cases {
		check(c.IKMEHex, c.PKEHex)
	}
	a := v.Reference.A11
	check(a.IKMEHex, a.PKEHex)
	check(a.IKMRHex, a.PKRHex)
	if base64.RawURLEncoding.EncodeToString(unhex(t, v.Recipient.PKHex)) != v.Recipient.Public {
		t.Fatal("recipient public encoding")
	}
}

func TestVectorRefusals(t *testing.T) {
	v := loadHPKE(t)
	if len(v.Refusals) != 7 {
		t.Fatalf("%d refusals, the contract has 7", len(v.Refusals))
	}
	base := v.Cases[0]
	if base.Name != "microvm" {
		t.Fatal("first case must be microvm")
	}
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
			if r.Override.PKEHex != nil {
				sc.Enc = base64.RawURLEncoding.EncodeToString(unhex(t, *r.Override.PKEHex))
			}
			sk := unhex(t, v.Recipient.SKHex)
			if r.Override.RecipientSKHex != nil {
				sk = unhex(t, *r.Override.RecipientSKHex)
			}
			pt, err := Open(sk, b, sc)
			if !errors.Is(err, ErrUndecryptable) || pt != nil {
				t.Fatalf("opened (%q, %v)", pt, err)
			}
		})
	}
}

// TestReferenceRFC9180A11 opens RFC 9180 A.1.1's first ciphertext (same suite, with AAD) through
// crypto/hpke, confirming the library is the RFC's base mode.
func TestReferenceRFC9180A11(t *testing.T) {
	a := loadHPKE(t).Reference.A11
	kem, kdf, aead := suite()
	sk, err := kem.NewPrivateKey(unhex(t, a.SKRHex))
	if err != nil {
		t.Fatal(err)
	}
	r, err := hpke.NewRecipient(unhex(t, a.PKEHex), sk, kdf, aead, unhex(t, a.InfoHex))
	if err != nil {
		t.Fatal(err)
	}
	pt, err := r.Open(unhex(t, a.AADHex), unhex(t, a.CiphertextHex))
	if err != nil || hex.EncodeToString(pt) != a.PlaintextHex {
		t.Fatalf("open: %x, %v", pt, err)
	}
}

func TestSealRoundTrip(t *testing.T) {
	v := loadHPKE(t)
	c := v.Cases[1]
	b := binding(c.Binding)
	sc, err := Seal(unhex(t, v.Recipient.PKHex), b, []byte(c.Plaintext))
	if err != nil {
		t.Fatal(err)
	}
	if err := sc.Validate(); err != nil {
		t.Fatal(err)
	}
	pt, err := Open(unhex(t, v.Recipient.SKHex), b, sc)
	if err != nil || string(pt) != c.Plaintext {
		t.Fatalf("round trip %q %v", pt, err)
	}
	other := b
	other.Generation = "g-other"
	if _, err := Open(unhex(t, v.Recipient.SKHex), other, sc); !errors.Is(err, ErrUndecryptable) {
		t.Fatal("opened under another generation")
	}
}

func TestBindingValidation(t *testing.T) {
	v := loadHPKE(t)
	sc := envelope(t, v.Cases[0])
	good := binding(v.Cases[0].Binding)
	for name, b := range map[string]Binding{
		"uppercase id":        {HostID: strings.ToUpper(good.HostID), MachineID: good.MachineID, JobID: good.JobID, Generation: good.Generation},
		"newline generation":  {HostID: good.HostID, MachineID: good.MachineID, JobID: good.JobID, Generation: "g\nmachine_id=x"},
		"empty machine":       {HostID: good.HostID, JobID: good.JobID, Generation: good.Generation},
		"generation too long": {HostID: good.HostID, MachineID: good.MachineID, JobID: good.JobID, Generation: strings.Repeat("g", 65)},
	} {
		if _, err := Open(unhex(t, v.Recipient.SKHex), b, sc); !errors.Is(err, ErrInvalidBinding) {
			t.Errorf("%s: %v", name, err)
		}
		if _, err := Seal(unhex(t, v.Recipient.PKHex), b, []byte("x")); !errors.Is(err, ErrInvalidBinding) {
			t.Errorf("seal %s: %v", name, err)
		}
	}
	bad := sc
	bad.KemID = 0x0021
	if _, err := Open(unhex(t, v.Recipient.SKHex), good, bad); !errors.Is(err, ErrUndecryptable) {
		t.Error("other kem id opened")
	}
	if _, err := Open(unhex(t, v.Recipient.SKHex)[:31], good, sc); !errors.Is(err, ErrUndecryptable) {
		t.Error("31-byte key opened")
	}
}

func TestMachineConfig(t *testing.T) {
	const base = `{"job_id":"9b2e4f60-1a3c-4d5e-8f70-6b8c0d2e4f61","platform_url":"https://portal.kete.example","claim_token":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","storage_host":"storage.kete.example"`
	ok := []string{
		base + `,"host_profile":"microvm"}`,
		base + `,"host_profile":"dedicated","host_generation":"g-2026-10-03.1"}`,
		base + `,"host_profile":"cloudvm","host_provider":"gcp"}`,
	}
	for _, s := range ok {
		c, err := ParseMachineConfig([]byte(s))
		if err != nil || c.Validate() != nil {
			t.Errorf("%s: %v %v", s, err, c.Validate())
		}
	}
	structural := []string{
		base + `,"host_profile":"microvm","extra":1}`,
		base + `,"host_profile":"microvm"}{}`,
		base + `,"host_profile":"microvm"} x`,
		`[]`,
		base + `,"host_profile":"microvm","pad":"` + strings.Repeat("a", 4096) + `"}`,
	}
	for _, s := range structural {
		if _, err := ParseMachineConfig([]byte(s)); err == nil {
			t.Errorf("parsed %.80s", s)
		}
	}
	invalid := []string{
		base + `,"host_profile":"dedicated"}`,
		base + `,"host_profile":"microvm","host_generation":"g1"}`,
		base + `,"host_profile":"cloudvm"}`,
		base + `,"host_profile":"microvm","host_provider":"gcp"}`,
		base + `,"host_profile":"fly"}`,
		strings.Replace(base, "https://portal", "http://portal", 1) + `,"host_profile":"microvm"}`,
		strings.Replace(base, "0123456789abcdef0123", "0123456789ABCDEF0123", 1) + `,"host_profile":"microvm"}`,
		strings.Replace(base, "9b2e4f60", "9B2E4F60", 1) + `,"host_profile":"microvm"}`,
		strings.Replace(base, "storage.kete.example", "10.0.0.1", 1) + `,"host_profile":"microvm"}`,
	}
	for _, s := range invalid {
		c, err := ParseMachineConfig([]byte(s))
		if err == nil && c.Validate() == nil {
			t.Errorf("accepted %s", s)
		}
	}
}

func TestVectorConfigDisk(t *testing.T) {
	var v vectors.ConfigDisk
	if err := vectors.Load("config-disk.json", &v); err != nil {
		t.Fatal(err)
	}
	if v.Header != contract.ConfigDiskHeader || v.Size != contract.ConfigDiskBytes {
		t.Fatal("header or size differs from the contract constants")
	}
	img, err := ConfigDisk([]byte(v.JSON))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(img)
	if len(img) != v.Size || hex.EncodeToString(sum[:]) != v.SHA256Hex {
		t.Fatalf("image %d bytes, sha256 %x", len(img), sum)
	}
	if _, err := ConfigDisk(append([]byte(v.JSON), 0)); err == nil {
		t.Error("NUL accepted")
	}
	if _, err := ConfigDisk(bytes.Repeat([]byte("a"), 4097)); err == nil {
		t.Error("oversize accepted")
	}
}
