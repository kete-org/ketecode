// Package clock answers whether the host's clock is synchronised. The agent never polls while it
// isn't (ADR 0023 rule 9): a signature's `created` must be within 60 s of the platform's clock,
// and a skewed clock would also misjudge deadlines.
package clock

import "errors"

// Checker reports whether the system clock is synchronised.
type Checker interface {
	Synced() (bool, error)
}

// ErrUnsupported is returned where the kernel has no synchronisation status the agent can read.
var ErrUnsupported = errors.New("clock: synchronisation status not available on this OS")

// Fixed is a Checker with a fixed answer (tests, and `doctor` output formatting).
type Fixed bool

// Synced implements Checker.
func (f Fixed) Synced() (bool, error) { return bool(f), nil }
