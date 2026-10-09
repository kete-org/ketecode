# Result: Enterprise runtime P3 — GitLab self-managed provider and publisher

PR: kete-org/ketecode#26 (branch `feature/k8s-runner-p3`).

## What changed
- `packages/kete-job-host`:
  - `internal/config/gitlab.go` (+ `config.go`, `kubevm.go`): `repository_sources` P3 keys
    (`clone_mode` static|minted, `minter_secret`, `writer_secret`, `api_url`, `provider`),
    `no_proxy`, `publisher`; `GitLabProject`, `MatchNoProxy`.
  - `internal/repo/gitlab`: REST v4 client (project, branches with `protected`/`can_push`,
    merge base, draft MR, project access tokens), `BranchProtection`, `Redact`.
  - `internal/bundle`: Go port of the platform's bundle validator; `testdata/bundle-v1`
    (`bundles.json` 226 cases generated from the platform's own validator, `generate.ts`,
    `generate.sh`, `SHA256SUMS`).
  - `internal/gitproto`: pure-Go git smart HTTP (v2 fetch/ls-refs, v0 receive-pack), packs,
    trees, `ResultTrees` (port of the platform's Harness Code client).
  - `internal/publish` + `cmd/kete-job-host/publish.go`: the publisher.
  - `internal/agent`: `publishing` state, `publish`, `boundOutcome`, `discardUnpublished`;
    `internal/state`: publish fields.
  - `internal/driver`: `Publisher` interface; `internal/driver/kubernetes/publish.go`
    (publisher pods), clone-done/job-end/forget hooks, `List` includes publisher pods.
  - `internal/runner/clone.go`: minted/static clone credentials, base-ref resolution (retried),
    revocation, sweep; runner wiring (`RepoHTTP` seam, `--base-sha`).
  - `internal/kube`: ConfigMap volumes, read-only claims, termination messages.
  - Fakes: `internal/fakegitlab` (+ `cmd/kete-fake-gitlab`); the job-host fake's
    `publish`/`/authorize`/recorded outcomes.
- `packages/kete-runner-chart`: values/schema, `publisher-config.yaml`, RBAC (no `get` on
  Secrets in the jobs namespace; minter Secrets by name), admission (publisher pods pinned;
  publisher Secrets only for publishers; no `env.valueFrom`/`envFrom` for any pod; the named
  exception and the `publisher-secrets` policy), NetworkPolicy `kete-publishers`, README,
  `ci/lint-values.yaml`, `ci/e2e-publish.sh`; `ci/e2e-kubevm.sh` ignores the controller's git
  calls in its "only the claim" check.
- `.github/workflows/kete-runner.yml`: P3 refusals, rendered `publish.json` parsed, P3 Go tests,
  the fake GitLab image, the P3 e2e, 65-minute e2e budget.
- Docs: chart README "GitLab and publishing", kete-job-host README, cards `kubernetes-runner`,
  `gitlab-provider` (new), INDEX, this folder.

## Checks
| Check | Result |
|---|---|
| gofmt; `go vet` (darwin, linux; with and without `kete_testdriver`) | pass (local) |
| `go test -race` bundle (226 vectors + units), gitproto (incl. real `git http-backend`), repo/gitlab, publish (fake GitLab), runner (`-tags kete_testdriver`, publishing end to end on `kubetest`), driver/kubernetes, kube, contract; state publish test | pass (local, CI `chart`) |
| Root-only suites (agent, state, config files) | CI only (`kete-job-host.yml`) |
| helm lint `--strict`, kubeconform 1.30/1.32, refusals, rendered `config.json` + `publish.json` parsed | pass (local, CI `chart`) |
| kind e2e P1 (`ci/e2e.sh`), P2 (`ci/e2e-kubevm.sh`), P3 (`ci/e2e-publish.sh`) | see "CI evidence" |

## CI evidence
All checks green on f411c26027: kete-runner.yml run
https://github.com/kete-org/ketecode/actions/runs/37873516145 (`chart` pass; `e2e` pass, job
113636934720), plus build, test, kete-checks and kernel-config. In the `e2e` job:
- P1 `ci/e2e.sh` passed; P2 `ci/e2e-kubevm.sh` `PASS (150 s)`.
- P3 `ci/e2e-publish.sh` `PASS (244 s)`:
  - Admission refused: the controller deleting the writer Secret; a job pod mounting it; a
    publisher pod running something else; a job pod reading it through `env.valueFrom`.
  - The controller minted a clone token for M1; the job used it and it was revoked after the clone.
  - M1 went to `publishing`, its job pod went, and nothing was pushed before the go-ahead. After
    the go-ahead: the publisher pod, then `M1 published`.
  - Outcome `{"status":"created","branch":"kete/job/e2e00001","base_sha":"0202232e…","commit_sha":"bdb1ed92…","mr":{"iid":1,"url":"https://gitlab.corp.test/payments/api/-/merge_requests/1"}}`.
    The branch sits at that commit, its parent is the base, the README edit is there, and the MR
    is a draft. The outbox and the publisher were removed.
  - Refusals: `a1 refused/bundle_invalid` (platform vector `ci_path_gitlab`), `a2
    refused/bundle_invalid` (vector `entry_type_symlink`), `a3 refused/base_unprotected`, `a4
    refused/branch_exists`, `a5 failed/publisher_failed` (no manifest), `a6` dropped while waiting
    → `destroyed/desired`, outbox gone.
  - No refused publish pushed a branch or opened an MR; no token in the controller's logs.

Bugs CI found and fixed on the branch:
- **P2:** the controller's new base-ref resolution failed once through the proxy with a bare
  `unavailable`. Two changes fixed it: git errors now carry the sanitized transport detail, and
  resolution is retried.
- **P3 e2e:** the fake GitLab's seed path was wrong (the jobs-v1 fake's state lives under
  `<state>/fake`).
- **P3 e2e:** the crafted "good" bundle was padded by Python's `tarfile` to a 10240-byte record,
  which the validator, like the platform's, refuses as trailing data.

## Acceptance criteria
- [x] AC1 — `internal/bundle/vectors_test.go`: all 226 vectors equal the platform validator's result.
- [x] AC2 — `internal/publish` tests (refusals, created + draft MR, idempotent re-run, FIFO, base binding, writer never logged); e2e refusals.
- [x] AC3 — `internal/runner/publish_test.go` (mint, base-ref check, revoke at clone_done, unresolvable ref); e2e mint/use/revoke.
- [x] AC4 — runner tests (authorized only, outcome on the tombstone, hold_expired, dropped → outbox deleted, publisher_failed); e2e.
- [x] AC5 — CI `chart`; e2e admission/RBAC cases.
- [x] AC6 — kind e2e full flow and refusals: run 37873516145 (above).

## Cards updated
- `kubernetes-runner`, `gitlab-provider` (new), INDEX.

## Metrics
- Agents used: two forked workers (bundle port + vectors; git smart HTTP + packs) and a read-only
  security reviewer. It found one blocker (env `valueFrom` exfiltration of the writer) and three
  majors (publisher mount paths; publisher hooks and probes; cross-instance token sweep), plus
  minors. All were fixed on the branch.
- CI iterations of the kind e2e: 5.
