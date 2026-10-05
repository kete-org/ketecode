// Package job is the entrypoint's orchestrator (module README "Steps"): the network guard, the
// helper, claim, clone, the agent run, and the report, under a hard deadline. Every side effect
// is behind an interface (Deps), so the outcome table, the timeout math, the deadline and the
// proxy-exit handling are unit-tested with fakes; internal/entry wires the real implementations.
package job

import (
	"context"
	"io"
	"syscall"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/egress"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
)

// Proxy is one running egress proxy instance.
type Proxy interface {
	Phase(phase string) error
	Stats() (egress.Stats, error)
	Stop()
	Exited() <-chan struct{}
	Planned() bool
	CAPEM() []byte
}

// Egress applies the firewall and starts proxy instances.
type Egress interface {
	Firewall(ctx context.Context, first egress.Instance) error
	Start(ctx context.Context, inst egress.Instance) (Proxy, error)
}

// Helper is the running root helper.
type Helper interface {
	Exited() <-chan struct{}
	Stop()
	Kill()
}

// Kete is the running `kete job run`.
type Kete interface {
	Done() <-chan struct{}
	ExitCode() int
	Signal(sig syscall.Signal)
}

// Platform is the callback client.
type Platform interface {
	SetCA(caPEM []byte) error
	SetCallbackToken(token string)
	Claim(ctx context.Context, token string) (*platform.ClaimResponse, error)
	Events(ctx context.Context, e platform.Event) error
	Result(ctx context.Context, raw []byte) error
	Uploads(ctx context.Context, bundle bool) (*platform.UploadURLs, error)
	Put(ctx context.Context, url, contentType string, r io.Reader, size int64) error
	Finish(ctx context.Context, pushError string) error
	Revoke(ctx context.Context, cloneHost, token string) error
	CloneDone(ctx context.Context) error
}

// Git is root's git.
type Git interface {
	CheckBranch(ctx context.Context, name string) bool
	Clone(ctx context.Context, url, ref, username, token, dest string) error
	Verify(ctx context.Context, gitDir, ref, baseSHA string) error
	AgentCopy(ctx context.Context, pristine, repo, branch, baseSHA string) error
}

// KeteEnv is what `kete`'s environment needs from the claim.
type KeteEnv struct {
	GatewayURL  string
	PlatformURL string
	GatewayKey  string
}

// Machine is the OS side of the run.
type Machine interface {
	StartHelper(ctx context.Context) (Helper, error)
	// CheckIsolation is the isolation self-check (internal/isolation), run as the tool user after
	// the firewall, the proxy and the helper are up and before claim; any error aborts before
	// claim. A *isolation.Failure carries the fixed reason.
	CheckIsolation(ctx context.Context) error
	PrepareWorktree() error // after the agent copy: hand it to the tool user and the job group
	WriteSpec(spec []byte) error
	StartKete(ctx context.Context, env KeteEnv) (Kete, error)
	KeteExtra() (int, error)
	// Reap is step 6a: cgroup.kill both job cgroups and wait until they're empty and no process
	// of the kete or tool uid is left; an error means something survived.
	Reap(ctx context.Context) error
	// KillNow is the hard deadline's kill: cgroup.kill both, no waiting.
	KillNow()
	KillKete()
	ReadKeteStdout() ([]byte, error)
	// OpenAudit opens what `kete` wrote to its audit pipe (piece A3), after Reap: it waits for the
	// pipe's reader to finish, then opens the root-owned copy. ErrAuditTooLarge when `kete` passed
	// MaxAuditUpload (the reader stopped and closed the pipe); ErrAuditReaderStuck when the reader
	// didn't finish in time.
	OpenAudit() (io.ReadCloser, int64, error)
	OpenProxyLog() (io.ReadCloser, int64, error)
	BuildBundle(ctx context.Context, baseSHA string) (*bundle.Result, error)
}

// Deps is everything Run needs.
type Deps struct {
	Cfg      layout.Config
	Log      *phaselog.Logger
	Boot     bootenv.Values
	Egress   Egress
	Platform Platform
	Git      Git
	Machine  Machine
	Now      func() time.Time
}
