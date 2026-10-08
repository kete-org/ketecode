//go:build !kete_testdriver

package kubernetes

import "time"

// PlaceholderAvailable reports whether this build has the placeholder pod driver: never in a
// release build, where placeholder pods would report machines running that run no job (CLAUDE.md
// §10: no fake implementations outside tests). The runner refuses pod_driver "placeholder" here.
const PlaceholderAvailable = false

// TestBuild is false in a release build: SharedKernelTestClass is refused (runner.Run).
const TestBuild = false

// Placeholder returns nil in a release build (New refuses a nil PodFunc).
func Placeholder(string, map[string]int, func() time.Time) PodFunc { return nil }
