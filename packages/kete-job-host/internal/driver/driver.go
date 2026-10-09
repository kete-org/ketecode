// Package driver is the agent's machine driver interface (ADR 0023 rules 7–8). A driver runs one
// job per machine: `firecracker` (a jailed microVM per job, P4) or `dedicated` (one job at a time
// on a verified-reset host, P5). The drivers are driver/firecracker and driver/dedicated; driver/fake is the
// test driver.
//
// Rules every driver keeps:
//   - The machine configuration in Spec.Config is delivered only on a root-only path (the
//     firecracker config disk, the dedicated config pipe) and never kept, logged, written to the
//     driver's own state or put on a kernel command line, in Firecracker's API or MMDS.
//   - Every call gets a context with a deadline (the agent's DriverTimeouts) and must return
//     promptly, with an error, once it is done; a call that ignores its context keeps that one
//     machine's worker busy (the agent doesn't overlap calls on a machine), so the machine is
//     never checked or stopped again until the call returns.
//   - The agent calls the driver concurrently for different machines and never concurrently for
//     the same machine; List may run alongside per-machine calls.
//   - Stop is idempotent and returns nil once nothing of the machine remains, including for a
//     machine the driver doesn't know.
//   - List returns every machine the driver holds, including ones the agent has no record of, so
//     the agent can destroy them at start (ADR 0023 rule 12).
//   - Logs returns only raw console/stdout lines since the last call; the agent filters them to
//     phase lines.
package driver

import (
	"context"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
)

// Spec is one machine to start.
type Spec struct {
	MachineID string
	JobID     string
	Image     string
	Deadline  time.Time
	Resources contract.Resources
	// Config is the machine configuration's canonical JSON. The agent clears the slice after
	// Start returns; a driver must not retain it.
	Config []byte
	// Repository is the run machine's runtime repository (job-host-v2; nil otherwise): the
	// kubernetes driver resolves it in the runner's registry for the job's local section.
	Repository *contract.RunRepository
}

// FailedError is a Status error that ends a machine still starting as `failed` with Reason (a
// job-host-v2 failed reason such as pod_unschedulable or image_pull_failed) instead of crashing
// it: the agent records the reason and removes what the driver holds (Stop).
type FailedError struct {
	Reason string
	Err    error
}

func (e *FailedError) Error() string { return "machine failed: " + e.Reason + ": " + e.Err.Error() }
func (e *FailedError) Unwrap() error { return e.Err }

// Status is a machine's observed status.
type Status int

const (
	// StatusRunning: the guest is running.
	StatusRunning Status = iota + 1
	// StatusStarting: started, not yet running.
	StatusStarting
	// StatusExited: the guest powered off by itself (the job ended).
	StatusExited
	// StatusCrashed: the VMM or process died unexpectedly.
	StatusCrashed
	// StatusGone: the driver holds no such machine.
	StatusGone
)

func (s Status) String() string {
	switch s {
	case StatusRunning:
		return "running"
	case StatusStarting:
		return "starting"
	case StatusExited:
		return "exited"
	case StatusCrashed:
		return "crashed"
	case StatusGone:
		return "gone"
	}
	return "unknown"
}

// Preparer is implemented by drivers that need per-image work before Start (the firecracker
// driver fetches the image by digest, verifies every blob and converts it to a read-only root
// file system, cached per digest). The agent calls it in the machine's worker, without its lock,
// after the assignment's checks and before Start, with its own timeout; an error fails the machine
// `image_unavailable`. It must be safe for concurrent calls with different or equal images.
type Preparer interface {
	Prepare(ctx context.Context, image string) error
}

// Blocker is implemented by drivers that can stop starts (contract starts_blocked: `host_table`
// when the host's nftables table is missing or changed, `disk_space`, `driver_unhealthy`). It is
// called with the agent's lock held, so it must return at once (a cached result, never I/O).
type Blocker interface {
	StartsBlocked() string
}

// IsolationGuard is implemented by drivers whose guests depend on host-level isolation (the
// firecracker driver's nftables table). The agent calls CheckIsolation on its own schedule
// (every few seconds, independent of the platform, without its lock); an error means the
// isolation is gone or altered: the agent destroys every live machine (`host_isolation_lost`)
// and refuses starts until it restarts.
type IsolationGuard interface {
	CheckIsolation(ctx context.Context) error
}

// Driver runs machines.
type Driver interface {
	Start(ctx context.Context, spec Spec) error
	Stop(ctx context.Context, machineID string) error
	Status(ctx context.Context, machineID string) (Status, error)
	List(ctx context.Context) ([]string, error)
	Logs(ctx context.Context, machineID string) ([][]byte, error)
}

// PublishSpec is one machine's publish request (job-host-v2 `publish`, with the platform's go-ahead).
type PublishSpec struct {
	MachineID  string
	JobID      string
	Repository contract.RunRepository
	Branch     string
	OpenMR     bool
}

// Publisher is implemented by drivers that publish a machine's outputs after its job ended
// (job-host-v2 state `publishing`; the kubernetes driver's publisher pods, enterprise runtime P3).
// The agent moves a machine whose run carries `publish` to `publishing` when its job exits, calls
// EndJob, waits for the platform's authorization, then StartPublish and PublishResult until done.
// Calls follow Driver's rules (per-machine serial, bounded by the context).
type Publisher interface {
	// CanPublish reports whether jobs of a repository can publish (a writer is configured).
	CanPublish(repository string) bool
	// EndJob removes what ran the job and keeps its outputs (idempotent).
	EndJob(ctx context.Context, machineID string) error
	// StartPublish starts publishing the machine's outputs (idempotent: one already started is kept).
	StartPublish(ctx context.Context, s PublishSpec) error
	// PublishResult reports the outcome once publishing ended (done), already checked against the
	// contract and carrying no boundary-gated field the publisher didn't produce. A publisher that
	// ended without a valid outcome is `failed`/`publisher_failed`. An error means it couldn't be
	// read (retried later).
	PublishResult(ctx context.Context, machineID string) (outcome contract.PublishOutcome, done bool, err error)
	// DiscardOutputs removes the publisher and, unless keepOutputs, the machine's outputs.
	DiscardOutputs(ctx context.Context, machineID string, keepOutputs bool) error
}
