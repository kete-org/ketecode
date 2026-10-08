package publish

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/bundle"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/gitproto"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/repo/gitlab"
)

// Request is one publish run (the publisher pod's arguments, which the controller sets from the
// platform's run machine; the repository's URL and writer come from the configuration only).
type Request struct {
	MachineID, JobID, Repository, BaseRef, Branch string
	OpenMR                                        bool
}

// Options are the publisher's dependencies (tests replace the paths and the HTTP transport).
type Options struct {
	Config    Config
	OutboxDir string
	WriterDir string
	// HTTP carries the proxy and TLS roots for GitLab (API and git); it must not follow redirects.
	HTTP *http.Client
	Log  *slog.Logger
	Now  func() time.Time
	// Retry is the pause between attempts at a read GitLab answered `unavailable` (default 2 s).
	Retry time.Duration
}

// Fixed bounds.
const (
	maxPack     = 64 << 20
	readTries   = 3
	maxTokenLen = 4096
)

// Outcome reasons (job-host-v2 JOB_HOST_PUBLISH_REASONS) used here.
const (
	rSymlink       = "symlink"
	rUnreadable    = "unreadable"
	rBundleInvalid = "bundle_invalid"
	rUnprotected   = "base_unprotected"
	rBranchExists  = "branch_exists"
	rPushRejected  = "push_rejected"
	rProxyFailed   = "proxy_failed"
	rAlive         = "processes_alive"
	rUnavailable   = "provider_unavailable"
	rProviderError = "provider_error"
	rProtUnknown   = "protection_unknown"
	rPublisher     = "publisher_failed"
	rMRFailed      = contract.PublishReasonMRFailed
)

func refused(r string) contract.PublishOutcome {
	return contract.PublishOutcome{Status: contract.PublishRefused, Reason: r}
}

func failed(r string) contract.PublishOutcome {
	return contract.PublishOutcome{Status: contract.PublishFailed, Reason: r}
}

// providerFailure maps a GitLab or git error to failed provider_unavailable / provider_error.
func providerFailure(err error) contract.PublishOutcome {
	if gitlab.IsCode(err, gitlab.CodeUnavailable) || gitproto.ErrorCode(err) == gitproto.CodeUnavailable {
		return failed(rUnavailable)
	}
	return failed(rProviderError)
}

// Run publishes one machine's outputs and returns its outcome. It never returns free text: every
// path ends in a fixed status and reason. The log gets steps and codes, never a credential, a file
// name from the bundle or GitLab's message text.
func Run(ctx context.Context, o Options, req Request) contract.PublishOutcome {
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Retry <= 0 {
		o.Retry = 2 * time.Second
	}
	log := o.Log.With("machine_id", req.MachineID, "job_id", req.JobID, "repository", req.Repository)
	out := run(ctx, o, req, log)
	log.Info("publish_outcome", "status", out.Status, "reason", out.Reason)
	return out
}

func run(ctx context.Context, o Options, req Request, log *slog.Logger) contract.PublishOutcome {
	repo, ok := o.Config.Repos[req.Repository]
	if !ok || !contract.ValidUUID(req.JobID) || !contract.ValidGitRef(req.BaseRef) || !contract.ValidJobBranch(req.Branch) {
		log.Error("publish_request_invalid")
		return failed(rPublisher)
	}

	// 1. The outbox, hostile.
	m, err := ReadManifest(o.OutboxDir, req.JobID, req.Repository, req.BaseRef)
	if err != nil {
		log.Error("outbox_manifest_refused", "error", err.Error())
		return failed(rPublisher)
	}
	switch m.PushError {
	case "":
	case rSymlink:
		return refused(rSymlink)
	case rUnreadable:
		return refused(rUnreadable)
	case rProxyFailed:
		return failed(rProxyFailed)
	case rAlive:
		return failed(rAlive)
	default:
		log.Error("outbox_push_error_unknown")
		return failed(rPublisher)
	}
	bf, ok := m.Files["bundle"]
	if !ok || m.BaseSHA == "" {
		// The entrypoint writes a bundle whenever it built one (an empty manifest included).
		return refused(rUnreadable)
	}
	raw, err := ReadBundle(o.OutboxDir, bf)
	if err != nil {
		log.Warn("bundle_file_refused")
		return refused(rBundleInvalid)
	}
	entries, refusal := bundle.Validate(raw)
	if refusal != nil {
		log.Warn("bundle_refused", "code", refusal.Reason)
		return refused(rBundleInvalid)
	}
	if len(entries) == 0 {
		return withBase(contract.PublishOutcome{Status: contract.PublishNoChanges}, m.BaseSHA)
	}

	// 2. GitLab, with the writer (this pod's only credential).
	token, err := readSecretFile(filepath.Join(o.WriterDir, repo.WriterSecret), "token", maxTokenLen)
	if err != nil {
		log.Error("writer_credential_unreadable")
		return failed(rPublisher)
	}
	gl := gitlab.New(repo.APIBase, repo.Project, token, o.HTTP)
	ep := gitproto.Endpoint{URL: repo.CloneURL, Username: repo.Username, Password: token, Client: o.HTTP}

	project, err := retry(ctx, o, func() (gitlab.Project, error) { return gl.GetProject(ctx) })
	if err != nil {
		log.Warn("gitlab_project_failed", "error", err.Error())
		return providerFailure(err)
	}
	if req.Branch == project.DefaultBranch || req.Branch == req.BaseRef {
		return refused(rBranchExists)
	}

	// 3. The base: the job's recorded commit must be the base branch's head or an ancestor of it
	// (a job can't make the publisher build on a commit of its choosing).
	base, err := retry(ctx, o, func() (gitlab.Branch, error) { return gl.GetBranch(ctx, req.BaseRef) })
	if err != nil {
		log.Warn("gitlab_base_branch_failed", "error", err.Error())
		return providerFailure(err)
	}
	if base.Commit.ID != m.BaseSHA {
		mb, err := retry(ctx, o, func() (string, error) { return gl.MergeBase(ctx, req.BaseRef, m.BaseSHA) })
		switch {
		case gitlab.IsCode(err, gitlab.CodeNotFound), gitlab.IsCode(err, gitlab.CodeRefused):
			log.Warn("base_not_in_repository")
			return refused(rBundleInvalid)
		case err != nil:
			return providerFailure(err)
		case mb != m.BaseSHA:
			log.Warn("base_not_on_base_ref")
			return refused(rBundleInvalid)
		}
	}

	// 4. Protection of the base and the default branch against the writer (ADR 0021 rule 8).
	names := []string{project.DefaultBranch}
	if req.BaseRef != project.DefaultBranch {
		names = append(names, req.BaseRef)
	}
	for _, name := range names {
		b := base
		if name != req.BaseRef {
			if b, err = retry(ctx, o, func() (gitlab.Branch, error) { return gl.GetBranch(ctx, name) }); err != nil {
				log.Warn("gitlab_branch_failed", "error", err.Error())
				if gitlab.IsCode(err, gitlab.CodeUnavailable) {
					return failed(rUnavailable)
				}
				return failed(rProtUnknown)
			}
		}
		switch gitlab.BranchProtection(b) {
		case gitlab.Unprotected:
			log.Warn("base_unprotected", "branch_is_default", name == project.DefaultBranch)
			return withBase(refused(rUnprotected), m.BaseSHA)
		case gitlab.Unknown:
			return withBase(failed(rProtUnknown), m.BaseSHA)
		}
	}

	// 5. The job branch must not exist (create-only; the push re-checks atomically).
	if _, err := gl.GetBranch(ctx, req.Branch); err == nil {
		return withBase(refused(rBranchExists), m.BaseSHA)
	} else if !gitlab.IsCode(err, gitlab.CodeNotFound) {
		return providerFailure(err)
	}

	// 6. The base tree (one blob-less, shallow fetch of exactly base_sha), the checks against it.
	fetched, err := retry(ctx, o, func() (gitproto.BaseFetch, error) {
		return gitproto.FetchBase(ctx, ep, m.BaseSHA, gitproto.BasePackLimits)
	})
	if err != nil {
		log.Warn("base_fetch_failed", "code", gitproto.ErrorCode(err))
		return withBase(providerFailure(err), m.BaseSHA)
	}
	listings, lf := baseListings(fetched, entries)
	switch lf {
	case "":
	case "too_many_directories":
		return withBase(refused(rBundleInvalid), m.BaseSHA)
	default:
		log.Warn("base_listing_failed", "code", string(lf))
		return withBase(failed(rProviderError), m.BaseSHA)
	}
	if c := checkAgainstBase(listings, entries); c != "" {
		log.Warn("bundle_conflicts_with_base", "code", c)
		if c == "symlink" {
			return withBase(refused(rSymlink), m.BaseSHA)
		}
		return withBase(refused(rBundleInvalid), m.BaseSHA)
	}

	// 7. One commit on exactly base_sha.
	changes := make([]gitproto.Change, 0, len(entries))
	var objects []gitproto.Object
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Deleted {
			changes = append(changes, gitproto.Change{Path: e.Path, Deleted: true})
			continue
		}
		if gitproto.ObjectID("blob", e.Data) != e.BlobSHA {
			return withBase(failed(rPublisher), m.BaseSHA)
		}
		changes = append(changes, gitproto.Change{Path: e.Path, Mode: e.Mode, BlobSHA: e.BlobSHA})
		if !seen[e.BlobSHA] {
			seen[e.BlobSHA] = true
			objects = append(objects, gitproto.Object{Type: "blob", Data: e.Data})
		}
	}
	root, trees := gitproto.ResultTrees(listings, changes)
	if root == fetched.Tree {
		return withBase(contract.PublishOutcome{Status: contract.PublishNoChanges}, m.BaseSHA)
	}
	for _, t := range trees {
		body := gitproto.TreeBody(t.Items)
		if gitproto.ObjectID("tree", body) != t.SHA {
			return withBase(failed(rPublisher), m.BaseSHA)
		}
		objects = append(objects, gitproto.Object{Type: "tree", Data: body})
	}
	commit := gitproto.CommitObject(root, m.BaseSHA, o.Config.Identity, o.Now(), CommitMessage(req.JobID, o.Config.CIOnJobBranches))
	commitSHA := gitproto.ObjectID("commit", commit)
	objects = append(objects, gitproto.Object{Type: "commit", Data: commit})
	pack := gitproto.WritePack(objects)
	if len(pack) > maxPack {
		return withBase(failed(rProviderError), m.BaseSHA)
	}

	// 8. The create-only push: one command `0{40} <commit> refs/heads/<branch>`.
	ref := "refs/heads/" + req.Branch
	refs, err := gitproto.ReceivePackRefs(ctx, ep)
	if err != nil {
		log.Warn("receive_pack_failed", "code", gitproto.ErrorCode(err))
		return withBase(providerFailure(err), m.BaseSHA)
	}
	if _, exists := refs.Refs[ref]; exists {
		return withBase(refused(rBranchExists), m.BaseSHA)
	}
	pushed := gitproto.PushCreateRef(ctx, ep, ref, commitSHA, pack, refs)
	log.Info("push", "status", string(pushed.Status), "code", pushed.Code)
	switch pushed.Status {
	case gitproto.PushCreated:
	case gitproto.PushBranchExists:
		return withBase(refused(rBranchExists), m.BaseSHA)
	case gitproto.PushRuleViolation:
		return withBase(refused(rPushRejected), m.BaseSHA)
	case gitproto.PushUnknown:
		// Read the ref back once (git's ambiguous "failed to update ref", or no report).
		back, err := gitproto.ReceivePackRefs(ctx, ep)
		switch {
		case err != nil:
			return withBase(failed(rUnavailable), m.BaseSHA)
		case back.Refs[ref] == commitSHA:
		case back.Refs[ref] != "":
			return withBase(refused(rBranchExists), m.BaseSHA)
		default:
			return withBase(failed(rUnavailable), m.BaseSHA)
		}
	default:
		if pushed.Code == gitproto.CodeUnavailable {
			return withBase(failed(rUnavailable), m.BaseSHA)
		}
		return withBase(failed(rProviderError), m.BaseSHA)
	}
	created := contract.PublishOutcome{Status: contract.PublishCreated, BaseSHA: m.BaseSHA, CommitSHA: commitSHA}

	// 9. The draft merge request, for a job that completed and asked for one.
	if !req.OpenMR || m.Outcome != "completed" {
		return created
	}
	mr, err := gl.CreateDraftMergeRequest(ctx, req.Branch, req.BaseRef, MRTitle(req.JobID), MRDescription(o.Config.PlatformURL, req.JobID))
	if err != nil && gitlab.IsCode(err, gitlab.CodeUnavailable) {
		if found, ferr := gl.FindOpenMergeRequest(ctx, req.Branch); ferr == nil && found != nil {
			mr, err = *found, nil
		}
	}
	if err != nil || !contract.ValidChangeRequestURL(mr.WebURL) || mr.IID > contract.ChangeRequestMaxIID {
		if err != nil {
			log.Warn("merge_request_failed", "error", err.Error())
		} else {
			log.Warn("merge_request_url_refused")
		}
		created.Reason = rMRFailed
		return created
	}
	created.MR = &contract.MergeRequest{IID: mr.IID, URL: mr.WebURL}
	return created
}

func withBase(o contract.PublishOutcome, base string) contract.PublishOutcome {
	o.BaseSHA = base
	return o
}

// CommitMessage is the platform's commitMessage: `[skip ci]` unless the organization opted in.
func CommitMessage(jobID string, ci bool) string {
	skip := " [skip ci]"
	if ci {
		skip = ""
	}
	return "Kete job " + jobID[:8] + skip + "\n\nJob: " + jobID
}

// MRTitle and MRDescription are the platform's fixed draft PR template (ADR 0021 rule 9): never
// model text, never an @ mention.
func MRTitle(jobID string) string { return "Kete job " + jobID[:8] }

// MRDescription links the job's page on the platform.
func MRDescription(platformURL, jobID string) string {
	return "Created by a Kete Code job.\n\nJob: " + jobID + "\nDetails: " + platformURL + "/jobs/" + jobID
}

// retry runs a read up to readTries times while GitLab or git answers `unavailable`.
func retry[T any](ctx context.Context, o Options, f func() (T, error)) (T, error) {
	var v T
	var err error
	for i := range readTries {
		if v, err = f(); err == nil || !(gitlab.IsCode(err, gitlab.CodeUnavailable) || gitproto.ErrorCode(err) == gitproto.CodeUnavailable) {
			return v, err
		}
		if i == readTries-1 {
			break
		}
		t := time.NewTimer(o.Retry * time.Duration(i+1))
		select {
		case <-ctx.Done():
			t.Stop()
			return v, errors.Join(err, ctx.Err())
		case <-t.C:
		}
	}
	return v, err
}
