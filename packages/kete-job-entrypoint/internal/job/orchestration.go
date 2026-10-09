package job

// Orchestrated jobs (jobs-v1 "Orchestrated jobs", orchestrations-v1; kete-code ADR 0012, piece O6):
// a coordinator turn or a node's attempt is an ordinary job whose claim carries
// `spec.orchestration` and `fetch`. What this adds to the run, all in the clone phase (the only
// phase that reaches the git host) or from the local pristine copy:
//
//   - the pinned base: the claim's base_sha is the commit the orchestration recorded; when the
//     orchestration's base branch has moved on since, the pristine copy is remade at exactly that
//     commit. A node-based job's base is a node branch, which never moves: a mismatch is refused.
//   - the extra refs: each fetched as refs/heads/<branch> into refs/kete/<name> and checked to be
//     at its pinned commit (else refused, ref_mismatch); later copied into the agent's working copy,
//     where the coordinator merges node branches and reads the plan without any network.
//   - a worker's prompt: read from the plan file at the pinned plan commit with the shared reader,
//     its digest checked against the spec's prompt_digest; any refusal refuses the job.
//
// Every refusal is a fixed message (never a value), the result `refused` (exit 2).

import (
	"context"
	"errors"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/gitops"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/orchestration"
	pl "github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
)

// RefMismatch is the result message of a pinned ref that isn't at its recorded commit.
const RefMismatch = "orchestration: a branch is not at the commit the orchestration recorded (ref_mismatch)"

// zone is KeteEnv.Zone: the cloud path is Kete cloud's zone, kubevm an enterprise's.
func (r *runner) zone() string {
	if r.d.Runtime != nil {
		return "enterprise_private"
	}
	return "kete_cloud"
}

// orchestrated is the claim's orchestration, or nil for every other job.
func (r *runner) orchestrated() *platform.OrchestratedClaim { return r.claim.Orchestrated }

// worker is the claim's worker section, or nil.
func (r *runner) worker() *platform.WorkerSpec {
	if o := r.orchestrated(); o != nil {
		return o.Spec.Orchestration.Worker
	}
	return nil
}

// bundleKind is the orchestrations-v1 bundle rule of this job.
func (r *runner) bundleKind() bundle.Kind {
	if o := r.orchestrated(); o != nil && o.Spec.Orchestration.Coordinator != nil {
		return bundle.KindCoordinator
	}
	return bundle.KindOther
}

// pinBase makes sure the pristine copy's ref is at the claim's base_sha (step clone, before
// verify). ok false: the job ended (the returned exit code).
func (r *runner) pinBase(ctx context.Context) (int, bool) {
	c := r.claim
	pristine := r.d.Cfg.Pristine()
	head, err := r.d.Git.ResolveCommit(ctx, pristine, "refs/heads/"+c.Ref)
	if err == nil && head == c.BaseSHA {
		return 0, true
	}
	if ctx.Err() != nil {
		c.CloneToken = ""
		return r.interrupted(), false
	}
	if w := r.worker(); w != nil && w.BaseFrom != nil {
		// A node branch is pinned, never protected: one that moved is refused, not followed.
		r.log.Fail(pl.StepClone, pl.CodeRefMismatch)
		return r.failClone(ctx, final{result: Synth("refused", 2, RefMismatch)}), false
	}
	r.log.Note(pl.StepClone, pl.CodeRefMismatch)
	if err := r.d.Git.PinBase(ctx, c.CloneURL, c.Ref, c.CloneUsername, c.CloneToken, c.BaseSHA, pristine); err != nil {
		if ctx.Err() != nil {
			c.CloneToken = ""
			return r.interrupted(), false
		}
		r.log.FailErr(pl.StepClone, pl.CodeRefMismatch, err)
		return r.failClone(ctx, final{result: Synth("refused", 2, "orchestration: the pinned base commit could not be fetched (ref_mismatch)")}), false
	}
	return 0, true
}

// fetchRefs is step fetch: every extra ref into refs/kete/<name>, each checked at its pinned
// commit. Clone phase, with the clone credential; before the token is revoked.
func (r *runner) fetchRefs(ctx context.Context) (int, bool) {
	o := r.orchestrated()
	if o == nil || len(o.Fetch) == 0 {
		return 0, true
	}
	c := r.claim
	pristine := r.d.Cfg.Pristine()
	r.log.Start(pl.StepFetch)
	specs := make([]gitops.RefSpec, 0, len(o.Fetch))
	for _, f := range o.Fetch {
		specs = append(specs, gitops.RefSpec{Name: f.Name, Branch: f.Branch})
	}
	// A worker reads the tips only; a coordinator merges, so it needs the commits between the
	// pinned base and each node branch.
	depth1 := o.Spec.Orchestration.Worker != nil
	if err := r.d.Git.FetchRefs(ctx, pristine, c.CloneURL, c.CloneUsername, c.CloneToken, specs, depth1); err != nil {
		if ctx.Err() != nil {
			c.CloneToken = ""
			return r.interrupted(), false
		}
		r.log.FailErr(pl.StepFetch, pl.CodeFailed, err)
		msg := "orchestration: fetching the orchestration's branches failed"
		var ge *gitops.Error
		if errors.As(err, &ge) {
			if s := gitops.Scrub(ge.Stderr, c.CloneUsername, c.CloneToken); s != "" {
				msg += ": " + s
			}
		}
		return r.failClone(ctx, final{result: Synth("error", 1, msg)}), false
	}
	for _, f := range o.Fetch {
		got, err := r.d.Git.ResolveCommit(ctx, pristine, "refs/kete/"+f.Name)
		if ctx.Err() != nil {
			c.CloneToken = ""
			return r.interrupted(), false
		}
		if err != nil || got != f.SHA {
			r.log.Fail(pl.StepFetch, pl.CodeRefMismatch)
			return r.failClone(ctx, final{result: Synth("refused", 2, RefMismatch)}), false
		}
	}
	r.log.OK(pl.StepFetch)
	return 0, true
}

// workerPrompt is step plan_prompt: a worker's prompt from the plan file at the pinned plan
// commit (readOrchestrationNodePrompt), put into the spec `kete job run` reads. After the clone
// phase: local reads only.
func (r *runner) workerPrompt(ctx context.Context) (int, bool) {
	w := r.worker()
	if w == nil {
		return 0, true
	}
	r.log.Start(pl.StepPlanPrompt)
	data, err := r.d.Git.CatBlob(ctx, r.d.Cfg.Pristine(), w.Plan.SHA+":"+orchestration.PlanPath, orchestration.PlanFileMaxBytes)
	if ctx.Err() != nil {
		return r.interrupted(), false
	}
	var reason orchestration.Refusal
	var prompt string
	switch {
	case errors.Is(err, gitops.ErrOutputTooLarge):
		reason = orchestration.RefuseTooLarge
	case err != nil:
		r.log.FailErr(pl.StepPlanPrompt, pl.CodeRefused, err)
		return r.finalize(ctx, final{result: Synth("refused", 2, "orchestration: the plan file could not be read")}), false
	default:
		prompt, reason = orchestration.ReadNodePrompt(data, orchestration.PromptExpectation{
			OrchestrationID: w.ID, Rev: int64(w.Plan.Rev), Key: w.Node, PromptDigest: w.PromptDigest,
		})
	}
	if reason != "" {
		r.log.Fail(pl.StepPlanPrompt, pl.CodeRefused)
		return r.finalize(ctx, final{result: Synth("refused", 2, "orchestration: the plan file was refused ("+string(reason)+")")}), false
	}
	r.claim.Spec["prompt"] = prompt
	r.log.OK(pl.StepPlanPrompt)
	return 0, true
}

// copyKeteRefs makes refs/kete/* available in the agent's working copy (step agent_copy).
func (r *runner) copyKeteRefs(ctx context.Context) error {
	if o := r.orchestrated(); o == nil || len(o.Fetch) == 0 {
		return nil
	}
	return r.d.Git.CopyKeteRefs(ctx, r.d.Cfg.Pristine(), r.d.Cfg.Repo())
}
