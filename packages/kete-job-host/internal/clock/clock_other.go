//go:build !linux

package clock

// System is never synchronised off Linux: the agent is Linux-only.
func System() Checker { return system{} }

type system struct{}

func (system) Synced() (bool, error) { return false, ErrUnsupported }
