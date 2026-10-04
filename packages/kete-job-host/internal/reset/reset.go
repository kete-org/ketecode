// Package reset is the agent's side of a dedicated host's verified reset (kete-code-platform ADR
// 0023 rule 8). A dedicated host runs one job per generation and is treated as compromised after
// it; the platform verifies a reset before the host gets another job.
//
//   - R1 `provider_rebuild` needs nothing here at run time: the platform rebuilds the server
//     through the provider's API with a fresh enrollment token in its user data, the rebuilt
//     server enrolls on first boot (`kete-job-host enroll --token-file`,
//     packaging/kete-job-host-enroll.service) with the generation its user data names, and the
//     platform approves that enrollment automatically. The agent's part is refusing a second job
//     in a generation (internal/agent, state `generation_spent_by`) and refusing to re-enroll a
//     spent host (internal/enroll).
//   - R2 `measured_boot` needs the host's keys to live in a TPM 2.0, sealed to the measured boot
//     state of a signed read-only image, and quotes over the platform's nonce. Attestor is that
//     interface; this agent has no implementation yet, so Detect refuses and config.Parse refuses
//     `measured_boot` (the module README "Dedicated hosts" lists what remains).
package reset

import (
	"context"
	"errors"
	"fmt"
	"os"
)

// Quote is a TPM 2.0 quote over the platform's nonce (R2): the attested message (TPMS_ATTEST,
// whose extraData is the nonce), its signature by the TPM-resident attestation key, the PCR
// values it covers and the boot event log the platform replays against its allowlist.
type Quote struct {
	Attest    []byte
	Signature []byte
	PCRs      map[int][]byte
	EventLog  []byte
}

// Attestor is R2's agent side: keys that never leave the TPM and quotes over a platform nonce.
type Attestor interface {
	// PublicKeys returns the TPM-resident signing (Ed25519 is not a TPM algorithm: R2 needs the
	// contract to accept an ECDSA P-256 host key) and sealing public keys.
	PublicKeys() (signing, sealing []byte, err error)
	// Quote returns a quote over nonce (the platform's, fresh per verification).
	Quote(ctx context.Context, nonce []byte) (Quote, error)
}

// ErrNoTPM means the host has no TPM 2.0 resource manager device.
var ErrNoTPM = errors.New("reset: no TPM 2.0 (/dev/tpmrm0): measured_boot is impossible on this host")

// ErrNotImplemented means R2's agent side isn't built yet.
var ErrNotImplemented = errors.New("reset: measured_boot (TPM-resident keys, quotes) is not implemented in this agent; use provider_rebuild")

// TPMDevice is the kernel's TPM 2.0 resource manager.
const TPMDevice = "/dev/tpmrm0"

// Detect returns the host's R2 attestor. Without a TPM it returns ErrNoTPM; with one it still
// returns ErrNotImplemented until the TPM work lands. It never falls back to file keys.
func Detect() (Attestor, error) { return detect(TPMDevice) }

func detect(dev string) (Attestor, error) {
	fi, err := os.Stat(dev)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return nil, ErrNoTPM
	case err != nil:
		return nil, fmt.Errorf("reset: %s: %w", dev, err)
	case fi.Mode()&os.ModeCharDevice == 0:
		return nil, fmt.Errorf("reset: %s is not a character device: %w", dev, ErrNoTPM)
	}
	return nil, ErrNotImplemented
}
