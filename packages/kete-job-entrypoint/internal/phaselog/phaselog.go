// Package phaselog writes the entrypoint's structured stdout: one JSON object per line,
// `{"ts","step","event","code"?,"exit_code"?}`. Steps and codes are fixed values from this
// package; a line never carries a message from git, kete, the platform or a credential (ADR 0019
// rule 8), so nothing here accepts free text.
package phaselog

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Step names one entrypoint step.
type Step string

const (
	StepBoot       Step = "boot"
	StepUsers      Step = "setup_users"
	StepSysctl     Step = "setup_sysctl"
	StepProc       Step = "setup_proc"
	StepFly        Step = "setup_fly"
	StepHost       Step = "setup_host"    // the host profile's signals (module README "Host profiles")
	StepKubeVM     Step = "setup_kubevm"  // kubevm: the config Secret unmounted, /proc/sys and the cgroup mount made writable
	StepBoundary   Step = "host_boundary" // the root host-boundary probe (every profile but fly)
	StepDirs       Step = "setup_dirs"
	StepCgroup     Step = "setup_cgroup"
	StepEgressConf Step = "egress_config"
	StepNft        Step = "egress_nft"
	StepProxy      Step = "egress_proxy"
	StepHelper     Step = "helper"
	StepGitVersion Step = "git_version" // root's git is at least gitops.MinVersion (fail closed)
	StepIsolation  Step = "isolation"
	StepClaim      Step = "claim"
	StepRestart    Step = "egress_restart"
	StepClone      Step = "clone"
	StepVerify     Step = "verify"
	StepRevoke     Step = "revoke"
	StepCloneDone  Step = "clone_done"  // POST …/clone-done: the platform deletes a Harness Code clone token
	StepFetch      Step = "fetch"       // an orchestrated job's extra refs, checked at their pinned commits
	StepPlanPrompt Step = "plan_prompt" // a node attempt's prompt, read from the plan file
	StepReviewDiff Step = "review_diff" // a review job's changed files and diff, added to the prompt
	StepAgentCopy  Step = "agent_copy"
	StepAgent      Step = "agent"
	StepStop       Step = "stop_agents"
	StepResult     Step = "result"
	StepBundle     Step = "bundle"
	StepUploads    Step = "uploads"
	StepOutbox     Step = "outbox" // kubevm: result, bundle, audit and proxy log written to the runner's outbox
	StepFinish     Step = "finish"
	StepDeadline   Step = "deadline"
	StepCancelled  Step = "cancelled"
	StepJob        Step = "job"
	StepAbort      Step = "abort"

	// kete-job-init's steps (PID 1 in microvm and cloudvm guests).
	StepInitKernel   Step = "init_kernel" // the shared-kernel guard, before anything is written
	StepInitMount    Step = "init_mount"
	StepInitRoot     Step = "init_root"
	StepInitNet      Step = "init_network"
	StepInitConfig   Step = "init_config"
	StepInitMetadata Step = "init_metadata_drop"
	StepInitStart    Step = "init_entrypoint"
	StepInitPower    Step = "init_poweroff"
)

// Code is a fixed failure or outcome code.
type Code string

const (
	CodeFailed         Code = "failed"
	CodeInvalid        Code = "invalid"
	CodeTimeout        Code = "timeout"
	CodeRefused        Code = "refused"
	CodeGone           Code = "gone"
	CodeProxyFailed    Code = "proxy_failed"
	CodeProcessesAlive Code = "processes_alive"
	CodeSymlink        Code = "symlink"
	CodeUnreadable     Code = "unreadable"
	CodeMissing        Code = "missing"
	CodeSignal         Code = "signal"       // SIGTERM/SIGINT: the job was aborted
	CodeRefMismatch    Code = "ref_mismatch" // an orchestrated job's branch isn't at its pinned commit

	// The isolation self-check's reasons (module README "Isolation check"): what the tool user
	// could reach, or why the check itself couldn't run.
	CodeFlyAPI       Code = "fly_api"       // Fly's machine API socket
	CodeHelperSocket Code = "helper_socket" // the root helper's socket
	CodeUnixSocket   Code = "unix_socket"   // any other listening unix socket
	CodeKeteDir      Code = "kete_dir"      // kete's home or socket directory
	CodeMetadata     Code = "metadata"      // 169.254.169.254
	CodeSixPN        Code = "sixpn"         // Fly's private network, fdaa::/16
	CodeResolver     Code = "resolver"      // a DNS resolver (resolv.conf's, Fly's fdaa::3)
	CodeLoopback     Code = "loopback"      // a privileged loopback port other than port B
	CodeControl      Code = "control"       // the probe couldn't reach its own control listener
	CodeProbe        Code = "probe"         // the probe didn't run, finish or answer

	// Host profiles (step setup_host): which signal didn't fit the profile.
	CodeFlySignals Code = "fly_signals" // Fly's variables or /.fly with a profile other than fly
	CodeSource     Code = "source"      // the values came from the wrong place for the profile
	CodeInit       Code = "init"        // PID 1 isn't kete-job-init (microvm, cloudvm)
	CodeVsock      Code = "vsock"       // a vsock device exists (microvm)
	CodeDMI        Code = "dmi"         // the firmware vendor doesn't match the provider (cloudvm)
	CodeGeneration Code = "generation"  // no reset generation (dedicated)
	// The process may share its kernel with other workloads (a container), so no kernel state may be
	// written: not the VM's own kernel (microvm, cloudvm), not the dedicated driver's set-up
	// (dedicated). hostprofile "shared-kernel guard".
	CodeSharedKernel Code = "shared_kernel"

	// The host-boundary probe's reasons (root, before the in-guest rules), and the tool user's
	// extra per-profile reasons in the isolation check.
	CodeGateway      Code = "gateway"          // the default gateway (the host) on a sample port
	CodePrivateRange Code = "private_range"    // an RFC 1918, CGNAT or ULA sample address
	CodeIPv6         Code = "ipv6"             // a public IPv6 sample address
	CodeConfigDisk   Code = "config_disk"      // a block device still holds the config disk header
	CodeMetadataDrop Code = "metadata_drop"    // cloudvm: kete-job-init's metadata drop table is missing
	CodeGuardedPath  Code = "guarded_path"     // a path the profile guards opens for the tool user
	CodeKubeAPI      Code = "kube_api"         // kubevm: the Kubernetes API (KUBERNETES_SERVICE_HOST:PORT)
	CodeNode         Code = "node"             // kubevm: one of the node's addresses on a sample port
	CodeConfigSecret Code = "config_secret"    // kubevm: the config Secret's volume is still mounted or not empty
	CodeOutbox       Code = "outbox"           // kubevm: the outbox volume is missing, not empty or not writable
	CodeRepository   Code = "repository"       // kubevm: the claim names another repository, or carries a clone
	CodeBase         Code = "base_unavailable" // kubevm: the commit the runner resolved can't be fetched
)

// Logger writes phase lines; safe for concurrent use.
type Logger struct {
	mu  sync.Mutex
	w   io.Writer
	now func() time.Time
}

// New writes to w.
func New(w io.Writer) *Logger { return &Logger{w: w, now: time.Now} }

type line struct {
	TS       string `json:"ts"`
	Step     Step   `json:"step"`
	Event    string `json:"event"`
	Code     Code   `json:"code,omitempty"`
	Class    string `json:"class,omitempty"`
	Errno    *int   `json:"errno,omitempty"`
	ExitCode *int   `json:"exit_code,omitempty"`
}

func (l *Logger) write(ln line) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	ln.TS = l.now().UTC().Format(time.RFC3339Nano)
	b, err := json.Marshal(ln)
	if err != nil {
		return
	}
	_, _ = l.w.Write(append(b, '\n'))
}

// Start marks a step as started.
func (l *Logger) Start(s Step) { l.write(line{Step: s, Event: "start"}) }

// OK marks a step as done.
func (l *Logger) OK(s Step) { l.write(line{Step: s, Event: "ok"}) }

// Fail marks a step as failed with a fixed code.
func (l *Logger) Fail(s Step, c Code) { l.write(line{Step: s, Event: "failed", Code: c}) }

// FailErr is Fail plus the error's fixed class and number (Classify); never the error's text.
func (l *Logger) FailErr(s Step, c Code, err error) {
	class, n := Classify(err)
	ln := line{Step: s, Event: "failed", Code: c, Class: class}
	if n != 0 {
		ln.Errno = &n
	}
	l.write(ln)
}

// Note records a fixed code against a step without failing it.
func (l *Logger) Note(s Step, c Code) { l.write(line{Step: s, Event: "note", Code: c}) }

// Exited records a child's exit code against a step (kete-job-init: the entrypoint's exit).
func (l *Logger) Exited(s Step, code int) { l.write(line{Step: s, Event: "exit", ExitCode: &code}) }

// Exit records the process's exit code.
func (l *Logger) Exit(code int) { l.write(line{Step: StepJob, Event: "exit", ExitCode: &code}) }

// Classed is implemented by errors that carry their own fixed class (launch stage 2, a platform
// status, a git exit). The class must be a constant, never derived from untrusted text.
type Classed interface {
	ErrorClass() (class string, n int)
}

// Classify maps an error to a fixed class and a number: "errno" (the errno), "timeout",
// "cancelled", "exit" (the exit code), a Classed error's own class, else "other" (0).
func Classify(err error) (string, int) {
	if err == nil {
		return "", 0
	}
	var c Classed
	if errors.As(err, &c) {
		return c.ErrorClass()
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return "errno", int(errno)
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded):
		return "timeout", 0
	case errors.Is(err, context.Canceled):
		return "cancelled", 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return "exit", ee.ExitCode()
	}
	return "other", 0
}
