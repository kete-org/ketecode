---
module: gitlab-provider
paths: [packages/kete-job-host/internal/publish/**, packages/kete-job-host/internal/bundle/**, packages/kete-job-host/internal/gitproto/**, packages/kete-job-host/internal/repo/**, packages/kete-job-host/internal/fakegitlab/**, packages/kete-job-host/internal/config/gitlab.go, packages/kete-job-host/internal/runner/clone.go, packages/kete-job-host/cmd/kete-job-host/publish.go, packages/kete-job-host/testdata/bundle-v1/**, packages/kete-runner-chart/templates/publisher-config.yaml, packages/kete-runner-chart/ci/e2e-publish.sh]
verified-at: eea2edce48
---

## Quick answers
- What is this module? The Kubernetes runner's GitLab self-managed provider and publisher
  (enterprise runtime P3, task `docs/tasks/2026-10-09-k8s-runner-p3`; spec
  `docs/tasks/2026-10-07-enterprise-runtime/spec.md` §5; ADR 0011 decision 3): the repository
  registry, the jobs' read credentials, and `kete-job-host publish`, which turns a job's outbox into
  a new branch and a draft merge request. The controller side (the `publishing` state, publisher
  pods) is card `kubernetes-runner`.
- Where is the registry? `kubernetes.repository_sources` (`internal/config/gitlab.go`,
  `checkSourceP3`): `clone_url`, optional `api_url` (relative URL root; `GitLabProject` derives
  base + project path), `clone_mode` `static` (`clone_secret`: username, token) or `minted`
  (`minter_secret`: a Maintainer token), `writer_secret` (a Secret **name** in the jobs namespace).
  `publisher` section (`PublisherFile`) is required when a writer is named; `no_proxy` for direct
  repository hosts. Chart values: `repositorySources[]`, `publisher`, `proxy.noProxy`.
- How are clone tokens minted and revoked? `internal/runner/clone.go` with
  `internal/repo/gitlab` (`CreateCloneToken`: `kete-job-<machine>`, `read_repository`, Reporter,
  next-day expiry; `RevokeToken`; `ListCloneTokens`). Revoked on the job's `clone_done` phase line,
  when its pod ends, and by a 5-minute sweep of tokens whose job pod is gone.
- What does the publisher do? `internal/publish/publish.go` `Run`: manifest (strict, this
  job/repository/ref) → `push_error` mapping → bundle file (size + SHA-256) → `bundle.Validate` →
  empty = `no_changes` → GitLab project (writer) → base is base_ref's head or an ancestor
  (`MergeBase`) → protection of the default and base branches (`BranchProtection`: protected and
  `can_push` false) → job branch absent → `gitproto.FetchBase` (v2, blob:none, deepen 1) →
  `baseListings` + `checkAgainstBase` (`base.go`, the platform's checks) → `ResultTrees`, one
  commit on the base (`CommitMessage`, `[skip ci]`) → `ReceivePackRefs` + `PushCreateRef`
  (old id zero; unknown → read back) → draft MR (`Draft:` title, fixed `MRDescription`) for a
  completed job that asked. Outcome reasons are job-host-v2's fixed codes only.
- Where does the validator come from? `internal/bundle` is a port of kete-code-platform
  `apps/portal/lib/jobs/bundle/*` (gzip, tar, paths/fold, secrets, a strict JSON parser that keeps
  JS semantics: exact keys, last duplicate wins, lone surrogates refused as paths, BOM stripped).
  `testdata/bundle-v1/bundles.json` (226 cases) was generated **from the platform's own
  validator** by `generate.sh`/`generate.ts` (the platform holds no bundle vector files);
  `vectors_test.go` checks SHA256SUMS and every case. A validator change on either side is a
  contract change: regenerate and update both.
- Why pure-Go git? The runner image is distroless (no git). `internal/gitproto` ports the
  platform's Harness Code git client: pkt-lines, v2 `fetch`/`ls-refs`, v0 `receive-pack` with
  report-status and side-band, a bounded pack reader (deltas resolved iteratively, caps), a pack
  writer, canonical tree parsing, `ResultTrees`.
- How does the outcome reach the controller? `cmd/kete-job-host/publish.go` writes it as JSON to
  `/dev/termination-log`; the controller reads the pod's termination message
  (`kdriver.ParseOutcome`). Exit 0 once written.
- Where are the publisher's paths? Fixed (`internal/publish/config.go`): config
  `/etc/kete-publish/publish.json`, writers `/etc/kete-publish-writers/<secret>/token`, CA
  `/etc/kete-publish-ca/ca.crt`, proxy credential `/etc/kete-publish-proxy/auth`, outbox
  `/var/lib/kete-outbox`. Secret keys are symlinks into `..data`: `resolveUnder` resolves and keeps
  them inside their directory; files are opened `O_NOFOLLOW`.

## Purpose
Publish an enterprise job's change to its self-managed GitLab without the platform ever holding a
Git credential or the diff, with ADR 0021's push rules (hostile bundle, exact base, create-only,
protected base, draft MR) enforced inside the enterprise.

## Entry points
- `kete-job-host publish --machine … --job … --repository … --base-ref … --branch … [--open-mr]`
  (`cmd/kete-job-host/publish.go`; each flag once; started only by the controller's publisher pod).
- `publish.Run` (`internal/publish/publish.go`); `publish.ParseConfig`/`LoadConfig`.
- `cloneCreds.credential` (`internal/runner/clone.go`), wired as `KubeVMOptions.Credential`.

## Key files
- `packages/kete-job-host/internal/publish/{config,outbox,base,publish}.go` (+ tests against the
  fake GitLab).
- `packages/kete-job-host/internal/bundle/*.go`, `testdata/bundle-v1/{bundles.json,generate.ts,generate.sh,SHA256SUMS}`.
- `packages/kete-job-host/internal/gitproto/{git,pack,objects}.go`.
- `packages/kete-job-host/internal/repo/gitlab/gitlab.go` — REST client (PRIVATE-TOKEN, no
  redirects, 1 MiB cap, fixed error codes, `Redact` for `glpat-`/`gldt-`… shapes).
- `packages/kete-job-host/internal/fakegitlab/` — fake GitLab (API + `git http-backend`) and
  `cmd/kete-fake-gitlab` (TLS + admin API) for the kind e2e.
- `packages/kete-runner-chart/templates/publisher-config.yaml`, `admission-policy.yaml`
  (publisher rules, the publisher-secrets policy), `networkpolicy.yaml` (`kete-publishers`).

## Data flow
Platform desired state (`repository`, `publish {branch, open_mr, authorized}`) → controller:
`cloneCreds` mints/reads the read credential, resolves base_ref, job Secret → job clones, revoked at
`clone_done` → job writes the outbox, exits → `publishing` → authorized → publisher pod: outbox →
validate → GitLab (writer) → push + MR → termination message → controller → report `publish`
(refs per `boundary.publish_refs`) → outbox and publisher deleted.

## Data and APIs used
- GitLab REST v4: `GET projects/:id`, `GET projects/:id/repository/branches/:b` (`protected`,
  `can_push`), `GET …/repository/merge_base`, `POST/GET …/merge_requests`, `POST/GET/DELETE
  …/access_tokens`. Git smart HTTP (`/info/refs`, `git-upload-pack` v2, `git-receive-pack` v0).
- job-host-v2 publish outcome (`docs/platform/job-host-v2.md`), the entrypoint's outbox manifest
  v1 (`packages/kete-job-entrypoint/internal/outbox`).

## Rules that must not break
- The writer credential exists only in publisher pods; the controller can't read it (RBAC) or
  change it (admission); job pods can't mount it (admission).
- Everything in the outbox is hostile: no symlink followed, sizes and digests checked, the
  manifest strict and bound to the machine's job, repository and ref; nothing extracted or run.
- The commit's only parent is the job's recorded base, which must be on the base branch; the push
  is create-only (zero old id), never forced; a refused publish creates no branch.
- Outcomes are fixed codes; logs carry codes, never a token, a bundle path or GitLab's text.
- The Go validator and the platform's must agree on every vector; fix the port, never a vector.

## Testing
- `go test -race ./internal/bundle/... ./internal/gitproto/... ./internal/repo/... ./internal/publish/...`
  (gitproto's and publish's integration tests need git: `git http-backend`; skipped without it).
- `go test -race -tags kete_testdriver ./internal/runner/...` (`publish_test.go`: controller side
  with the fake GitLab).
- kind: `packages/kete-runner-chart/ci/e2e-publish.sh` (in `kete-runner.yml`).
- Regenerate vectors: `packages/kete-job-host/testdata/bundle-v1/generate.sh <platform checkout>`.

## Changes
- Another Git provider: a client like `internal/repo/gitlab`, its protection rule, and a provider
  switch in `publish.run` and `cloneCreds` (the spec's `internal/repo` seam).
- Orchestration publish kinds (plan/node/integration, platform PR #79): not built; `Request` and
  the outcome mapping are where a kind would branch.
- Audit-log shipping to an enterprise sink: not built (the outbox's audit.jsonl and proxy.jsonl are
  not read by the publisher yet).

## Gotchas
- GitLab requires Maintainer to create project access tokens; a Maintainer writer usually *can*
  push to protected branches → `base_unprotected`. Keep minter and writer separate.
- git answers "failed to update ref" for a zero-old-id push to an existing ref: `PushUnknown`, read
  back (`branch_exists` when the ref holds another commit).
- `expires_at` is a date: minted tokens live until revoked or the next day.
- `uploadpack.allowFilter` must be on (Gitaly sets it); git 2.50 accepts a want for a non-tip
  reachable commit without `allowAnySHA1InWant`.
