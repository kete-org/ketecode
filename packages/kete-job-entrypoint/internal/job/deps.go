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
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/gitops"
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

	// Orchestrated jobs (jobs-v1 "Orchestrated jobs"; orchestration.go): the commit a full ref
	// names, the pristine copy remade at a pinned base the ref has moved past, the extra refs
	// fetched into refs/kete/* (clone phase only, with the clone credential), a blob of the
	// pristine copy (≤ max bytes, else gitops.ErrOutputTooLarge), and refs/kete/* copied into the
	// agent's working copy.
	ResolveCommit(ctx context.Context, gitDir, ref string) (string, error)
	PinBase(ctx context.Context, url, ref, username, token, baseSHA, dest string) error
	FetchRefs(ctx context.Context, gitDir, url, username, token string, refs []gitops.RefSpec, depth1 bool) error
	CatBlob(ctx context.Context, gitDir, object string, max int64) ([]byte, error)
	CopyKeteRefs(ctx context.Context, pristine, repo string) error
}

// KeteEnv is what `kete`'s environment needs from the claim.
type KeteEnv struct {
	GatewayURL  string
	PlatformURL string
	GatewayKey  string
	// JobID is the job's id (KETE_JOB_ID): an orchestration's coordinator turn calls its own
	// job's orchestration routes with it. Not a secret.
	JobID string
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
	// BuildBundle builds the change bundle; kind is its orchestrations-v1 rule (bundle.Kind*):
	// a coordinator turn's bundle is a plan bundle exactly when it holds the plan file.
	BuildBundle(ctx context.Context, baseSHA string, kind bundle.Kind) (*bundle.Result, error)
}

// Runtime is the kubevm profile's runtime-repository path (jobs-v1 "Runtime repositories"; enterprise
// runtime spec §4.5): the claim must name exactly the repository the runner resolved, the clone uses
// the runner's local URL and read credential, the commit the clone got is recorded as the base,
// the result is bounded by the runner's data boundary, the outputs go to the runner's outbox (never
// uploads) and finish is `{"outbox":true}`. nil on every other profile.
type Runtime struct {
	Platform RuntimePlatform
	Repo     bootenv.LocalRepository
	// CloneURL is Repo.CloneURL normalized and CloneEntry its egress allowlist entry (the bare
	// host for 443, `host:port` otherwise).
	CloneURL, CloneEntry string
	Boundary             platform.DataBoundary
	Outbox               Outbox
	// Head returns the commit refs/heads/<ref> names in the pristine copy.
	Head func(ctx context.Context, gitDir, ref string) (string, error)
}

// RuntimePlatform is the platform client's kubevm calls.
type RuntimePlatform interface {
	ClaimRuntime(ctx context.Context, token, localName string, now time.Time) (*platform.RuntimeClaimResponse, error)
	FinishOutbox(ctx context.Context) error
}

// Outbox is the runner's per-job outbox (internal/outbox): files, then the manifest that names
// them, written last.
type Outbox interface {
	Put(name string, r io.Reader, max int64) (OutboxFile, error)
	Commit(m OutboxManifest) error
}

// OutboxFile is one written file.
type OutboxFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// OutboxManifest is manifest.json, the outbox's index (module README "Outbox"): what the job
// produced, for the runner's publisher. Never sent to the platform.
type OutboxManifest struct {
	Version    int                   `json:"version"`
	JobID      string                `json:"job_id"`
	Repository string                `json:"repository"`
	Ref        string                `json:"ref"`
	BaseSHA    string                `json:"base_sha,omitempty"`
	Branch     string                `json:"branch,omitempty"`
	Outcome    string                `json:"outcome"`
	ExitCode   int                   `json:"exit_code"`
	PushError  string                `json:"push_error,omitempty"`
	Files      map[string]OutboxFile `json:"files"`
	Notes      []string              `json:"notes"`
	WrittenAt  string                `json:"written_at"`
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
	Runtime  *Runtime // kubevm only
}
