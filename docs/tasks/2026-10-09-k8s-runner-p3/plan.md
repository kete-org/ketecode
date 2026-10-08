# Plan: Enterprise runtime P3 — GitLab self-managed provider and publisher

## Cards read
- docs/context/modules/kubernetes-runner.md, job-host.md, job-entrypoint.md; parent spec §4–§5,
  §9; P2 handoff "P3 notes"; docs/platform/job-host-v2.md (publish, `publishing`, reasons);
  platform `apps/portal/lib/jobs/{bundle,push}/*`, `lib/harness/code/{git,pack,rules}.ts`, ADR 0021.

## Steps
1. Bundle validator port + vectors generated from the platform validator (forked worker).
2. git smart HTTP + packs port (forked worker).
3. GitLab REST client; config registry keys; publisher config.
4. Publisher (`internal/publish`, `kete-job-host publish`) with tests against a fake GitLab.
5. Agent `publishing`; driver publisher pods and clone hooks; runner clone credentials.
6. Fakes: fake GitLab (+ cmd), job-host fake `publish`/`authorize`.
7. Chart: values, schema, ConfigMap, RBAC, admission, NetworkPolicy, README; lint values.
8. CI: refusals, rendered publish.json, tests, fake GitLab image, `ci/e2e-publish.sh`.
9. Docs and cards.

## Verification
| Criterion | Command |
|---|---|
| AC1 | `go test -race ./internal/bundle/...` |
| AC2 | `go test -race ./internal/publish/... ./internal/repo/... ./internal/gitproto/...` |
| AC3, AC4 | `go test -race -tags kete_testdriver ./internal/runner/... ./internal/driver/kubernetes/...`; `go test ./internal/state/ -run Publish` |
| AC5 | kete-runner.yml `chart` (helm lint, kubeconform 1.30/1.32, refusals, `TestChartRendered*`) |
| AC6 | kete-runner.yml `e2e` (`ci/e2e-publish.sh`) |
