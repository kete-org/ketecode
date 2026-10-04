//go:build linux

// Command kete-job-init is PID 1 of a cloud job's microvm (the host agent's firecracker driver) or
// cloudvm (a provider VM per job) guest (module README "kete-job-init"; kete-code-platform ADR 0023
// rule 15). It ships in the job image and is unused on Fly. Stage 1 (no argument) runs on the
// read-only image root; stage 2 (`__guest`) runs from the overlay root it builds.
package main

import (
	"os"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/guestinit"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == guestinit.GuestArg {
		guestinit.Stage2(nil)
		return
	}
	if len(os.Args) != 1 {
		os.Stderr.WriteString("usage: kete-job-init (PID 1 of a job guest; no arguments)\n")
		os.Exit(2)
	}
	guestinit.Stage1()
}
