// Package image decides whether the agent may run a job image (ADR 0023 rule 17): the platform
// must name it by digest, the exact reference must be in the operator's local allowlist, and its
// release signature must verify against the release identity. A compromised platform therefore
// can't make a host run arbitrary code.
//
// Signature verification is the Verifier interface; the production implementation is Sigstore
// (verify.go: cosign v3 keyless bundles checked with sigstore-go against ReleaseIdentity —
// `kete-release.yml` on a `kete-v*` tag of kete-org/ketecode, issuer
// https://token.actions.githubusercontent.com — and the Sigstore trusted root from TUF).
// Unconfigured refuses every image (the agent's fail-closed default when no verifier is given).
// Store (store.go) fetches an allowlisted image by digest, verifies every blob and converts it to
// the read-only ext4 root file system the firecracker driver boots, cached per digest.
package image

import (
	"context"
	"errors"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// Verifier checks an image's release signature by reference (`registry/repo@sha256:…`).
type Verifier interface {
	Verify(ctx context.Context, ref string) error
}

// ErrNoVerifier is Unconfigured's answer.
var ErrNoVerifier = errors.New("image: no signature verifier configured")

// Unconfigured refuses every image.
type Unconfigured struct{}

// Verify implements Verifier.
func (Unconfigured) Verify(context.Context, string) error { return ErrNoVerifier }

// Allowlist is the operator's exact image references.
type Allowlist struct{ refs map[string]bool }

// NewAllowlist builds an allowlist; every entry must be a digest reference.
func NewAllowlist(refs []string) (Allowlist, error) {
	a := Allowlist{refs: map[string]bool{}}
	for _, r := range refs {
		if !contract.ValidImageRef(r) {
			return Allowlist{}, errors.New("image: allowlist entries must be <registry>/<repository>@sha256:<digest>")
		}
		a.refs[r] = true
	}
	return a, nil
}

// Allowed reports an exact, well-formed match (registry, repository and digest).
func (a Allowlist) Allowed(ref string) bool { return contract.ValidImageRef(ref) && a.refs[ref] }
