package image

import (
	"context"
	"errors"
	"strings"
	"testing"
)

const ref = "ghcr.io/kete-org/kete-job@sha256:4f9c2b7a1e8d3c6f5a0b9e2d7c4f1a8b3e6d9c2f5a8b1e4d7c0f3a6b9e2d5c8f"

func TestAllowlist(t *testing.T) {
	a, err := NewAllowlist([]string{ref})
	if err != nil {
		t.Fatal(err)
	}
	if !a.Allowed(ref) {
		t.Fatal("exact ref refused")
	}
	for _, r := range []string{
		strings.Replace(ref, "4f9c", "4f9d", 1),                // other digest
		strings.Replace(ref, "ghcr.io", "docker.io", 1),        // other registry, same digest
		strings.Replace(ref, "kete-job@", "kete-job-evil@", 1), // other repository
		"ghcr.io/kete-org/kete-job:latest",                     // tag
		strings.ToUpper(ref),                                   // not canonical
		ref + " ",
	} {
		if a.Allowed(r) {
			t.Errorf("allowed %s", r)
		}
	}
	if _, err := NewAllowlist([]string{"ghcr.io/kete-org/kete-job:v1"}); err == nil {
		t.Fatal("tag accepted in the allowlist")
	}
}

func TestUnconfiguredFailsClosed(t *testing.T) {
	if err := (Unconfigured{}).Verify(context.Background(), ref); !errors.Is(err, ErrNoVerifier) {
		t.Fatal("unconfigured verifier accepted an image")
	}
}
