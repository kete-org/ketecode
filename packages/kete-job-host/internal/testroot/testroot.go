// Package testroot gives tests a directory whose ancestors pass the agent's file rules
// (root-owned, not writable by group or others): a fresh directory directly under "/". The
// agent's private files must be owned by root, so these tests run as root (Docker, or sudo in CI).
// Tests only.
package testroot

import (
	"os"
	"testing"
)

// Dir returns a new root-owned 0700 directory under "/", removed when the test ends.
func Dir(t testing.TB) string {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("this test needs root (the agent's files must be root-owned): run it in golang:1.26-bookworm via Docker, or with sudo")
	}
	d, err := os.MkdirTemp("/", "kete-job-host-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	return d
}
