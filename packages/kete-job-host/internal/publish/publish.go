package publish

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
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
	// BaseSHA is the commit the controller resolved base_ref to when it started the job ("" when
	// it doesn't know any more, e.g. after a restart): the job's recorded base must equal it.
	BaseSHA string
	OpenMR  bool
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
	if !ok || !contract.ValidUUID(req.JobID) || !contract.ValidGitRef(req.BaseRef) || !contract.ValidJobBranch(req.Branch) ||
		(req.BaseSHA != "" && !contract.ValidGitSHA(req.BaseSHA)) {
		log.Error("publish_request_invalid")
		return failed(rPublisher)
	}

	// 1. The outbox, hostile.
	m, err := ReadManifest(o.OutboxDir, req.JobID, req.Repository, req.BaseRef)
	if err != nil {
		_ = err // its text may quote the hostile file: only the code is logged
		log.Error("outbox_manifest_refused")
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
	if req.BaseSHA != "" && m.BaseSHA != req.BaseSHA {
		// The job claims a base other than the commit the controller resolved and pinned for it.
		log.Warn("base_not_the_resolved_commit")
		return failed(rProviderError)
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
	if c := gitlabCIPath(entries, project.CIConfigPath); c != "" {
		// GitLab's own CI configuration: stricter than the platform's validator (handoff).
		log.Warn("bundle_refused", "code", c)
		return refused(rBundleInvalid)
	}

	// 3. The base: the job's recorded commit must be the base branch's head or an ancestor of it
	// (a job can't make the publisher build on a commit of its choosing).
	base, err := retry(ctx, o, func() (gitlab.Branch, error) { return gl.GetBranch(ctx, req.BaseRef) })
	if err != nil {
		log.Warn("gitlab_base_branch_failed", "error", err.Error())
		return providerFailure(err)
	}
	if base.Commit.ID != m.BaseSHA {
		if req.BaseSHA == "" {
			log.Warn("base_sha_unknown_to_the_controller", "rule", "ancestor of the base branch")
		}
		mb, err := retry(ctx, o, func() (string, error) { return gl.MergeBase(ctx, base.Commit.ID, m.BaseSHA) })
		switch {
		case gitlab.IsCode(err, gitlab.CodeNotFound), gitlab.IsCode(err, gitlab.CodeRefused):
			log.Warn("base_not_in_repository")
			return failed(rProviderError)
		case err != nil:
			return providerFailure(err)
		case mb != m.BaseSHA:
			log.Warn("base_not_on_base_ref")
			return failed(rProviderError)
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

	// 5. The job branch must not exist (create-only; the push re-checks atomically) — unless it
	// holds exactly the commit this run computes (a publisher re-run after a lost outcome).
	existing := ""
	if b, err := gl.GetBranch(ctx, req.Branch); err == nil {
		existing = b.Commit.ID
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
	// A deterministic time (the outbox's written_at), so a re-run builds the same commit.
	when, err := time.Parse(time.RFC3339, m.WrittenAt)
	if now := o.Now(); err != nil || when.Before(now.Add(-24*time.Hour)) || when.After(now.Add(24*time.Hour)) {
		when = now // job-written: only a plausible time is used
	}
	commit := gitproto.CommitObject(root, m.BaseSHA, o.Config.Identity, when.UTC(), CommitMessage(req.JobID, o.Config.CIOnJobBranches))
	commitSHA := gitproto.ObjectID("commit", commit)
	if existing != "" {
		if existing != commitSHA {
			return withBase(refused(rBranchExists), m.BaseSHA)
		}
		log.Info("branch_already_published")
		return openMR(ctx, gl, o, req, m, project.ID, contract.PublishOutcome{Status: contract.PublishCreated, BaseSHA: m.BaseSHA, CommitSHA: commitSHA}, log)
	}
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
	return openMR(ctx, gl, o, req, m, project.ID, contract.PublishOutcome{Status: contract.PublishCreated, BaseSHA: m.BaseSHA, CommitSHA: commitSHA}, log)
}

// openMR is step 9: the draft merge request, for a job that completed and asked for one (an open
// one from the branch is reused).
func openMR(ctx context.Context, gl *gitlab.Client, o Options, req Request, m Manifest, projectID int64, created contract.PublishOutcome, log *slog.Logger) contract.PublishOutcome {
	if !req.OpenMR || m.Outcome != "completed" {
		return created
	}
	writer, err := gl.CurrentUser(ctx)
	if err != nil {
		log.Warn("merge_request_failed", "error", err.Error())
		created.Reason = rMRFailed
		return created
	}
	// Reuse only a merge request that is ours (this project into itself, a draft, by the writer).
	if found, err := gl.FindOpenMergeRequest(ctx, projectID, writer.ID, req.Branch, req.BaseRef); err == nil && found != nil && contract.ValidChangeRequestURL(found.WebURL) {
		created.MR = &contract.MergeRequest{IID: found.IID, URL: found.WebURL}
		return created
	}
	mr, err := gl.CreateDraftMergeRequest(ctx, req.Branch, req.BaseRef, MRTitle(req.JobID), MRDescription(o.Config.PlatformURL, req.JobID))
	if err != nil && gitlab.IsCode(err, gitlab.CodeUnavailable) {
		if found, ferr := gl.FindOpenMergeRequest(ctx, projectID, writer.ID, req.Branch, req.BaseRef); ferr == nil && found != nil {
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

// gitlabCIPath returns "ci_path" when a bundle entry touches GitLab's CI configuration: anything
// under .gitlab/ (templates, CI includes; folded like the validator's names) or the project's
// custom ci_config_path when it is a path in this repository (one with @ or : names another
// project or a URL and is not in this bundle's reach).
func gitlabCIPath(entries []bundle.Entry, ciConfigPath string) string {
	custom := ""
	if ciConfigPath != "" && !strings.ContainsAny(ciConfigPath, "@:") {
		custom = foldPath(strings.TrimPrefix(ciConfigPath, "/"))
	}
	for _, e := range entries {
		f := foldPath(e.Path)
		if f == ".gitlab" || strings.HasPrefix(f, ".gitlab/") || (custom != "" && f == custom) {
			return "ci_path"
		}
	}
	return ""
}

func foldPath(p string) string {
	parts := strings.Split(p, "/")
	for i, c := range parts {
		parts[i] = bundle.Fold(c)
	}
	return strings.Join(parts, "/")
}
