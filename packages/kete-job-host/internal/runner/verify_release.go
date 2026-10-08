//go:build !kete_testdriver

package runner

import "github.com/kete-org/ketecode/packages/kete-job-host/internal/image"

// placeholderVerifier is never reached in a release build (podDriver refuses the placeholder
// first); it fails closed regardless.
func placeholderVerifier() image.Verifier { return image.Unconfigured{} }

// kubeVMVerifier verifies job images as the host agent does: cosign keyless signatures by the
// release workflow, against the Sigstore trusted root from TUF, cached in the controller's
// writable cache volume (the chart's emptyDir).
func kubeVMVerifier() image.Verifier {
	return image.Sigstore{Identity: image.ReleaseIdentity, Trusted: image.TUFTrustedRoot(image.TUFDir(CacheDir))}
}
