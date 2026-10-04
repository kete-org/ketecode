// Package keys holds the host's two key pairs (ADR 0023 rules 9–10): an Ed25519 signing key that
// signs every request, and an X25519 sealing key that configurations are sealed to. Both are
// generated at enrollment and stored as raw 32-byte files, root `0600`, in a root `0700`
// directory (`<state_dir>/keys`). Loading refuses anything less private, and a signing key whose
// public half is non-canonical or of small order (P2.0 handoff; never true of a generated key,
// so a hit means the file was replaced). TPM-resident keys for `measured_boot` are P5.
package keys

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fsutil"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
)

const (
	signingFile = "signing.key"
	sealingFile = "sealing.key"
)

// Keys are the host's private keys.
type Keys struct {
	Signing ed25519.PrivateKey
	Sealing *ecdh.PrivateKey
}

// SigningPublic is the raw Ed25519 public key.
func (k Keys) SigningPublic() []byte { return k.Signing.Public().(ed25519.PublicKey) }

// SealingPublic is the raw X25519 public key.
func (k Keys) SealingPublic() []byte { return k.Sealing.PublicKey().Bytes() }

// SealingPrivate is the raw X25519 private key (for HPKE open).
func (k Keys) SealingPrivate() []byte { return k.Sealing.Bytes() }

// Fingerprint is the contract's key fingerprint.
func (k Keys) Fingerprint() string { return sig.Fingerprint(k.SigningPublic(), k.SealingPublic()) }

// Generate creates both key pairs from r (crypto/rand in production).
func Generate(r io.Reader) (Keys, error) {
	for range 8 {
		pub, priv, err := ed25519.GenerateKey(r)
		if err != nil {
			return Keys{}, err
		}
		if !sig.AcceptablePublicKey(pub) {
			continue // unreachable in practice: a random seed is never a small-order point
		}
		x, err := ecdh.X25519().GenerateKey(r)
		if err != nil {
			return Keys{}, err
		}
		return Keys{Signing: priv, Sealing: x}, nil
	}
	return Keys{}, errors.New("keys: could not generate an acceptable signing key")
}

// Dir is the key directory under a state directory.
func Dir(stateDir string) string { return filepath.Join(stateDir, "keys") }

// Exists reports whether a signing key file is present.
func Exists(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, signingFile))
	return err == nil
}

// Save writes both keys (0600) into dir (created 0700), replacing any earlier ones.
func Save(dir string, k Keys) error {
	if err := SaveStaged(dir, k); err != nil {
		return err
	}
	return CommitStaged(dir)
}

const stagedSuffix = ".new"

// SaveStaged writes both keys under staging names next to the current ones, which stay in use
// until CommitStaged (enrollment stages new keys until the platform accepts them).
func SaveStaged(dir string, k Keys) error {
	if err := fsutil.EnsurePrivateDir(dir); err != nil {
		return err
	}
	if err := fsutil.WritePrivate(filepath.Join(dir, sealingFile+stagedSuffix), k.Sealing.Bytes()); err != nil {
		return err
	}
	return fsutil.WritePrivate(filepath.Join(dir, signingFile+stagedSuffix), k.Signing.Seed())
}

// CommitStaged moves staged keys over the current ones (sealing, then signing) and syncs the
// directory. A crash between the two renames leaves a pair whose fingerprint matches no state
// file, which the agent refuses (re-enroll).
func CommitStaged(dir string) error {
	d, err := fsutil.OpenPrivate(dir, true)
	if err != nil {
		return err
	}
	defer d.Close()
	for _, f := range []string{sealingFile, signingFile} {
		if err := fsutil.CheckPrivate(filepath.Join(dir, f+stagedSuffix), false); err != nil {
			return err
		}
	}
	for _, f := range []string{sealingFile, signingFile} {
		if err := os.Rename(filepath.Join(dir, f+stagedSuffix), filepath.Join(dir, f)); err != nil {
			return err
		}
	}
	return fsutil.SyncDir(d)
}

// DiscardStaged removes staged keys, if any.
func DiscardStaged(dir string) error {
	for _, f := range []string{signingFile, sealingFile} {
		if err := os.Remove(filepath.Join(dir, f+stagedSuffix)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Staged reports whether either staged key file exists.
func Staged(dir string) bool {
	for _, f := range []string{signingFile, sealingFile} {
		if _, err := os.Lstat(filepath.Join(dir, f+stagedSuffix)); err == nil {
			return true
		}
	}
	return false
}

// Load reads and checks both keys.
func Load(dir string) (Keys, error) {
	if err := fsutil.CheckPrivate(dir, true); err != nil {
		return Keys{}, fmt.Errorf("keys: %w", err)
	}
	seed, err := fsutil.ReadPrivate(filepath.Join(dir, signingFile), ed25519.SeedSize)
	if err != nil {
		return Keys{}, fmt.Errorf("keys: %w", err)
	}
	defer clear(seed)
	if len(seed) != ed25519.SeedSize {
		return Keys{}, errors.New("keys: signing key file is not 32 bytes")
	}
	signing := ed25519.NewKeyFromSeed(seed)
	if !sig.AcceptablePublicKey(signing.Public().(ed25519.PublicKey)) {
		return Keys{}, errors.New("keys: signing key's public half is non-canonical or of small order")
	}
	raw, err := fsutil.ReadPrivate(filepath.Join(dir, sealingFile), 32)
	if err != nil {
		return Keys{}, fmt.Errorf("keys: %w", err)
	}
	defer clear(raw)
	if len(raw) != 32 {
		return Keys{}, errors.New("keys: sealing key file is not 32 bytes")
	}
	x, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		return Keys{}, fmt.Errorf("keys: sealing key: %w", err)
	}
	return Keys{Signing: signing, Sealing: x}, nil
}
