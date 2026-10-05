package job

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/egress"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/gitops"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/isolation"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
	pl "github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
)

// Push errors (finish).
const (
	PushProcessesAlive = "processes_alive"
	PushSymlink        = "symlink"
	PushUnreadable     = "unreadable"
	PushProxyFailed    = "proxy_failed"
)

// EffectiveTimeout is ADR 0018 rule 9: floor(min(policy.timeout, (deadline − now − reserve) / unit)).
func EffectiveTimeout(policyTimeout int, deadline, now time.Time, reserve, unit time.Duration) int {
	left := deadline.Sub(now) - reserve
	if left <= 0 {
		return 0
	}
	eff := int(left / unit)
	if policyTimeout < eff {
		eff = policyTimeout
	}
	return eff
}

// ParseKeteResult picks the result v1 object out of `kete job run --json`'s stdout: the whole
// trimmed output, or else its last non-empty line, that is a JSON object with version 1, a string
// outcome and an integer exit_code. The bytes are returned verbatim.
func ParseKeteResult(out []byte) ([]byte, bool) {
	valid := func(b []byte) bool {
		var m map[string]json.RawMessage
		if json.Unmarshal(b, &m) != nil {
			return false
		}
		var v int
		var outcome string
		var code float64
		if json.Unmarshal(m["version"], &v) != nil || v != 1 {
			return false
		}
		if json.Unmarshal(m["outcome"], &outcome) != nil || outcome == "" {
			return false
		}
		if json.Unmarshal(m["exit_code"], &code) != nil || code != float64(int(code)) {
			return false
		}
		return true
	}
	trimmed := []byte(strings.TrimSpace(string(out)))
	if len(trimmed) > 0 && valid(trimmed) {
		return trimmed, true
	}
	lines := strings.Split(string(trimmed), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if valid([]byte(line)) {
			return []byte(line), true
		}
		break
	}
	return nil, false
}

// The audit sink's failures (Machine.OpenAudit, piece A3).
var (
	ErrAuditTooLarge    = errors.New("audit log over the upload limit")
	ErrAuditReaderStuck = errors.New("audit pipe reader did not finish")
)

// Synth builds a result v1 the entrypoint reports itself.
func Synth(outcome string, exitCode int, message string) []byte {
	b, _ := json.Marshal(struct {
		Version  int      `json:"version"`
		Outcome  string   `json:"outcome"`
		ExitCode int      `json:"exit_code"`
		Denied   []string `json:"denied"`
		Message  string   `json:"message,omitempty"`
	}{1, outcome, exitCode, []string{}, message})
	return b
}

type runner struct {
	d   Deps
	log *pl.Logger

	proxy     Proxy
	hasReport bool
	inReport  bool
	helper    Helper

	claim *platform.Claim

	mu    sync.Mutex
	phase string

	gone     chan struct{}
	goneOnce sync.Once

	base        context.Context // cancelled only by SIGTERM/SIGINT (main)
	proxyFailed bool
	resultSent  bool
	hbStop      chan struct{}
	hbDone      chan struct{}
}

// Run runs one job and returns the process exit code.
func Run(ctx context.Context, d Deps) int {
	if d.Now == nil {
		d.Now = time.Now
	}
	r := &runner{d: d, log: d.Log, gone: make(chan struct{}), phase: "clone"}
	code := r.run(ctx)
	r.log.Exit(code)
	return code
}

func (r *runner) platformHost() string { return r.d.Boot.PlatformHost() }

// --- network guard and helper (before claim) ---

func (r *runner) startProxy(ctx context.Context, inst egress.Instance, phase string) error {
	if r.proxy != nil {
		r.proxy.Stop()
		r.proxy = nil
	}
	p, err := r.d.Egress.Start(ctx, inst)
	if err != nil {
		return err
	}
	r.proxy = p
	r.hasReport = len(inst.Report.Root) > 0
	r.inReport = false
	if err := r.d.Platform.SetCA(p.CAPEM()); err != nil {
		return err
	}
	if err := p.Phase(phase); err != nil {
		return err
	}
	r.inReport = phase == "report"
	return nil
}

func (r *runner) stopAll() {
	if r.helper != nil {
		r.helper.Stop()
		r.helper = nil
	}
	if r.proxy != nil {
		r.proxy.Stop()
		r.proxy = nil
	}
}

func (r *runner) run(ctx context.Context) int {
	r.base = ctx
	first := egress.Instance{Clone: egress.Hosts{Root: []string{r.platformHost()}}}
	r.log.Start(pl.StepNft)
	if err := r.d.Egress.Firewall(ctx, first); err != nil {
		r.log.FailErr(pl.StepNft, pl.CodeFailed, err)
		return 1
	}
	r.log.OK(pl.StepNft)
	r.log.Start(pl.StepProxy)
	if err := r.startProxy(ctx, first, "clone"); err != nil {
		r.log.FailErr(pl.StepProxy, pl.CodeFailed, err)
		r.stopAll()
		return 1
	}
	r.log.OK(pl.StepProxy)
	r.log.Start(pl.StepHelper)
	h, err := r.d.Machine.StartHelper(ctx)
	if err != nil {
		r.log.FailErr(pl.StepHelper, pl.CodeFailed, err)
		r.stopAll()
		return 1
	}
	r.helper = h
	r.log.OK(pl.StepHelper)
	r.log.Start(pl.StepIsolation)
	if err := r.d.Machine.CheckIsolation(ctx); err != nil {
		isolation.LogFailure(r.log, pl.StepIsolation, err)
		r.stopAll()
		return 1
	}
	r.log.OK(pl.StepIsolation)

	// --- claim ---
	r.log.Start(pl.StepClaim)
	token := r.d.Boot.ClaimToken
	r.d.Boot.ClaimToken = ""
	resp, err := r.d.Platform.Claim(ctx, token)
	token = ""
	_ = token
	if err != nil {
		code := pl.CodeFailed
		switch {
		case errors.Is(err, platform.ErrGone):
			code = pl.CodeGone
		case errors.Is(err, platform.ErrReplayed):
			code = pl.CodeRefused
		case r.base.Err() != nil:
			code = pl.CodeSignal
		}
		r.log.FailErr(pl.StepClaim, code, err)
		r.stopAll()
		return 1
	}
	claim, field := resp.Validate(r.d.Boot.PlatformURL, r.d.Boot.StorageHost, r.d.Now())
	if claim == nil {
		if field == "callback_token" {
			r.log.Fail(pl.StepClaim, pl.CodeInvalid)
			r.stopAll()
			return 1
		}
		r.d.Platform.SetCallbackToken(resp.CallbackToken)
		r.log.Fail(pl.StepClaim, pl.CodeInvalid)
		dl, perr := time.Parse(time.RFC3339, resp.Deadline)
		if perr != nil || !dl.After(r.d.Now()) {
			dl = r.d.Now().Add(r.d.Cfg.FinalizeReserve)
		}
		dctx, cancel := context.WithDeadline(ctx, dl)
		defer cancel()
		return r.finalize(dctx, final{result: Synth("error", 1, "invalid claim response: "+field)})
	}
	resp.CallbackToken, resp.Clone.Token, resp.GatewayKey = "", "", ""
	r.claim = claim
	r.d.Platform.SetCallbackToken(claim.CallbackToken)
	claim.CallbackToken = ""
	r.log.OK(pl.StepClaim)

	dctx, cancel := context.WithDeadline(ctx, claim.Deadline)
	defer cancel()
	jctx, jcancel := context.WithCancel(dctx)
	defer jcancel()
	go func() {
		select {
		case <-r.gone:
			jcancel()
		case <-jctx.Done():
		}
	}()
	return r.afterClaim(jctx)
}

func (r *runner) markGone() { r.goneOnce.Do(func() { close(r.gone) }) }

func (r *runner) isGone() bool {
	select {
	case <-r.gone:
		return true
	default:
		return false
	}
}

func (r *runner) setPhase(p string) {
	r.mu.Lock()
	r.phase = p
	r.mu.Unlock()
}

func (r *runner) getPhase() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.phase
}

// event sends one events call; a 404 marks the job gone.
func (r *runner) event(ctx context.Context, e platform.Event) error {
	err := r.d.Platform.Events(ctx, e)
	if errors.Is(err, platform.ErrGone) {
		r.markGone()
	}
	return err
}

// KeteCheckFailed is the heartbeat message when the kete cgroup can't be read.
const KeteCheckFailed = "kete cgroup check failed: the kete user's cgroup couldn't be read"

// heartbeat sends `{phase}` (plus kete_cgroup_extra in the agent phase) every Heartbeat until
// stopped, so the platform hears from the job at least every 60 s through clone and report too.
func (r *runner) startHeartbeat(ctx context.Context) {
	r.hbStop = make(chan struct{})
	r.hbDone = make(chan struct{})
	go func() {
		defer close(r.hbDone)
		t := time.NewTicker(r.d.Cfg.Heartbeat)
		defer t.Stop()
		for {
			select {
			case <-r.hbStop:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				e := platform.Event{Phase: r.getPhase()}
				if e.Phase == "agent" {
					// ADR 0019 rule 5: enforced, not assumed. A check that can't run is said so
					// on the job (KeteCheckFailed), never silently left out of the heartbeat.
					if n, err := r.d.Machine.KeteExtra(); err == nil {
						e.KeteCgroupExtra = &n
					} else {
						e.Message = KeteCheckFailed
					}
				}
				if r.event(ctx, e) != nil && r.isGone() {
					return
				}
			}
		}
	}()
}

func (r *runner) stopHeartbeat() {
	if r.hbStop != nil {
		close(r.hbStop)
		<-r.hbDone
		r.hbStop = nil
	}
}

// deadline is the hard deadline: kill both job cgroups, SIGKILL the helper, close the proxy, exit
// 1, with no further callbacks (they'd answer 404 past the deadline).
func (r *runner) deadline() int { return r.abort(pl.StepDeadline, pl.CodeTimeout) }

// abort kills everything at once: the helper first (it can't start another tool), then both job
// cgroups (ADR 0021 rule 5's order), then the proxy. No more callbacks; exit 1.
func (r *runner) abort(step pl.Step, code pl.Code) int {
	r.stopHeartbeat()
	if r.helper != nil {
		r.helper.Kill()
		r.helper = nil
	}
	r.d.Machine.KillNow()
	if r.proxy != nil {
		r.proxy.Stop()
		r.proxy = nil
	}
	r.log.Fail(step, code)
	return 1
}

// cancelled: a callback answered 404 (cancelled, timed out, terminal). Kill everything, no more
// callbacks, exit 0.
func (r *runner) cancelled() int {
	r.stopHeartbeat()
	if r.helper != nil {
		r.helper.Stop()
		r.helper = nil
	}
	r.d.Machine.KillNow()
	rctx, cancel := context.WithTimeout(context.Background(), r.d.Cfg.ReapTimeout)
	_ = r.d.Machine.Reap(rctx)
	cancel()
	if r.proxy != nil {
		r.proxy.Stop()
		r.proxy = nil
	}
	r.log.Fail(pl.StepCancelled, pl.CodeGone)
	return 0
}

// interrupted maps a step that stopped on its context: gone, deadline or (SIGTERM) abort.
func (r *runner) interrupted() int {
	if r.isGone() {
		return r.cancelled()
	}
	if r.base != nil && r.base.Err() != nil {
		return r.abort(pl.StepAbort, pl.CodeSignal)
	}
	return r.deadline()
}

func (r *runner) proxyDied() bool {
	if r.proxy == nil {
		return true
	}
	select {
	case <-r.proxy.Exited():
		return !r.proxy.Planned()
	default:
		return false
	}
}

func uniq(hosts ...string) []string {
	seen := map[string]bool{}
	var out []string
	for _, h := range hosts {
		if h != "" && !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	return out
}

// harness reports whether the claim's clone is a Harness Code repository: its token is deleted by
// the platform on clone-done, never through the git host's API.
func (r *runner) harness() bool { return r.claim.CloneProvider == platform.ProviderHarnessCode }

// cloneDone is the clone-done callback (step clone_done). A 404 marks the job gone. Any other
// failure is logged; for Harness Code (the token's only revoke) it is also said on the job.
func (r *runner) cloneDone(ctx context.Context) error {
	r.log.Start(pl.StepCloneDone)
	err := r.d.Platform.CloneDone(ctx)
	switch {
	case err == nil:
		r.log.OK(pl.StepCloneDone)
	case errors.Is(err, platform.ErrGone):
		r.markGone()
		r.log.Fail(pl.StepCloneDone, pl.CodeGone)
	case ctx.Err() != nil:
		// Deadline, abort or gone: the caller's interrupted() logs and ends the job.
	default:
		r.log.FailErr(pl.StepCloneDone, pl.CodeFailed, err)
		if r.harness() {
			_ = r.event(ctx, platform.Event{Phase: "clone", Message: "clone token revoke failed"})
		}
	}
	return err
}

// failClone ends a Harness Code job whose clone or verification failed: clone-done first (the
// platform deletes the token), then finalize. A GitHub job finalizes as before.
func (r *runner) failClone(ctx context.Context, f final) int {
	r.claim.CloneToken = ""
	if r.harness() {
		_ = r.cloneDone(ctx)
		if r.isGone() || ctx.Err() != nil {
			return r.interrupted()
		}
	}
	return r.finalize(ctx, f)
}

func (r *runner) afterClaim(ctx context.Context) int {
	c := r.claim
	platformHost := r.platformHost()

	// Proxy instance 2: the full allowlists (no job-user process exists yet). The clone phase
	// reaches the platform, the clone host and, for GitHub only, its revoke API host; no later
	// phase reaches the git host.
	r.log.Start(pl.StepRestart)
	second := egress.Instance{
		Clone:  egress.Hosts{Root: uniq(platformHost, c.CloneHost, c.CloneAPIHost)},
		Agent:  egress.Hosts{Kete: uniq(c.GatewayHost, platformHost), Tool: layout.RegistryHosts, Root: []string{platformHost}},
		Report: egress.Hosts{Root: []string{platformHost}},
	}
	if err := r.startProxy(ctx, second, "clone"); err != nil {
		if ctx.Err() != nil {
			return r.interrupted()
		}
		r.log.FailErr(pl.StepRestart, pl.CodeFailed, err)
		r.stopAll()
		return 1
	}
	r.log.OK(pl.StepRestart)

	if !r.d.Git.CheckBranch(ctx, c.Branch) || !r.d.Git.CheckBranch(ctx, c.Ref) {
		return r.failClone(ctx, final{result: Synth("error", 1, "invalid claim response: spec.branch")})
	}

	r.startHeartbeat(ctx)
	if err := r.event(ctx, platform.Event{Phase: "clone"}); errors.Is(err, platform.ErrGone) {
		return r.cancelled()
	}

	r.log.Start(pl.StepClone)
	if err := r.d.Git.Clone(ctx, c.CloneURL, c.Ref, c.CloneUsername, c.CloneToken, r.d.Cfg.Pristine()); err != nil {
		if ctx.Err() != nil {
			c.CloneToken = ""
			return r.interrupted()
		}
		r.log.FailErr(pl.StepClone, pl.CodeFailed, err)
		msg := "clone failed"
		var ge *gitops.Error
		if errors.As(err, &ge) {
			if s := gitops.Scrub(ge.Stderr, c.CloneUsername, c.CloneToken); s != "" {
				msg += ": " + s
			}
		}
		return r.failClone(ctx, final{result: Synth("error", 1, msg)})
	}
	r.log.OK(pl.StepClone)

	r.log.Start(pl.StepVerify)
	if err := r.d.Git.Verify(ctx, r.d.Cfg.Pristine(), c.Ref, c.BaseSHA); err != nil {
		c.CloneToken = ""
		if ctx.Err() != nil {
			return r.interrupted()
		}
		if errors.Is(err, gitops.ErrMismatch) {
			r.log.Fail(pl.StepVerify, pl.CodeRefused)
			return r.failClone(ctx, final{result: Synth("refused", 2, "clone HEAD does not match base_sha")})
		}
		r.log.FailErr(pl.StepVerify, pl.CodeFailed, err)
		return r.failClone(ctx, final{result: Synth("error", 1, "clone verification failed")})
	}
	r.log.OK(pl.StepVerify)

	if r.harness() {
		// Harness Code: no request to the git host's API; the platform deletes the token.
		c.CloneToken = ""
		if err := r.cloneDone(ctx); err != nil && (r.isGone() || ctx.Err() != nil) {
			return r.interrupted()
		}
	} else {
		r.log.Start(pl.StepRevoke)
		if err := r.d.Platform.Revoke(ctx, c.CloneHost, c.CloneToken); err != nil {
			if ctx.Err() != nil {
				c.CloneToken = ""
				return r.interrupted()
			}
			r.log.FailErr(pl.StepRevoke, pl.CodeFailed, err)
			_ = r.event(ctx, platform.Event{Phase: "clone", Message: "clone token revoke failed"})
		} else {
			r.log.OK(pl.StepRevoke)
		}
		c.CloneToken = ""
		// Best effort (a no-op for GitHub on the platform); a 404 still means the job is gone.
		if err := r.cloneDone(ctx); err != nil && (r.isGone() || ctx.Err() != nil) {
			return r.interrupted()
		}
	}

	r.log.Start(pl.StepAgentCopy)
	if err := r.d.Git.AgentCopy(ctx, r.d.Cfg.Pristine(), r.d.Cfg.Repo(), c.Branch, c.BaseSHA); err != nil {
		if ctx.Err() != nil {
			return r.interrupted()
		}
		r.log.FailErr(pl.StepAgentCopy, pl.CodeFailed, err)
		return r.finalize(ctx, final{result: Synth("error", 1, "agent copy failed")})
	}
	if err := r.d.Machine.PrepareWorktree(); err != nil {
		r.log.FailErr(pl.StepAgentCopy, pl.CodeFailed, err)
		return r.finalize(ctx, final{result: Synth("error", 1, "agent copy failed")})
	}
	r.log.OK(pl.StepAgentCopy)

	r.log.Start(pl.StepAgent)
	if err := r.proxy.Phase("agent"); err != nil {
		r.proxyFailed = true
		r.log.FailErr(pl.StepAgent, pl.CodeProxyFailed, err)
		return r.finalize(ctx, final{})
	}
	eff := EffectiveTimeout(c.PolicyTimeout, c.Deadline, r.d.Now(), r.d.Cfg.FinalizeReserve, r.d.Cfg.Minute)
	if eff < 1 {
		r.log.Fail(pl.StepAgent, pl.CodeTimeout)
		return r.finalize(ctx, final{result: Synth("deadline", 1, "not enough time before the job's deadline")})
	}
	spec := c.Spec
	policy := spec["policy"].(map[string]any)
	policy["timeout"] = eff
	specJSON, err := json.Marshal(spec)
	if err == nil {
		err = r.d.Machine.WriteSpec(specJSON)
	}
	if err != nil {
		r.log.FailErr(pl.StepAgent, pl.CodeFailed, err)
		return r.finalize(ctx, final{result: Synth("error", 1, "could not write the job spec")})
	}
	kete, err := r.d.Machine.StartKete(ctx, KeteEnv{GatewayURL: c.GatewayURL, PlatformURL: r.d.Boot.PlatformURL, GatewayKey: c.GatewayKey})
	c.GatewayKey = ""
	if err != nil {
		r.log.FailErr(pl.StepAgent, pl.CodeFailed, err)
		return r.finalize(ctx, final{result: Synth("error", 1, "kete could not be started")})
	}
	if err := r.event(ctx, platform.Event{Phase: "agent", EffectiveTimeoutMinutes: &eff}); errors.Is(err, platform.ErrGone) {
		return r.cancelled()
	}
	r.setPhase("agent")

	backstop := time.NewTimer(time.Duration(eff)*r.d.Cfg.Minute + r.d.Cfg.BackstopExtra)
	defer backstop.Stop()
	helperExit := r.helper.Exited()
	proxyExit := r.proxy.Exited()
	timeLimit := false
loop:
	for {
		select {
		case <-kete.Done():
			break loop
		case <-proxyExit:
			if r.proxy.Planned() {
				proxyExit = nil
				continue
			}
			r.proxyFailed = true
			r.log.Fail(pl.StepAgent, pl.CodeProxyFailed)
			return r.finalize(ctx, final{})
		case <-helperExit:
			helperExit = nil
			_ = r.event(ctx, platform.Event{Phase: "agent", Message: "the tool helper exited"})
		case <-backstop.C:
			kete.Signal(syscall.SIGTERM)
			select {
			case <-kete.Done():
			case <-time.After(r.d.Cfg.KillWait):
				r.d.Machine.KillKete()
				select {
				case <-kete.Done():
				case <-ctx.Done():
					return r.interrupted()
				}
			case <-ctx.Done():
				return r.interrupted()
			}
			timeLimit = true
			break loop
		case <-ctx.Done():
			return r.interrupted()
		}
	}
	r.log.OK(pl.StepAgent)
	return r.finalize(ctx, final{keteRan: true, keteExit: kete.ExitCode(), timeLimit: timeLimit, bundle: true})
}

type final struct {
	result    []byte // set: the result to send (an entrypoint outcome)
	keteRan   bool   // read kete's own result from its stdout
	keteExit  int
	timeLimit bool
	bundle    bool
}

// ensureReport puts a proxy into the report phase that lets root reach the platform: the
// current instance if it is alive and has report hosts, else a new report-only instance.
func (r *runner) ensureReport(ctx context.Context) error {
	if r.proxy != nil && !r.proxyDied() && r.hasReport {
		if r.inReport {
			return nil
		}
		if err := r.proxy.Phase("report"); err == nil {
			r.inReport = true
			return nil
		}
		if r.proxyDied() {
			r.proxyFailed = true
		}
	}
	return r.startProxy(ctx, egress.Instance{Report: egress.Hosts{Root: []string{r.platformHost()}}}, "report")
}

func (r *runner) finalize(ctx context.Context, f final) int {
	if ctx.Err() != nil {
		return r.interrupted()
	}
	r.setPhase("report")
	pushError := ""

	// 6a: stop the agents.
	r.log.Start(pl.StepStop)
	if r.proxyDied() && r.proxy != nil {
		r.proxyFailed = true
	}
	if r.proxy != nil && !r.proxyDied() && r.hasReport {
		if err := r.proxy.Phase("report"); err == nil {
			r.inReport = true
		} else if r.proxyDied() {
			r.proxyFailed = true
		}
	}
	if r.helper != nil {
		r.helper.Stop()
		r.helper = nil
	}
	alive := r.d.Machine.Reap(ctx) != nil
	if ctx.Err() != nil {
		return r.interrupted()
	}
	if alive {
		pushError = PushProcessesAlive
		r.log.Fail(pl.StepStop, pl.CodeProcessesAlive)
	} else {
		r.log.OK(pl.StepStop)
	}
	if r.proxyDied() && r.proxy != nil {
		r.proxyFailed = true
	}
	if alive {
		// D2: the proxy is restarted only while no job-user process exists. With one alive, report
		// through the instance already in the report phase (root → platform only): result and
		// finish, no uploads (their host would need a restart). Without such an instance, report
		// nothing and exit 1 (the platform's sweeper marks the job lost).
		if r.proxy == nil || r.proxyDied() || !r.inReport {
			r.log.Fail(pl.StepRestart, pl.CodeProcessesAlive)
			r.stopAll()
			r.stopHeartbeat()
			return 1
		}
	} else if err := r.ensureReport(ctx); err != nil {
		if ctx.Err() != nil {
			return r.interrupted()
		}
		r.log.FailErr(pl.StepRestart, pl.CodeFailed, err)
		r.stopAll()
		r.stopHeartbeat()
		return 1
	}

	// 6b: the result.
	exit := 0
	var result []byte
	switch {
	case r.proxyFailed:
		result = Synth("proxy_failed", 1, "the egress proxy stopped")
	case f.result != nil:
		result = f.result
	case f.keteRan:
		out, err := r.d.Machine.ReadKeteStdout()
		if res, ok := ParseKeteResult(out); err == nil && ok {
			result = res
		} else if f.timeLimit {
			result = Synth("time_limit", 3, "stopped by the entrypoint")
		} else {
			code := f.keteExit
			if code <= 0 {
				code = 1
			}
			result = Synth("error", code, "kete exited without a valid result")
		}
	default:
		result = Synth("error", 1, "the job did not run")
	}
	r.log.Start(pl.StepResult)
	if err := r.d.Platform.Result(ctx, result); err != nil {
		if errors.Is(err, platform.ErrGone) {
			r.markGone()
			return r.cancelled()
		}
		if ctx.Err() != nil {
			return r.interrupted()
		}
		r.log.FailErr(pl.StepResult, pl.CodeFailed, err)
		exit = 1
	} else {
		r.resultSent = true
		r.log.OK(pl.StepResult)
	}
	if err := r.event(ctx, platform.Event{Phase: "report"}); errors.Is(err, platform.ErrGone) {
		return r.cancelled()
	}

	// 6c: the bundle.
	var b *bundle.Result
	if f.bundle && !alive && !r.proxyFailed {
		r.log.Start(pl.StepBundle)
		res, err := r.d.Machine.BuildBundle(ctx, r.claim.BaseSHA)
		switch {
		case err == nil:
			b = res
			defer b.Cleanup()
			r.log.OK(pl.StepBundle)
			for _, note := range res.Notes {
				_ = r.event(ctx, platform.Event{Phase: "report", Message: note})
			}
		case ctx.Err() != nil:
			return r.interrupted()
		default:
			kind, note, ok := bundle.AsRefusal(err)
			if !ok {
				kind, note = bundle.RefuseUnreadable, "the bundle could not be built"
			}
			pushError = string(kind)
			code := pl.CodeUnreadable
			if kind == bundle.RefuseSymlink {
				code = pl.CodeSymlink
			}
			r.log.Fail(pl.StepBundle, code)
			_ = r.event(ctx, platform.Event{Phase: "report", Message: "bundle refused: " + note})
		}
	}
	if r.proxyFailed {
		pushError = PushProxyFailed
	}
	if r.isGone() {
		return r.cancelled()
	}

	// 6d: uploads (none while a job process is alive: they'd need a proxy restart).
	var ups *platform.UploadURLs
	var err error
	if alive {
		r.log.Note(pl.StepUploads, pl.CodeProcessesAlive)
		r.note(ctx, "no uploads: job processes are still alive")
		goto finish
	}
	r.log.Start(pl.StepUploads)
	ups, err = r.d.Platform.Uploads(ctx, b != nil)
	if errors.Is(err, platform.ErrGone) {
		r.markGone()
		return r.cancelled()
	}
	if ctx.Err() != nil {
		return r.interrupted()
	}
	if err != nil {
		r.log.FailErr(pl.StepUploads, pl.CodeFailed, err)
	} else {
		third := egress.Instance{Report: egress.Hosts{Root: uniq(r.platformHost(), ups.Host)}}
		if err := r.startProxy(ctx, third, "report"); err != nil {
			if ctx.Err() != nil {
				return r.interrupted()
			}
			r.log.FailErr(pl.StepRestart, pl.CodeFailed, err)
			r.stopAll()
			r.stopHeartbeat()
			return 1
		}
		r.upload(ctx, ups, result, b)
		if ctx.Err() != nil {
			return r.interrupted()
		}
		r.log.OK(pl.StepUploads)
	}

	// 6e: finish.
finish:
	r.stopHeartbeat()
	if err := r.event(ctx, platform.Event{Phase: "done"}); errors.Is(err, platform.ErrGone) {
		return r.cancelled()
	}
	r.log.Start(pl.StepFinish)
	if err := r.d.Platform.Finish(ctx, pushError); err != nil {
		if errors.Is(err, platform.ErrGone) {
			r.markGone()
			return r.cancelled()
		}
		if ctx.Err() != nil {
			return r.interrupted()
		}
		r.log.FailErr(pl.StepFinish, pl.CodeFailed, err)
		exit = 1
	} else {
		r.log.OK(pl.StepFinish)
	}
	if r.proxy != nil {
		_, _ = r.proxy.Stats()
		_ = r.proxy.Phase("closed")
		r.proxy.Stop()
		r.proxy = nil
	}
	return exit
}

func (r *runner) note(ctx context.Context, msg string) {
	_ = r.event(ctx, platform.Event{Phase: "report", Message: msg})
}

func (r *runner) upload(ctx context.Context, ups *platform.UploadURLs, result []byte, b *bundle.Result) {
	put := func(url, ct string, rc io.ReadCloser, size int64, what string) {
		defer rc.Close()
		if err := r.d.Platform.Put(ctx, url, ct, rc, size); err != nil {
			r.note(ctx, what+" upload failed")
		}
	}
	// N5: what `kete` sent through its audit pipe; nothing (it refused before any session) or more
	// than the limit is not uploaded, with a fixed note.
	switch rc, size, err := r.d.Machine.OpenAudit(); {
	case errors.Is(err, ErrAuditTooLarge):
		r.note(ctx, "audit log not uploaded: too large")
	case errors.Is(err, ErrAuditReaderStuck):
		r.note(ctx, "audit log not uploaded: reader stuck")
	case err != nil:
		r.note(ctx, "audit log not uploaded: missing or refused")
	case size == 0:
		rc.Close()
		r.note(ctx, "audit log not uploaded: empty")
	case size > layout.MaxAuditUpload:
		rc.Close()
		r.note(ctx, "audit log not uploaded: too large")
	default:
		put(ups.Audit.URL, "application/x-ndjson", rc, size, "audit log")
	}
	if b != nil && ups.Bundle != nil {
		if rc, err := os.Open(b.Path); err != nil {
			r.note(ctx, "bundle upload failed")
		} else {
			put(ups.Bundle.URL, "application/gzip", rc, b.Size, "bundle")
		}
	}
	if rc, size, err := r.d.Machine.OpenProxyLog(); err != nil {
		r.note(ctx, "proxy log upload failed")
	} else {
		if size > layout.MaxProxyLogUpload {
			size = layout.MaxProxyLogUpload
		}
		put(ups.ProxyLog.URL, "application/x-ndjson", rc, size, "proxy log")
	}
}
