# Spec: Enterprise runtime P3 — GitLab self-managed provider and publisher

- Task: `docs/tasks/2026-10-09-k8s-runner-p3` · Size: large · Created: 2026-10-09
- Status: **approved** under the Phase 8 approval (parent spec
  `docs/tasks/2026-10-07-enterprise-runtime/spec.md` §5, §4.5, §10 row P3 and its binding "S0
  findings"; ADR 0011 accepted)

## Goal
Publish an enterprise job's change to the enterprise's self-managed GitLab from inside its cluster:
the runner keeps a repository registry, hands each job a read credential (a project access token
minted for that job and revoked after its clone, or a static deploy token), and — once the platform
has authorized it — a separate publisher pod that runs only Kete code validates the job's outbox as
hostile, pushes a new branch create-only onto the job's base commit, checks branch protection,
opens a draft merge request and reports a fixed-code outcome. The platform never holds a Git
credential or the diff.

## Scope
- `packages/kete-job-host`:
  - config: `repository_sources` gain `clone_mode` (`static` | `minted`), `minter_secret`,
    `writer_secret`, `api_url`, `provider`; `no_proxy`; `publisher` (image, ConfigMap, CA and proxy
    Secrets, size, timeout).
  - `internal/repo/gitlab`: REST v4 client (project, branches with `protected`/`can_push`, merge
    base, draft MR, project access tokens), redaction of GitLab token shapes.
  - `internal/bundle`: Go port of the platform's bundle validator; `testdata/bundle-v1`: the
    platform validator's results on generated bundles (the platform holds no bundle vector files),
    with the generator and SHA256SUMS.
  - `internal/gitproto`: pure-Go git smart HTTP (v2 fetch/ls-refs, v0 receive-pack), packs, trees
    (port of the platform's Harness Code git client).
  - `internal/publish` + `kete-job-host publish`: the publisher (fixed paths, hostile outbox,
    validation, base checks, create-only push, draft MR, termination-message outcome).
  - agent: job-host-v2 `publishing` (exit → publishing, EndJob, wait for `authorized` or hold
    expiry, publisher, outcome on the tombstone per the boundary; dropped → outbox deleted).
  - kubernetes driver: publisher pods, `driver.Publisher`; clone-done/job-end hooks.
  - runner: minted/static clone credentials with base-ref resolution, revocation and sweep.
  - fakes: `internal/fakegitlab` (+ cmd), the job-host fake's `publish`/`authorize`.
- `packages/kete-runner-chart`: values/schema (`repositorySources` P3 keys, `publisher`,
  `proxy.noProxy`, `networkPolicy.repositories`), the publisher ConfigMap, RBAC (minter Secrets;
  no `get` on Secrets in the jobs namespace), admission (publisher pods pinned; publisher Secrets
  mountable only by publisher pods; the named exception and a policy keeping the controller off
  them), NetworkPolicy for publishers, README "GitLab and publishing", `ci/e2e-publish.sh`.
- CI: `kete-runner.yml` (chart refusals, rendered publish.json parsed, new Go tests, the fake GitLab
  image, the P3 e2e).
- Docs: chart README, cards `kubernetes-runner`, `gitlab-provider` (new), INDEX, this folder.

## Out of scope
The platform's side (P4: serving v2, `runtime` provider, recording `publish`), audit/proxy-log
shipping to an enterprise sink, orchestration publish kinds (plan/node/integration; platform PR
#79 in review — seam only), other Git providers (seam only), GitLab webhooks or MR-comment
triggers, a released runner image, Kata acceptance.

## Acceptance criteria
- [ ] AC1: the Go validator returns the platform validator's result on every vector (SHA256SUMS
  checked).
- [ ] AC2: the publisher refuses: invalid bundles (vector cases incl. a symlink entry), an existing
  branch, an unprotected (or writer-pushable) base or default branch, a base not on the base
  branch, a digest mismatch, a foreign manifest; maps the entrypoint's push errors; pushes
  create-only onto the base and opens a draft MR otherwise; never logs the writer.
- [ ] AC3: the controller mints a per-job read token, resolves the base ref with it (else
  `repository_unavailable`), revokes it at `clone_done`, at pod end and by sweep; static tokens
  work unchanged.
- [ ] AC4: the agent publishes only after `authorized`, reports the outcome per the boundary on the
  destroyed/exited tombstone, reports `hold_expired`, deletes the outbox of a dropped machine.
- [ ] AC5: the chart lints/kubeconforms, refuses inconsistent sources, renders a publish.json the
  publisher parses; the admission policy pins publisher pods and keeps the writer from job pods
  and the controller; RBAC gives the controller no `get` on jobs-namespace Secrets.
- [ ] AC6: kind e2e: real job → outbox → authorized → publisher → branch + draft MR → outcome; the
  refusals; token mint/revoke; no token in logs.

## Risks and constraints
Security-sensitive (a write credential, hostile input, a validator duplicated in two languages).
No real GitLab in CI (a fake with the real `git http-backend`); Kata not in CI. No new modules
(`golang.org/x/text` promoted from indirect). No upstream files.
