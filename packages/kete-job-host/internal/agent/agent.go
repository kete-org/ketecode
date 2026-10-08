// Package agent is the host agent's core (ADR 0023 rules 9–13, 17, 19): the poll/report loop,
// desired-state handling, the assignment checks, the machine state machine, the deadline killer
// and restart reconcile. It drives machines only through driver.Driver and talks to the platform
// only through client.Client; it never listens on a port.
//
// Concurrency: a.mu guards the machine table and is never held across a driver call, a request or
// an image signature verification.
// Every driver call on a machine runs in that machine's worker goroutine (one at a time per
// machine, so the driver never sees two calls for one machine at once), each with its own
// timeout (DriverTimeouts). A hung driver call therefore holds up only its own machine: the
// deadline killer keeps destroying the others, and reports keep flowing.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/client"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/clock"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/image"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/keys"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/phase"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/state"
)

// DriverTimeouts bound each driver call (and the image signature check, Verify). Zero fields take
// the defaults.
type DriverTimeouts struct {
	Start, Stop, Status, Logs, List, Verify, Prepare time.Duration
}

func (t DriverTimeouts) withDefaults() DriverTimeouts {
	def := func(d, v time.Duration) time.Duration {
		if d <= 0 {
			return v
		}
		return d
	}
	return DriverTimeouts{
		Start: def(t.Start, 2*time.Minute), Stop: def(t.Stop, time.Minute), Status: def(t.Status, 10*time.Second),
		Logs: def(t.Logs, 10*time.Second), List: def(t.List, 30*time.Second),
		Verify: def(t.Verify, 2*time.Minute), Prepare: def(t.Prepare, 30*time.Minute),
	}
}

// Options configure an Agent.
type Options struct {
	Config   config.Config
	Keys     keys.Keys
	Driver   driver.Driver
	Verifier image.Verifier
	Client   *client.Client
	Clock    clock.Checker
	Versions contract.Versions
	Log      *slog.Logger
	// Now is the wall clock (tests use a fake one shared with the fake platform).
	Now func() time.Time
	// Interval turns the platform's seconds into a delay (tests shorten it). Default: seconds.
	Interval func(seconds int) time.Duration
	// SuperviseEvery is the deadline killer and status check period. Default 2 s.
	SuperviseEvery time.Duration
	// IsolationEvery is the host isolation check period (driver.IsolationGuard). Default 5 s.
	IsolationEvery time.Duration
	// DriverTimeouts bound each driver call.
	DriverTimeouts DriverTimeouts
	// Store persists the state (nil: the state file under Config.StateDir).
	Store state.Store
	// V2 runs the agent under job-host-v2 (the Kubernetes runner, ADR 0011): v2 reports and
	// responses, the v2 seal label, the run machine's repository rules. nil: job-host-v1.
	V2 *V2
}

// V2 is what a job-host-v2 agent adds to its reports and assignment checks
// (`docs/platform/job-host-v2.md` "Poll").
type V2 struct {
	// Kubernetes is the API server's version (versions.kubernetes, kubernetes driver only).
	Kubernetes string
	// RuntimeClasses are the VM-isolated RuntimeClasses the host allows (kubernetes driver only).
	RuntimeClasses []string
	// Repositories are the runtime repository names the host serves. A run machine naming another
	// fails repository_unknown before anything starts.
	Repositories []string
	// Advertise reports Repositories (else the report's repositories is null).
	Advertise bool
	// Boundary is the host's effective data boundary.
	Boundary contract.DataBoundary
	// PublishHold is how long a machine waits in `publishing` for the platform's authorization
	// before it reports failed/hold_expired (Helm publish holdHours; default 24 h).
	PublishHold time.Duration
}

// ErrHalted means the agent stopped polling and holds no machine: the operator must act
// (re-enroll, or fix the key the platform refuses).
var ErrHalted = errors.New("agent halted")

// Agent is the host agent.
type Agent struct {
	o     Options
	t     DriverTimeouts
	allow image.Allowlist
	store state.Store

	mu         sync.Mutex
	idle       *sync.Cond // signalled when active drops to 0
	st         state.State
	phase      map[string]*phase.Buffer
	sigHalted  bool // signature_invalid: polling stopped until restart
	saveFailed bool // the state file can't be written: starts blocked (disk_space)
	isoLost    bool // host isolation lost: starts blocked (host_table) until the agent restarts
	backoff    client.Backoff

	busy    map[string]bool               // a worker runs for this machine
	again   map[string]bool               // run the worker once more when it finishes
	pending map[string]*driver.Spec       // started machines whose Start hasn't been called yet
	prep    map[string]*prepJob           // accepted machines whose signature/config/prepare work is due
	cancels map[string]context.CancelFunc // a running signature check or preparation, by machine
	cleanup map[string]bool               // failed starts the driver may still hold
	active  int                           // running workers
	slow    int                           // workers inside a signature check or image preparation

	// job-host-v2 publishing: each run machine as the last accepted desired state named it (its
	// `publish.authorized` is the platform's go-ahead), and the publishing machines whose job is
	// known to be removed (EndJob done since this agent started).
	runs     map[string]contract.RunMachineV2
	jobEnded map[string]bool
}

// New loads the state file (the host must be enrolled) and builds an agent.
func New(o Options) (*Agent, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Interval == nil {
		o.Interval = func(s int) time.Duration { return time.Duration(s) * time.Second }
	}
	if o.SuperviseEvery <= 0 {
		o.SuperviseEvery = 2 * time.Second
	}
	if o.IsolationEvery <= 0 {
		o.IsolationEvery = 5 * time.Second
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Verifier == nil {
		o.Verifier = image.Unconfigured{}
	}
	if o.Driver == nil || o.Client == nil || o.Clock == nil || o.Keys.Signing == nil || o.Keys.Sealing == nil {
		return nil, errors.New("agent: driver, client, clock and keys are required")
	}
	allow, err := image.NewAllowlist(o.Config.ImageAllowlist)
	if err != nil {
		return nil, err
	}
	store := o.Store
	if store == nil {
		store = state.FileStore{Path: state.Path(o.Config.StateDir)}
	}
	if o.V2 != nil {
		if err := o.V2.Boundary.Validate(); err != nil {
			return nil, fmt.Errorf("agent: %w", err)
		}
		if o.V2.PublishHold <= 0 {
			o.V2.PublishHold = 24 * time.Hour
		}
	}
	st, err := store.Load()
	if err != nil {
		return nil, err
	}
	if !st.Enrolled() {
		return nil, errors.New("agent: this host is not enrolled (run `kete-job-host enroll`)")
	}
	if st.Fingerprint != o.Keys.Fingerprint() {
		return nil, errors.New("agent: the stored keys are not the keys this host enrolled with")
	}
	a := &Agent{
		o: o, t: o.DriverTimeouts.withDefaults(), allow: allow, store: store, st: st, phase: map[string]*phase.Buffer{},
		busy: map[string]bool{}, again: map[string]bool{}, pending: map[string]*driver.Spec{}, cleanup: map[string]bool{},
		prep: map[string]*prepJob{}, cancels: map[string]context.CancelFunc{},
		runs: map[string]contract.RunMachineV2{}, jobEnded: map[string]bool{},
	}
	a.idle = sync.NewCond(&a.mu)
	for _, m := range st.Machines {
		a.phase[m.MachineID] = &phase.Buffer{}
	}
	return a, nil
}

// Snapshot returns a copy of the state (tests, doctor).
func (a *Agent) Snapshot() state.State {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.st
	s.Machines = slices.Clone(a.st.Machines)
	return s
}

// Wait blocks until no machine worker is running (every driver call has returned or timed out).
func (a *Agent) Wait() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for a.active > 0 {
		a.idle.Wait()
	}
}

// waitFast blocks until every running worker is idle or inside a signature check or image
// preparation (which may take minutes and must not hold up reports).
func (a *Agent) waitFast() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for a.active > a.slow {
		a.idle.Wait()
	}
}

// slowWork marks the calling worker as inside slow work (+1) or out of it (-1) (a.mu not held).
func (a *Agent) slowWork(d int) {
	a.mu.Lock()
	a.slow += d
	a.idle.Broadcast()
	a.mu.Unlock()
}

// ---------------------------------------------------------------- machine table helpers (a.mu held)

func (a *Agent) find(id string) *state.Machine {
	for i := range a.st.Machines {
		if a.st.Machines[i].MachineID == id {
			return &a.st.Machines[i]
		}
	}
	return nil
}

func (a *Agent) live() []string {
	var ids []string
	for _, m := range a.st.Machines {
		if !contract.Terminal(m.State) {
			ids = append(ids, m.MachineID)
		}
	}
	return ids
}

func (a *Agent) freeSlots() int {
	if a.generationSpent() {
		return 0
	}
	return max(0, a.o.Config.Slots-len(a.live()))
}

// generationSpent reports a dedicated host whose generation has started its one job (ADR 0023
// rule 8): until a verified reset gives the host a new identity, nothing else starts.
func (a *Agent) generationSpent() bool {
	return a.o.Config.Driver == contract.DriverDedicated && a.st.GenerationSpentBy != ""
}

// startsBlocked is why no new machine may start (the report's starts_blocked), or "". Once a
// dedicated generation is spent nothing starts any more, not even a redelivery of the machine that
// spent it (the spend happens at `starting`, after every check, so no legitimate path comes back).
func (a *Agent) startsBlocked() string {
	switch {
	case a.o.Config.StartsBlocked != "":
		return a.o.Config.StartsBlocked
	case a.isoLost:
		return contract.BlockedHostTable
	case a.saveFailed:
		return contract.BlockedDiskSpace
	case a.generationSpent():
		return contract.BlockedGenerationSpent
	}
	if b, ok := a.o.Driver.(driver.Blocker); ok {
		valid := contract.ValidStartsBlocked
		if a.o.V2 != nil {
			valid = contract.ValidStartsBlockedV2
		}
		if r := b.StartsBlocked(); valid(r) {
			return r
		}
	}
	return ""
}

func (a *Agent) save() {
	if err := a.store.Save(a.st); err != nil {
		if !a.saveFailed {
			a.o.Log.Error("state_save_failed", "error", err.Error())
		}
		a.saveFailed = true
		return
	}
	a.saveFailed = false
}

func (a *Agent) transition(m *state.Machine, to, reason string) {
	m.State, m.Reason, m.Since = to, reason, a.o.Now().UTC()
	if to != contract.StateStopping {
		m.StopReason = ""
	}
	a.o.Log.Info("machine", "machine_id", m.MachineID, "job_id", m.JobID, "state", to, "reason", reason)
}

func (a *Agent) addLines(id string, lines [][]byte) {
	b := a.phase[id]
	if b == nil {
		b = &phase.Buffer{}
		a.phase[id] = b
	}
	for _, l := range lines {
		b.Add(l)
	}
}

func (a *Agent) dropPending(id string) {
	if p := a.pending[id]; p != nil {
		clear(p.Config)
		delete(a.pending, id)
	}
	delete(a.prep, id)
	if c := a.cancels[id]; c != nil {
		c() // a stop interrupts the machine's signature check or image preparation
	}
}

// requestStop marks a live machine stopping with reason (persisted) and wakes its worker.
func (a *Agent) requestStop(ctx context.Context, id, reason string) {
	m := a.find(id)
	if m == nil || contract.Terminal(m.State) {
		return
	}
	if m.State != contract.StateStopping {
		a.transition(m, contract.StateStopping, "")
		m.StopReason = reason
		a.save()
	}
	a.dropPending(id)
	a.kick(ctx, id)
}

func (a *Agent) destroyAll(ctx context.Context, reason string) {
	for _, id := range a.live() {
		a.requestStop(ctx, id, reason)
	}
}

// kick runs the machine's worker, or asks the running one to go round once more.
func (a *Agent) kick(ctx context.Context, id string) {
	if a.busy[id] {
		a.again[id] = true
		return
	}
	a.busy[id] = true
	a.active++
	go a.work(ctx, id)
}

// ---------------------------------------------------------------- workers (a.mu not held)

func (a *Agent) work(ctx context.Context, id string) {
	for {
		a.step(ctx, id)
		a.mu.Lock()
		if a.again[id] {
			delete(a.again, id)
			a.mu.Unlock()
			continue
		}
		delete(a.busy, id)
		a.active--
		a.idle.Broadcast()
		a.mu.Unlock()
		return
	}
}

type action int

const (
	actNone action = iota
	actCleanup
	actStop
	actStart
	actObserve
	actPrepare
	actPublish
)

// next decides a machine's next driver action (and runs the deadline killer's decision).
func (a *Agent) next(id string) (action, *driver.Spec) {
	a.mu.Lock()
	defer a.mu.Unlock()
	m := a.find(id)
	if m == nil || contract.Terminal(m.State) {
		if a.cleanup[id] {
			return actCleanup, nil
		}
		return actNone, nil
	}
	// A publishing machine's job has ended: its wait is bounded by the hold time and its publisher
	// by its own deadline, not by the job's (the platform authorizes publishing after the job's
	// finish, possibly close to its deadline).
	if m.State != contract.StateStopping && m.State != contract.StatePublishing {
		now := a.o.Now()
		switch {
		case now.After(m.Deadline.Add(contract.DeadlineGrace)):
			a.requestStopNoKick(m, contract.ReasonDeadline)
		case now.Sub(m.AcceptedAt) > contract.MachineMaxAge:
			a.requestStopNoKick(m, contract.ReasonMaxAge)
		}
	}
	if m.State == contract.StateStopping {
		a.dropPending(id)
		return actStop, nil
	}
	if p := a.pending[id]; p != nil && m.State == contract.StateStarting {
		delete(a.pending, id)
		return actStart, p
	}
	if m.State == contract.StatePreparing {
		if a.prep[id] != nil {
			return actPrepare, nil
		}
		return actNone, nil // its prepare work is running in this worker already
	}
	if m.State == contract.StatePublishing {
		return actPublish, nil
	}
	return actObserve, nil
}

func (a *Agent) requestStopNoKick(m *state.Machine, reason string) {
	if c := a.cancels[m.MachineID]; c != nil {
		c()
	}
	a.transition(m, contract.StateStopping, "")
	m.StopReason = reason
	a.save()
}

func (a *Agent) withTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, d)
}

func (a *Agent) drvStop(ctx context.Context, id string) error {
	c, cancel := a.withTimeout(ctx, a.t.Stop)
	defer cancel()
	return a.o.Driver.Stop(c, id)
}

func (a *Agent) drvLogs(ctx context.Context, id string) [][]byte {
	c, cancel := a.withTimeout(ctx, a.t.Logs)
	defer cancel()
	lines, err := a.o.Driver.Logs(c, id)
	if err != nil {
		return nil
	}
	return lines
}

func (a *Agent) drvStatus(ctx context.Context, id string) (driver.Status, error) {
	c, cancel := a.withTimeout(ctx, a.t.Status)
	defer cancel()
	return a.o.Driver.Status(c, id)
}

func (a *Agent) drvStart(ctx context.Context, s driver.Spec) error {
	c, cancel := a.withTimeout(ctx, a.t.Start)
	defer cancel()
	return a.o.Driver.Start(c, s)
}

// step performs the machine's pending driver work: stop, start then observe, or observe.
func (a *Agent) step(ctx context.Context, id string) {
	for range 4 {
		act, spec := a.next(id)
		switch act {
		case actNone:
			return
		case actCleanup:
			err := a.drvStop(ctx, id)
			a.mu.Lock()
			if err == nil {
				delete(a.cleanup, id)
			}
			a.mu.Unlock()
			return
		case actStop:
			lines := a.drvLogs(ctx, id)
			err := a.drvStop(ctx, id)
			if err == nil {
				err = a.discardUnpublished(ctx, id)
			}
			a.mu.Lock()
			a.addLines(id, lines)
			if m := a.find(id); m != nil && m.State == contract.StateStopping {
				if err != nil {
					a.o.Log.Error("driver_stop_failed", "machine_id", id, "error", err.Error())
				} else {
					a.transition(m, contract.StateDestroyed, m.StopReason)
					a.save()
				}
			}
			a.mu.Unlock()
			return
		case actPublish:
			a.publish(ctx, id)
			return
		case actPrepare:
			a.prepare(ctx, id)
			continue
		case actStart:
			err := a.drvStart(ctx, *spec)
			clear(spec.Config)
			if err != nil {
				a.o.Log.Error("driver_start_failed", "machine_id", id, "error", err.Error())
				serr := a.drvStop(ctx, id)
				a.mu.Lock()
				if serr != nil {
					a.cleanup[id] = true // supervise retries the Stop
				}
				m := a.find(id)
				if m != nil && m.State == contract.StateStarting {
					reason := contract.ReasonDriverFailed
					var fe *driver.FailedError
					if errors.As(err, &fe) && a.o.V2 != nil && contract.FailedReasonV2(fe.Reason) {
						reason = fe.Reason // job-host-v2: e.g. repository_unavailable
					}
					a.transition(m, contract.StateFailed, reason)
					a.save()
				}
				a.mu.Unlock()
				continue // a stop requested meanwhile is handled by the next round
			}
			continue // observe once
		case actObserve:
			lines := a.drvLogs(ctx, id)
			status, err := a.drvStatus(ctx, id)
			a.mu.Lock()
			a.addLines(id, lines)
			m := a.find(id)
			if m == nil || contract.Terminal(m.State) || m.State == contract.StateStopping {
				a.mu.Unlock()
				continue
			}
			var fe *driver.FailedError
			switch {
			case errors.As(err, &fe) && a.o.V2 != nil && contract.FailedReasonV2(fe.Reason) && m.State == contract.StateStarting:
				// The driver says this start can't succeed (job-host-v2: pod_unschedulable,
				// image_pull_failed): failed with its reason, and what it holds is removed.
				a.o.Log.Warn("machine_start_failed", "machine_id", id, "reason", fe.Reason, "error", fe.Err.Error())
				a.transition(m, contract.StateFailed, fe.Reason)
				a.cleanup[id] = true
				a.save()
				a.mu.Unlock()
				continue
			case err != nil:
				a.mu.Unlock()
				return
			case status == driver.StatusExited && m.WantsPublish:
				// job-host-v2: the job ended; its outputs wait for the platform's go-ahead.
				a.transition(m, contract.StatePublishing, "")
				a.save()
				a.mu.Unlock()
				continue
			case status == driver.StatusExited:
				a.requestStopNoKick(m, contract.ReasonExited)
				a.mu.Unlock()
				continue
			case status == driver.StatusCrashed || status == driver.StatusGone:
				a.requestStopNoKick(m, contract.ReasonCrashed)
				a.mu.Unlock()
				continue
			case status == driver.StatusRunning && m.State == contract.StateStarting:
				a.transition(m, contract.StateRunning, "")
				a.save()
			}
			a.mu.Unlock()
			return
		}
	}
}

// ---------------------------------------------------------------- assignment (a.mu held)

// prepJob is an accepted assignment whose slower checks run in the machine's worker.
type prepJob struct {
	rm       contract.RunMachineV2
	deadline time.Time
}

// checkCheap runs the assignment checks that need no I/O, in the contract's order (a.mu held).
func (a *Agent) checkCheap(rm contract.RunMachineV2, deadline time.Time) string {
	switch {
	case !a.o.Now().Before(deadline):
		return contract.ReasonDeadlinePassed
	case a.startsBlocked() != "":
		return contract.ReasonStartsBlocked
	case len(a.live()) > a.o.Config.Slots: // the candidate is already in the table
		return contract.ReasonNoFreeSlot
	case !a.allow.Allowed(rm.Image):
		return contract.ReasonImageNotAllowed
	}
	if a.o.V2 != nil {
		return a.checkV2(rm)
	}
	return ""
}

// checkV2 applies job-host-v2's run machine rules after v1's (a.mu held; no I/O): the machine's
// own shape (JobHostV2RunMachine; JobHostV2KubernetesRunMachine on a kubernetes host: a repository
// is required) → config_invalid; a repository outside the host's registry → repository_unknown.
// A machine asking for a push is refused config_invalid unless the driver publishes and the
// repository has a writer (rather than run and silently never published).
func (a *Agent) checkV2(rm contract.RunMachineV2) string {
	check := rm.Validate
	if a.o.Config.Driver == contract.DriverKubernetes {
		check = rm.ValidateKubernetes
	}
	if check() != nil {
		return contract.ReasonConfigInvalid
	}
	if rm.Repository != nil && !slices.Contains(a.o.V2.Repositories, rm.Repository.Name) {
		return contract.ReasonRepositoryUnknown
	}
	if rm.Publish != nil {
		if pub, ok := a.o.Driver.(driver.Publisher); !ok || !pub.CanPublish(rm.Repository.Name) {
			return contract.ReasonConfigInvalid
		}
	}
	return ""
}

// checkSealed opens and checks the sealed configuration (a.mu held; no I/O) and returns the failed
// reason, or "" and the configuration's canonical JSON (the caller clears it).
func (a *Agent) checkSealed(rm contract.RunMachineV2) (string, []byte) {
	if rm.Config == nil {
		return contract.ReasonConfigInvalid, nil
	}
	sk := a.o.Keys.SealingPrivate()
	defer clear(sk)
	open, validate := seal.Open, seal.MachineConfig.Validate
	if a.o.V2 != nil {
		open, validate = seal.OpenV2, seal.MachineConfig.ValidateV2
	}
	pt, err := open(sk, seal.Binding{HostID: a.st.HostID, MachineID: rm.MachineID, JobID: rm.JobID, Generation: a.st.Generation}, *rm.Config)
	if err != nil {
		return contract.ReasonConfigUndecryptable, nil
	}
	defer clear(pt)
	cfg, err := seal.ParseMachineConfig(pt)
	if err != nil {
		return contract.ReasonConfigInvalid, nil
	}
	// ADR 0023 rule 13: the platform URL is checked before anything else in the plaintext is used.
	if cfg.PlatformURL != a.o.Config.Origin {
		return contract.ReasonPlatformMismatch, nil
	}
	if validate(cfg) != nil {
		return contract.ReasonConfigInvalid, nil
	}
	canon, err := cfg.Canonical()
	if err != nil || !bytes.Equal(canon, pt) || cfg.JobID != rm.JobID || cfg.HostProfile != a.o.Config.HostProfile() {
		clear(canon)
		return contract.ReasonConfigInvalid, nil
	}
	if cfg.HostProfile == seal.ProfileDedicated && cfg.HostGeneration != a.st.Generation {
		clear(canon)
		return contract.ReasonGenerationMismatch, nil
	}
	return "", canon
}

// failPreparing fails a machine still preparing (a.mu held).
func (a *Agent) failPreparing(id, reason string) {
	if m := a.find(id); m != nil && m.State == contract.StatePreparing {
		a.transition(m, contract.StateFailed, reason)
		a.save()
	}
}

// prepare runs an accepted machine's slower work in its worker, without a.mu: the image
// signature (ADR 0023 rule 17; I/O, own timeout), then the sealed configuration's checks (under
// a.mu, no I/O), then the driver's per-image preparation (fetch, verify, convert; own timeout).
// The reasons keep the contract's order: image_signature_invalid (or image_unavailable when the
// signature can't be fetched) → config_* → generation_mismatch → image_unavailable → (Start)
// driver_failed. A stop requested meanwhile wins: the work's result is discarded.
func (a *Agent) prepare(ctx context.Context, id string) {
	a.mu.Lock()
	job := a.prep[id]
	delete(a.prep, id)
	a.mu.Unlock()
	if job == nil {
		return
	}
	// mctx ends when the machine is stopped (dropPending, the deadline killer) or the agent stops.
	mctx, mcancel := context.WithCancel(ctx)
	a.mu.Lock()
	a.cancels[id] = mcancel
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.cancels, id)
		a.mu.Unlock()
		mcancel()
	}()
	vc, cancel := a.withTimeout(mctx, a.t.Verify)
	a.slowWork(1)
	err := a.o.Verifier.Verify(vc, job.rm.Image)
	a.slowWork(-1)
	cancel()
	if mctx.Err() != nil {
		// Stopped: the next round destroys it. Agent stopping: the record stays preparing
		// (reconcile drops it and the platform delivers it again).
		return
	}
	a.mu.Lock()
	m := a.find(id)
	if m == nil || m.State != contract.StatePreparing {
		a.mu.Unlock()
		return
	}
	if err != nil {
		reason := contract.ReasonImageSignatureInvalid
		if errors.Is(err, image.ErrUnavailable) {
			reason = contract.ReasonImageUnavailable
		}
		a.o.Log.Warn("image_verify_failed", "machine_id", id, "image", job.rm.Image, "error", err.Error())
		a.failPreparing(id, reason)
		a.mu.Unlock()
		return
	}
	reason, cfg := a.checkSealed(job.rm)
	if reason != "" {
		a.failPreparing(id, reason)
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	if p, ok := a.o.Driver.(driver.Preparer); ok {
		pc, cancel := a.withTimeout(mctx, a.t.Prepare)
		a.slowWork(1)
		err := p.Prepare(pc, job.rm.Image)
		a.slowWork(-1)
		cancel()
		if mctx.Err() != nil {
			clear(cfg)
			return
		}
		if err != nil {
			clear(cfg)
			a.o.Log.Warn("image_prepare_failed", "machine_id", id, "image", job.rm.Image, "error", err.Error())
			a.mu.Lock()
			a.failPreparing(id, contract.ReasonImageUnavailable)
			a.mu.Unlock()
			return
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	m = a.find(id)
	switch {
	case m == nil || m.State != contract.StatePreparing:
		clear(cfg)
		return
	case !a.o.Now().Before(job.deadline):
		clear(cfg)
		a.failPreparing(id, contract.ReasonDeadlinePassed)
		return
	case a.startsBlocked() != "":
		clear(cfg)
		a.failPreparing(id, contract.ReasonStartsBlocked)
		return
	}
	// ADR 0023 rule 8: a dedicated host's generation is good for one job. It is spent here, the
	// last moment before anything of the job runs on the host, and durably: a failed save fails
	// the machine instead of starting it, and the in-memory spend still blocks every other start.
	if a.o.Config.Driver == contract.DriverDedicated && a.st.GenerationSpentBy == "" {
		a.st.GenerationSpentBy = id
		a.o.Log.Info("generation_spent", "machine_id", id, "job_id", job.rm.JobID, "generation", a.st.Generation)
	}
	a.transition(m, contract.StateStarting, "")
	a.save()
	if a.saveFailed && a.o.Config.Driver == contract.DriverDedicated {
		clear(cfg)
		a.transition(m, contract.StateFailed, contract.ReasonStartsBlocked)
		a.save()
		return
	}
	a.pending[id] = &driver.Spec{
		MachineID: id, JobID: job.rm.JobID, Image: job.rm.Image, Deadline: job.deadline, Resources: job.rm.Resources, Config: cfg,
		Repository: job.rm.Repository,
	}
}

func (a *Agent) assign(ctx context.Context, rm contract.RunMachineV2) {
	now := a.o.Now().UTC()
	deadline, _ := time.Parse(time.RFC3339Nano, rm.Deadline) // validated by PollResponse.Validate
	a.st.Machines = append(a.st.Machines, state.Machine{
		MachineID: rm.MachineID, JobID: rm.JobID, Image: rm.Image, Deadline: deadline.UTC(),
		AcceptedAt: now, State: contract.StatePreparing, Since: now,
	})
	if a.o.V2 != nil && rm.Publish != nil && contract.ValidJobBranch(rm.Publish.Branch) {
		m := &a.st.Machines[len(a.st.Machines)-1]
		m.WantsPublish, m.PublishBranch = true, rm.Publish.Branch
	}
	a.phase[rm.MachineID] = &phase.Buffer{}
	m := a.find(rm.MachineID)
	a.o.Log.Info("machine", "machine_id", m.MachineID, "job_id", m.JobID, "state", m.State, "reason", "")
	if reason := a.checkCheap(rm, deadline); reason != "" {
		a.transition(m, contract.StateFailed, reason)
		a.save()
		return
	}
	a.save()
	a.prep[rm.MachineID] = &prepJob{rm: rm, deadline: deadline}
	a.kick(ctx, rm.MachineID)
}

// apply applies a fresh, accepted desired state. sentTerminal holds the machine ids the
// answered report carried in a terminal state (tombstones that may now be forgotten).
func (a *Agent) apply(ctx context.Context, d desiredState, sentTerminal map[string]bool) {
	run := map[string]bool{}
	clear(a.runs)
	for _, rm := range d.Run {
		run[rm.MachineID] = true
		a.runs[rm.MachineID] = rm
	}
	destroy := map[string]bool{}
	for _, id := range d.Destroy {
		destroy[id] = true
	}
	// ADR 0023 rule 12: every held machine the desired state doesn't run is destroyed.
	for _, id := range a.live() {
		if !run[id] || destroy[id] {
			a.requestStop(ctx, id, contract.ReasonDesired)
		}
	}
	for _, rm := range d.Run {
		if a.find(rm.MachineID) != nil || destroy[rm.MachineID] {
			continue // held, or a tombstone: a machine id is never started twice
		}
		a.assign(ctx, rm)
	}
	kept := a.st.Machines[:0]
	for _, m := range a.st.Machines {
		if contract.Terminal(m.State) && sentTerminal[m.MachineID] && !run[m.MachineID] && !destroy[m.MachineID] {
			delete(a.phase, m.MachineID)
			continue
		}
		kept = append(kept, m)
	}
	a.st.Machines = kept
	rev := d.Revision
	a.st.AppliedRevision = &rev
	a.save()
}

// ---------------------------------------------------------------- report and poll

// buildReport builds the report in v2's shape (a superset of v1's; poll writes v1's for a v1 host).
func (a *Agent) buildReport() (contract.ReportV2, map[string]bool, map[string]bool) {
	ms := slices.Clone(a.st.Machines)
	sort.SliceStable(ms, func(i, j int) bool {
		ti, tj := contract.Terminal(ms[i].State), contract.Terminal(ms[j].State)
		if ti != tj {
			return !ti
		}
		return ms[i].AcceptedAt.Before(ms[j].AcceptedAt)
	})
	limit := contract.ReportMaxMachines
	if a.o.V2 != nil {
		limit = contract.V2ReportMaxMachines
	}
	if len(ms) > limit {
		ms = ms[:limit]
	}
	sent, sentTerminal := map[string]bool{}, map[string]bool{}
	v := a.o.Versions
	r := contract.ReportV2{
		Version: contract.V2Version, Generation: a.st.Generation,
		Versions:        contract.VersionsV2{Agent: v.Agent, Firecracker: v.Firecracker, GuestKernel: v.GuestKernel, HostKernel: v.HostKernel},
		Slots:           contract.SlotsV2{Total: a.o.Config.Slots, Free: a.freeSlots()},
		AppliedRevision: a.st.AppliedRevision, Machines: []contract.ObservedMachineV2{},
	}
	if v2 := a.o.V2; v2 != nil {
		r.Versions.Kubernetes = v2.Kubernetes
		r.RuntimeClasses = slices.Clone(v2.RuntimeClasses)
		r.Images = slices.Clone(a.o.Config.ImageAllowlist)
		if v2.Advertise {
			repos := slices.Clone(v2.Repositories)
			if repos == nil {
				repos = []string{}
			}
			r.Repositories = &repos
		}
		r.Boundary = v2.Boundary
	}
	if b := a.startsBlocked(); b != "" {
		r.StartsBlocked = &b
	}
	for _, m := range ms {
		om := contract.ObservedMachineV2{MachineID: m.MachineID, State: m.State, Since: contract.FormatTime(m.Since), Reason: m.Reason}
		if m.JobID != "" {
			jid := m.JobID
			om.JobID = &jid
		}
		b := a.phase[m.MachineID]
		if b == nil {
			b = &phase.Buffer{}
			a.phase[m.MachineID] = b
		}
		om.PhaseLines, om.PhaseLinesDropped = b.Take()
		if m.Publish != nil && m.State == contract.StateDestroyed && m.Reason == contract.ReasonExited {
			p := *m.Publish
			om.Publish = &p
		}
		r.Machines = append(r.Machines, om)
		sent[m.MachineID] = true
		if contract.Terminal(m.State) {
			sentTerminal[m.MachineID] = true
		}
	}
	return r, sent, sentTerminal
}

func (a *Agent) settlePhase(sent map[string]bool, ack bool) {
	for id := range sent {
		if b := a.phase[id]; b != nil {
			if ack {
				b.Ack()
			} else {
				b.Nack()
			}
		}
	}
}

// Outcome names what a poll did (logs and tests).
type Outcome string

// Outcomes.
const (
	OutcomeApplied       Outcome = "applied"
	OutcomeClockUnsynced Outcome = "clock_unsynchronised"
	OutcomeNetwork       Outcome = "network_error"
	OutcomeRefused       Outcome = "refused"
	OutcomeDiscarded     Outcome = "discarded"
	OutcomeHalted        Outcome = "halted"
)

// Result is one poll's outcome and the delay before the next.
type Result struct {
	Outcome Outcome
	Reason  string
	Delay   time.Duration
}

// Halted reports why polling stopped, or "".
func (a *Agent) Halted() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.haltedLocked()
}

func (a *Agent) haltedLocked() string {
	if a.st.Halted != "" {
		return a.st.Halted
	}
	if a.sigHalted {
		return contract.ErrSignatureInvalid
	}
	return ""
}

// PollOnce sends one report and applies the answer, then waits for the machine work it started
// (each driver call is bounded by its timeout), except signature checks and image preparation,
// which continue in the background.
func (a *Agent) PollOnce(ctx context.Context) Result {
	if h := a.Halted(); h != "" {
		return Result{Outcome: OutcomeHalted, Reason: h}
	}
	// ADR 0023 rule 9: never poll while the clock is unsynchronised.
	if ok, err := a.o.Clock.Synced(); !ok {
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		a.o.Log.Warn("clock_unsynchronised", "error", msg)
		return Result{Outcome: OutcomeClockUnsynced, Delay: a.o.Interval(contract.PollIntervalSecond)}
	}
	res := a.poll(ctx)
	a.waitFast()
	return res
}

func (a *Agent) poll(ctx context.Context) Result {
	a.mu.Lock()
	report, sent, sentTerminal := a.buildReport()
	hostID, revision := a.st.HostID, a.st.AppliedRevision
	a.mu.Unlock()
	body, err := a.encodeReport(report)
	if err != nil {
		a.mu.Lock()
		a.settlePhase(sent, false)
		a.mu.Unlock()
		a.o.Log.Error("report_invalid", "error", err.Error())
		return Result{Outcome: OutcomeRefused, Reason: "report_invalid", Delay: a.backoff.Next()}
	}
	resp, err := a.o.Client.Post(ctx, contract.PollPath, hostID, a.o.Keys.Signing, body, 200)
	if err != nil {
		a.mu.Lock()
		a.settlePhase(sent, false)
		a.mu.Unlock()
		return a.handleError(ctx, err)
	}
	pr, perr := a.decodeResponse(resp.Body)
	why := ""
	switch {
	case perr != nil:
		why = "invalid"
	case pr.InReplyTo != resp.Nonce:
		why = "in_reply_to"
	case pr.HostID != hostID:
		why = "host_id"
	case revision != nil && pr.Desired.Revision < *revision:
		why = "stale_revision"
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if why != "" {
		a.settlePhase(sent, false)
		a.o.Log.Warn("response_discarded", "why", why, "request_id", resp.RequestID)
		return Result{Outcome: OutcomeDiscarded, Reason: why, Delay: a.backoff.Next()}
	}
	a.settlePhase(sent, true)
	a.backoff.Reset()
	a.apply(ctx, pr.Desired, sentTerminal)
	a.o.Log.Debug("poll_applied", "revision", pr.Desired.Revision, "status", pr.Status, "request_id", resp.RequestID)
	return Result{Outcome: OutcomeApplied, Delay: a.o.Interval(pr.NextPollAfter)}
}

func (a *Agent) handleError(ctx context.Context, err error) Result {
	var ae *client.APIError
	if !errors.As(err, &ae) {
		a.o.Log.Warn("poll_failed", "error", err.Error())
		return Result{Outcome: OutcomeNetwork, Delay: a.backoff.Next()}
	}
	a.o.Log.Warn("poll_refused", "status", ae.Status, "reason", ae.Reason, "request_id", ae.RequestID)
	res := Result{Outcome: OutcomeRefused, Reason: ae.Reason}
	a.mu.Lock()
	defer a.mu.Unlock()
	switch ae.Reason {
	case contract.ErrHostPending:
		res.Delay = a.o.Interval(30) + time.Duration(rand.Int64N(int64(a.o.Interval(30))+1))
	case contract.ErrHostDisabled:
		a.destroyAll(ctx, contract.ReasonHostDisabled)
		res.Delay = a.o.Interval(60)
	case contract.ErrHostRevoked, contract.ErrGenerationMismatch, contract.ErrContractMismatch:
		a.destroyAll(ctx, contract.ReasonHostDisabled)
		a.st.Halted = state.HaltRevoked
		switch ae.Reason {
		case contract.ErrGenerationMismatch:
			a.st.Halted = state.HaltGenerationMismatch
		case contract.ErrContractMismatch:
			a.st.Halted = state.HaltContractMismatch
		}
		a.save()
		a.o.Log.Error("halted", "reason", ae.Reason, "action", "the host must be re-enrolled (kete-job-host enroll --replace)")
		res.Outcome = OutcomeHalted
	case contract.ErrSignatureInvalid:
		// Machines keep running until they end or the deadline killer destroys them; the agent
		// reports nothing meanwhile (README "The poll loop").
		a.sigHalted = true
		a.o.Log.Error("halted", "reason", ae.Reason, "action", "the platform refuses this host's key; check the host's enrollment, then restart the agent")
		res.Outcome = OutcomeHalted
	case contract.ErrClockSkew:
		res.Delay = a.o.Interval(contract.PollIntervalSecond) // the clock is checked again before the next poll
	case contract.ErrNonceReplayed:
		res.Delay = a.o.Interval(1)
	default:
		res.Delay = max(a.backoff.Next(), ae.RetryAfter)
	}
	return res
}

// ---------------------------------------------------------------- supervise and reconcile

// Supervise starts a pass of status checks, phase-line collection and the deadline killer (ADR
// 0023 rule 12) for every live machine whose worker is idle; it needs nothing from the platform
// and doesn't wait for the driver (Wait does). A machine whose driver call hangs is skipped until
// its call times out; the others are not held up.
func (a *Agent) Supervise(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, id := range a.live() {
		if !a.busy[id] {
			a.kick(ctx, id)
		}
	}
	for id := range a.cleanup {
		if !a.busy[id] {
			a.kick(ctx, id)
		}
	}
}

// CheckIsolation runs the driver's host isolation check (driver.IsolationGuard; a no-op for
// drivers without one) outside a.mu. If isolation is gone, every live machine is destroyed with
// `host_isolation_lost` and an agent phase line (step `host_isolation`, `failed`, code
// `host_table`), and starts stay blocked (`host_table`) until the agent restarts — fail closed,
// needing nothing from the platform. It returns the check's error.
func (a *Agent) CheckIsolation(ctx context.Context) error {
	g, ok := a.o.Driver.(driver.IsolationGuard)
	if !ok {
		return nil
	}
	c, cancel := a.withTimeout(ctx, 15*time.Second)
	err := g.CheckIsolation(c)
	cancel()
	if err == nil || ctx.Err() != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.isoLost {
		a.o.Log.Error("host_isolation_lost", "error", err.Error(), "action", "destroying every machine; starts blocked until the agent restarts")
	}
	a.isoLost = true
	line := fmt.Sprintf(`{"ts":%q,"step":"host_isolation","event":"failed","code":"host_table"}`, contract.FormatTime(a.o.Now()))
	for _, id := range a.live() {
		m := a.find(id)
		if m.State == contract.StateStopping {
			continue // already going, with its own reason
		}
		a.addLines(id, [][]byte{[]byte(line)})
		a.requestStop(ctx, id, contract.ReasonHostIsolationLost)
	}
	return err
}

// Reconcile runs at start: machines the driver holds without a live record are destroyed (ADR
// 0023 rule 12) and reported unattributed; records whose machine vanished are reported
// destroyed; running machines are re-adopted. A durable halt (revoked, generation mismatch)
// destroys every machine. An error (the driver can't list or stop) leaves things for a retry.
func (a *Agent) Reconcile(ctx context.Context) error {
	lc, cancel := a.withTimeout(ctx, a.t.List)
	held, err := a.o.Driver.List(lc)
	cancel()
	if err != nil {
		return fmt.Errorf("agent: driver list: %w", err)
	}
	inDriver := map[string]bool{}
	var unknown []string
	a.mu.Lock()
	for _, id := range held {
		inDriver[id] = true
		if m := a.find(id); m == nil || contract.Terminal(m.State) {
			unknown = append(unknown, id)
		}
	}
	a.mu.Unlock()
	for _, id := range unknown {
		if err := a.drvStop(ctx, id); err != nil {
			return fmt.Errorf("agent: stopping unknown machine: %w", err)
		}
		a.o.Log.Warn("reconcile_unknown_destroyed", "machine_id", id)
		a.mu.Lock()
		if a.find(id) == nil && contract.ValidUUID(id) {
			now := a.o.Now().UTC()
			a.st.Machines = append(a.st.Machines, state.Machine{
				MachineID: id, AcceptedAt: now, State: contract.StateDestroyed, Since: now, Reason: contract.ReasonDesired,
			})
			a.phase[id] = &phase.Buffer{}
		}
		a.mu.Unlock()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	kept := a.st.Machines[:0]
	for _, m := range a.st.Machines {
		if m.State == contract.StatePreparing && !inDriver[m.MachineID] {
			delete(a.phase, m.MachineID) // never started: the platform delivers it again
			continue
		}
		kept = append(kept, m)
	}
	a.st.Machines = kept
	for _, id := range a.live() {
		m := a.find(id)
		switch {
		case a.busy[id]:
			a.kick(ctx, id) // its worker goes round again
		case m.State == contract.StatePublishing:
			// Its job pod is gone by design; the publisher, if started, is picked up again.
			a.kick(ctx, id)
		case !inDriver[id] && m.State == contract.StateStopping:
			a.transition(m, contract.StateDestroyed, m.StopReason)
		case !inDriver[id]:
			a.transition(m, contract.StateDestroyed, contract.ReasonCrashed)
		default:
			a.kick(ctx, id) // stop if stopping, else observe: running re-adopted, exited or gone destroyed
		}
	}
	if a.st.Halted != "" {
		a.destroyAll(ctx, contract.ReasonHostDisabled)
	}
	a.save()
	return nil
}

// Run supervises (deadline killer first, independent of everything else), reconciles (retrying
// with backoff until it succeeds), then polls until ctx ends or the agent halts with no machine
// left (ErrHalted).
func (a *Agent) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	sctx, stopSupervise := context.WithCancel(ctx)
	defer func() { stopSupervise(); wg.Wait(); a.Wait() }()
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(a.o.SuperviseEvery)
		defer t.Stop()
		for {
			a.Supervise(sctx)
			select {
			case <-sctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	// The host isolation check (ADR 0023 rule 7), on its own bounded schedule: a hung check
	// never delays the deadline killer, and neither needs the platform.
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(a.o.IsolationEvery)
		defer t.Stop()
		for {
			_ = a.CheckIsolation(sctx)
			select {
			case <-sctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	delay := a.o.Interval(10)
	for {
		err := a.Reconcile(ctx)
		if err == nil {
			break
		}
		a.o.Log.Error("reconcile_failed", "error", err.Error(), "retry_in", delay.String())
		if err := sleep(ctx, delay); err != nil {
			return err
		}
		delay = min(delay*2, a.o.Interval(300))
	}
	for {
		if h := a.Halted(); h != "" {
			a.mu.Lock()
			n := len(a.live())
			a.mu.Unlock()
			if n == 0 {
				return fmt.Errorf("%w: %s", ErrHalted, h)
			}
			if err := sleep(ctx, a.o.SuperviseEvery); err != nil {
				return err
			}
			continue
		}
		res := a.PollOnce(ctx)
		if res.Outcome == OutcomeHalted {
			continue
		}
		if err := sleep(ctx, res.Delay); err != nil {
			return err
		}
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ---------------------------------------------------------------- wire (job-host-v1 or v2)

// desiredState is a fresh desired state in v2's shape (v1's run machines carry no repository or
// publish).
type desiredState struct {
	Revision int64
	Run      []contract.RunMachineV2
	Destroy  []string
}

// pollResponse is a validated poll response, either contract.
type pollResponse struct {
	InReplyTo     string
	HostID        string
	Status        string
	NextPollAfter int
	Desired       desiredState
}

// encodeReport validates the report under the agent's contract and marshals it: v2 as built, v1
// as v1's Report (the same fields, no version and no v2 additions).
func (a *Agent) encodeReport(r contract.ReportV2) ([]byte, error) {
	if a.o.V2 != nil {
		if err := r.Validate(); err != nil {
			return nil, err
		}
		return json.Marshal(r)
	}
	v1 := contract.Report{
		Generation: r.Generation,
		Versions:   contract.Versions{Agent: r.Versions.Agent, Firecracker: r.Versions.Firecracker, GuestKernel: r.Versions.GuestKernel, HostKernel: r.Versions.HostKernel},
		Slots:      contract.Slots{Total: r.Slots.Total, Free: r.Slots.Free}, StartsBlocked: r.StartsBlocked,
		AppliedRevision: r.AppliedRevision, Machines: make([]contract.ObservedMachine, 0, len(r.Machines)),
	}
	for _, m := range r.Machines {
		v1.Machines = append(v1.Machines, contract.ObservedMachine{
			MachineID: m.MachineID, JobID: m.JobID, State: m.State, Since: m.Since, Reason: m.Reason,
			PhaseLines: m.PhaseLines, PhaseLinesDropped: m.PhaseLinesDropped,
		})
	}
	if err := v1.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(v1)
}

// decodeResponse decodes and validates a poll response under the agent's contract. A v2 response
// without `version: 2` is refused (discarded, like a wrong in_reply_to).
func (a *Agent) decodeResponse(body []byte) (pollResponse, error) {
	if a.o.V2 != nil {
		p, err := contract.ParsePollResponseV2(body)
		if err != nil {
			return pollResponse{}, err
		}
		return pollResponse{
			InReplyTo: p.InReplyTo, HostID: p.HostID, Status: p.Status, NextPollAfter: p.NextPollAfter,
			Desired: desiredState{Revision: p.Desired.Revision, Run: p.Desired.Run, Destroy: p.Desired.Destroy},
		}, nil
	}
	var p contract.PollResponse
	if err := json.Unmarshal(body, &p); err != nil {
		return pollResponse{}, err
	}
	if err := p.Validate(); err != nil {
		return pollResponse{}, err
	}
	run := make([]contract.RunMachineV2, 0, len(*p.Desired.Run))
	for _, m := range *p.Desired.Run {
		run = append(run, contract.RunMachineV2{
			MachineID: m.MachineID, JobID: m.JobID, Image: m.Image, Deadline: m.Deadline, Resources: m.Resources, Config: m.Config,
		})
	}
	return pollResponse{
		InReplyTo: p.InReplyTo, HostID: p.HostID, Status: p.Status, NextPollAfter: p.NextPollAfter,
		Desired: desiredState{Revision: *p.Desired.Revision, Run: run, Destroy: *p.Desired.Destroy},
	}, nil
}

// ---------------------------------------------------------------- publishing (job-host-v2)

// publish advances a machine in `publishing` (its worker; a.mu not held): the job's pod is removed
// (its outputs kept); without the platform's go-ahead — `publish.authorized` in the last accepted
// desired state, which still runs the machine — it waits up to the hold time; with it the driver's
// publisher runs once; the outcome is recorded first, then the publisher and (except after
// `failed`) the outputs are removed, and the machine ends destroyed/exited with the outcome on
// its tombstone. Every step is retried by the next supervise round when it fails.
func (a *Agent) publish(ctx context.Context, id string) {
	pub, ok := a.o.Driver.(driver.Publisher)
	a.mu.Lock()
	m := a.find(id)
	if !ok || a.o.V2 == nil || m == nil || m.State != contract.StatePublishing {
		a.mu.Unlock()
		return
	}
	ended, started, since, recorded := a.jobEnded[id], m.PublishStarted, m.Since, m.Publish != nil
	rm, inRun := a.runs[id]
	a.mu.Unlock()

	if !ended {
		c, cancel := a.withTimeout(ctx, a.t.Stop)
		err := pub.EndJob(c, id)
		cancel()
		if err != nil {
			a.o.Log.Warn("publish_end_job_failed", "machine_id", id, "error", err.Error())
			return
		}
		a.mu.Lock()
		a.jobEnded[id] = true
		a.mu.Unlock()
	}
	var outcome contract.PublishOutcome
	switch {
	case recorded:
	case !started:
		authorized := inRun && rm.Publish != nil && rm.Publish.Authorized && rm.Repository != nil
		if !authorized || a.o.Now().Sub(since) > a.o.V2.PublishHold {
			if a.o.Now().Sub(since) <= a.o.V2.PublishHold {
				return // waiting for the platform's go-ahead
			}
			outcome = contract.PublishOutcome{Status: contract.PublishFailed, Reason: "hold_expired"}
			break
		}
		c, cancel := a.withTimeout(ctx, a.t.Start)
		err := pub.StartPublish(c, driver.PublishSpec{MachineID: id, JobID: rm.JobID, Repository: *rm.Repository, Branch: rm.Publish.Branch, OpenMR: rm.Publish.OpenMR})
		cancel()
		if err != nil {
			a.o.Log.Warn("publish_start_failed", "machine_id", id, "error", err.Error())
			return
		}
		a.mu.Lock()
		if m := a.find(id); m != nil && m.State == contract.StatePublishing {
			m.PublishStarted = true
			if contract.ValidJobBranch(rm.Publish.Branch) {
				m.PublishBranch = rm.Publish.Branch
			}
			a.o.Log.Info("publish_started", "machine_id", id, "job_id", m.JobID)
			a.save()
		}
		a.mu.Unlock()
		return
	default:
		c, cancel := a.withTimeout(ctx, a.t.Status)
		o, done, err := pub.PublishResult(c, id)
		cancel()
		if err != nil || !done {
			return
		}
		outcome = o
	}

	a.mu.Lock()
	m = a.find(id)
	if m == nil || m.State != contract.StatePublishing {
		a.mu.Unlock()
		return
	}
	if !recorded {
		o := a.boundOutcome(outcome, m.PublishBranch)
		m.Publish = &o
		a.o.Log.Info("publish_outcome", "machine_id", id, "job_id", m.JobID, "status", o.Status, "reason", o.Reason)
		a.save()
	}
	keep := m.Publish.Status == contract.PublishFailed && m.Publish.Reason != "hold_expired"
	a.mu.Unlock()
	c, cancel := a.withTimeout(ctx, a.t.Stop)
	err := pub.DiscardOutputs(c, id, keep)
	cancel()
	if err != nil {
		a.o.Log.Warn("publish_cleanup_failed", "machine_id", id, "error", err.Error())
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if m := a.find(id); m != nil && m.State == contract.StatePublishing {
		delete(a.jobEnded, id)
		a.transition(m, contract.StateDestroyed, contract.ReasonExited)
		a.save()
	}
}

// boundOutcome applies the report's rules to a publisher's outcome: the branch is the platform's
// (job metadata), the references are dropped when the boundary omits them, and an outcome that
// still doesn't fit the contract (for instance `created` without its SHAs while references are
// sent) becomes failed/publisher_failed.
func (a *Agent) boundOutcome(o contract.PublishOutcome, branch string) contract.PublishOutcome {
	o.Branch = branch
	if a.o.V2.Boundary.PublishRefs == "omit" {
		o.BaseSHA, o.CommitSHA, o.MR = "", "", nil
	}
	bad := o.Validate() != nil ||
		(a.o.V2.Boundary.PublishRefs == "send" && o.Status == contract.PublishCreated && (o.BaseSHA == "" || o.CommitSHA == "" || branch == ""))
	if bad {
		return contract.PublishOutcome{Status: contract.PublishFailed, Reason: "publisher_failed", Branch: branch}
	}
	return o
}

// discardUnpublished removes the outputs of a machine that asked to publish and is being
// destroyed because the platform dropped it (desired) or the host was disabled: it is never
// published (job-host-v2 "Desired state"). Other ends (crash, deadline) leave the outputs to the
// driver's own expiry.
func (a *Agent) discardUnpublished(ctx context.Context, id string) error {
	pub, ok := a.o.Driver.(driver.Publisher)
	a.mu.Lock()
	m := a.find(id)
	discard := ok && m != nil && m.WantsPublish && m.State == contract.StateStopping &&
		(m.StopReason == contract.ReasonDesired || m.StopReason == contract.ReasonHostDisabled)
	a.mu.Unlock()
	if !discard {
		return nil
	}
	c, cancel := a.withTimeout(ctx, a.t.Stop)
	defer cancel()
	return pub.DiscardOutputs(c, id, false)
}
