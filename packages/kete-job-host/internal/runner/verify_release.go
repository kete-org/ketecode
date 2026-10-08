//go:build !kete_testdriver

package runner

import "github.com/kete-org/ketecode/packages/kete-job-host/internal/image"

// placeholderVerifier is never reached in a release build (podDriver refuses the placeholder
// first); it fails closed regardless.
func placeholderVerifier() image.Verifier { return image.Unconfigured{} }
