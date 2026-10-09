// Package vectors loads the shared job-host-v1 and job-host-v2 test vectors
// (`testdata/job-host-v1/`, `testdata/job-host-v2/`, copied byte for byte from kete-code-platform
// `docs/contracts/test-vectors/job-host-v1/` and `…/job-host-v2/`). Tests only.
package vectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

// Dir is the v1 vectors directory.
func Dir() string { return dir("job-host-v1") }

// DirV2 is the v2 vectors directory.
func DirV2() string { return dir("job-host-v2") }

func dir(name string) string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "testdata", name)
}

// Files are the v1 vector files, in SHA256SUMS order.
var Files = []string{"config-disk.json", "hpke.json", "signatures.json"}

// FilesV2 are the v2 vector files, in SHA256SUMS order.
var FilesV2 = []string{"hpke.json", "messages.json", "orchestration.json", "signatures.json"}

// Signatures is signatures.json.
type Signatures struct {
	Keys struct {
		Ed25519SeedHex      string `json:"ed25519_seed_hex"`
		Ed25519Public       string `json:"ed25519_public"`
		X25519PrivateHex    string `json:"x25519_private_hex"`
		X25519Public        string `json:"x25519_public"`
		Fingerprint         string `json:"fingerprint"`
		OtherEd25519SeedHex string `json:"other_ed25519_seed_hex"`
		OtherEd25519Public  string `json:"other_ed25519_public"`
	} `json:"keys"`
	Requests  []SignedRequest `json:"requests"`
	Refusals  []SigRefusal    `json:"refusals"`
	Reference struct {
		RFC9421B26 struct {
			Ed25519Seed     string `json:"ed25519_seed"`
			Ed25519Public   string `json:"ed25519_public"`
			SignatureBase   string `json:"signature_base"`
			SignatureBase64 string `json:"signature_base64"`
		} `json:"rfc9421_b26"`
		RFC9530B1 struct {
			Body          string `json:"body"`
			ContentDigest string `json:"content_digest"`
		} `json:"rfc9530_b1"`
	} `json:"reference"`
}

// SignedRequest is one signed request.
type SignedRequest struct {
	Name      string `json:"name"`
	Method    string `json:"method"`
	Authority string `json:"authority"`
	Path      string `json:"path"`
	Body      string `json:"body"`
	Params    struct {
		Created int64  `json:"created"`
		Expires int64  `json:"expires"`
		Nonce   string `json:"nonce"`
		KeyID   string `json:"keyid"`
	} `json:"params"`
	Headers       map[string]string `json:"headers"`
	SignatureBase string            `json:"signature_base"`
	VerifyAt      int64             `json:"verify_at"`
}

// SigRefusal is one refusal case.
type SigRefusal struct {
	Name     string `json:"name"`
	Request  string `json:"request"`
	Override struct {
		Body      *string           `json:"body"`
		Path      *string           `json:"path"`
		Authority *string           `json:"authority"`
		VerifyAt  *int64            `json:"verify_at"`
		PublicKey *string           `json:"public_key"`
		Headers   map[string]string `json:"headers"`
	} `json:"override"`
	Reason string `json:"reason"`
}

// HPKE is hpke.json.
type HPKE struct {
	Recipient struct {
		IKMHex string `json:"ikm_hex"`
		SKHex  string `json:"sk_hex"`
		PKHex  string `json:"pk_hex"`
		Public string `json:"public"`
	} `json:"recipient"`
	Cases     []HPKECase    `json:"cases"`
	Refusals  []HPKERefusal `json:"refusals"`
	Reference struct {
		A11 struct {
			InfoHex       string `json:"info_hex"`
			IKMEHex       string `json:"ikm_e_hex"`
			PKEHex        string `json:"pk_e_hex"`
			SKEHex        string `json:"sk_e_hex"`
			IKMRHex       string `json:"ikm_r_hex"`
			PKRHex        string `json:"pk_r_hex"`
			SKRHex        string `json:"sk_r_hex"`
			PlaintextHex  string `json:"plaintext_hex"`
			AADHex        string `json:"aad_hex"`
			CiphertextHex string `json:"ciphertext_hex"`
		} `json:"rfc9180_a11"`
	} `json:"reference"`
}

// Binding is a case's binding.
type Binding struct {
	HostID     string `json:"host_id"`
	MachineID  string `json:"machine_id"`
	JobID      string `json:"job_id"`
	Generation string `json:"generation"`
}

// HPKECase is one seal.
type HPKECase struct {
	Name          string          `json:"name"`
	Binding       Binding         `json:"binding"`
	Info          string          `json:"info"`
	InfoHex       string          `json:"info_hex"`
	AADHex        string          `json:"aad_hex"`
	Plaintext     string          `json:"plaintext"`
	IKMEHex       string          `json:"ikm_e_hex"`
	SKEHex        string          `json:"sk_e_hex"`
	PKEHex        string          `json:"pk_e_hex"`
	CiphertextHex string          `json:"ciphertext_hex"`
	Sealed        json.RawMessage `json:"sealed"`
}

// HPKERefusal is one refusal (applied to the microvm case).
type HPKERefusal struct {
	Name     string `json:"name"`
	Override struct {
		Binding        map[string]string `json:"binding"`
		CiphertextHex  *string           `json:"ciphertext_hex"`
		PKEHex         *string           `json:"pk_e_hex"`
		RecipientSKHex *string           `json:"recipient_sk_hex"`
	} `json:"override"`
}

// ConfigDisk is config-disk.json.
type ConfigDisk struct {
	Header    string `json:"header"`
	JSON      string `json:"json"`
	Size      int    `json:"size"`
	SHA256Hex string `json:"sha256_hex"`
}

// Load decodes one v1 vector file into v.
func Load(name string, v any) error { return load(Dir(), name, v) }

// LoadV2 decodes one v2 vector file into v.
func LoadV2(name string, v any) error { return load(DirV2(), name, v) }

func load(dir, name string, v any) error {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// ---------------------------------------------------------------- job-host-v2

// SignaturesV2 is v2 signatures.json: v1's keys (the private ones are v1's vector), a v2-signed
// enroll and poll, refusals, and what a v1 verifier answers for every v2 request.
type SignaturesV2 struct {
	Keys struct {
		Ed25519SeedHex     string `json:"ed25519_seed_hex"`
		Ed25519Public      string `json:"ed25519_public"`
		X25519Public       string `json:"x25519_public"`
		Fingerprint        string `json:"fingerprint"`
		OtherEd25519Public string `json:"other_ed25519_public"`
	} `json:"keys"`
	Requests         []SignedRequest `json:"requests"`
	V1VerifierReason string          `json:"v1_verifier_reason"`
	Refusals         []SigRefusal    `json:"refusals"`
}

// HPKEV2 is v2 hpke.json.
type HPKEV2 struct {
	Suite struct {
		Mode   int `json:"mode"`
		KemID  int `json:"kem_id"`
		KdfID  int `json:"kdf_id"`
		AeadID int `json:"aead_id"`
	} `json:"suite"`
	Recipient struct {
		SKHex  string `json:"sk_hex"`
		PKHex  string `json:"pk_hex"`
		Public string `json:"public"`
	} `json:"recipient"`
	Cases    []HPKECase `json:"cases"`
	Refusals []struct {
		Name     string `json:"name"`
		Override struct {
			Info           *string           `json:"info"`
			Binding        map[string]string `json:"binding"`
			CiphertextHex  *string           `json:"ciphertext_hex"`
			RecipientSKHex *string           `json:"recipient_sk_hex"`
		} `json:"override"`
	} `json:"refusals"`
}

// MessageCase is one messages.json case: a value the named Zod schema accepts or refuses.
type MessageCase struct {
	Schema string          `json:"schema"`
	Name   string          `json:"name"`
	Valid  bool            `json:"valid"`
	Value  json.RawMessage `json:"value"`
}

// Messages is v2 messages.json.
type Messages struct {
	Cases []MessageCase `json:"cases"`
}
