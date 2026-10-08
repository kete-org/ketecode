# Plan: Enterprise runtime P2 — kubevm job pods, entrypoint kubevm profile, outbox, egress v2

## Cards read
- docs/context/modules/kubernetes-runner.md, job-entrypoint.md, egress.md; parent spec and S0 report.

## Steps
1. kete-egress: `config.Load`/`Runtime`, host:port parsing, address rules, upstream dialer, CA
   bundle and credentials, nft; unit tests + an nft syntax check in the integration suite.
2. Entrypoint: hostprofile (`KubeVM`, boot ID, test tag), bootenv (`--config-file`, local
   section), entry (`setup_kubevm`, boundary retry, dirs, egress v2), platform (`ClaimRuntime`,
   `FinishOutbox`), job (`Runtime`), outbox; tests per package; fake platform runtime mode.
3. Job host: config, kube client, driver (kubevm, outbox, logs, failures), agent, runner, fake
   admin; tests with kubetest.
4. Chart: values, schema, templates, lint values; local lint, kubeconform, refusals, rendered
   config parsed.
5. CI: two-node kind, `ci/e2e-kubevm.sh`, job image with `--go-tags kete_testdriver`.
6. Docs and cards.

## Verification
| Criterion | Command |
|---|---|
| AC1–AC3 | `go test ./internal/...` and `-tags kete_testdriver ./internal/hostprofile/... ./internal/bootenv/...` in kete-job-entrypoint; kind e2e |
| AC4 | `go test ./internal/...` in kete-egress; integration `TestFirewallV2RulesetIsValid` (CI) |
| AC5 | `go test -race -tags kete_testdriver ./internal/{kube,runner,driver/kubernetes}/...`; `go test ./internal/runner/...` |
| AC6 | kete-runner.yml `chart` |
| AC7 | kete-runner.yml `e2e` |
