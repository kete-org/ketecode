//go:build kete_testdriver

package runner

import (
	"context"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
)

// acceptAll accepts every allowlisted image: placeholder pods run public test images that carry
// no Kete release signature. Test builds only.
type acceptAll struct{}

func (acceptAll) Verify(context.Context, string) error { return nil }

func placeholderVerifier() image.Verifier { return acceptAll{} }

// kubeVMVerifier: test builds run locally built, unsigned job images (kind CI).
func kubeVMVerifier() image.Verifier { return acceptAll{} }
