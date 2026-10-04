# Result: Public CLI distribution: releases repo, install scripts, Homebrew, npm, verified kete upgrade

Status: built, not committed (the coordinator commits). Design: `docs/adr/0009-public-cli-distribution.md`.

## What changed
- `.github/workflows/kete-release.yml` — `build` assembles the public set (`public-release`); `publish` drops `environment: registries` and the Marketplace/Open VSX steps, adds a notice; new `sign` (Ed25519 + cosign keyless, env `release-signing`) and `distribute` (kete-releases, README + Homebrew for stable, npm; env `distribution`, GitHub App token) behind `vars.KETE_PUBLIC_DISTRIBUTION`.
- `.github/workflows/kete-extension-publish.yml` (new) — manual, on a stable tag with confirmation; publishes that release's verified `.vsix` files.
- `.github/workflows/kete-build.yml` — shellcheck `install.sh`, parse `install.ps1` (pwsh).
- `packages/kete-tools/src/distribute.ts` (new), `test/distribute.test.ts` (new), `package.json` (`distribute` script).
- `packages/kete-tools/distribution/` (new) — `install.sh`, `install.ps1`, `npm/kete.js`, `npm/README.md`, `releases-README.md`.
- `packages/cli/src/kete/updater.ts`, `release-verify.ts`, `update-keys.json` (empty), `upgrade.ts` (new); `updater-disabled.ts`, `upgrade-disabled.ts` and their test deleted; `uninstall-disabled.ts` names Homebrew/npm.
- `packages/cli/test/kete/updater.test.ts`, `release-verify.test.ts` (new); `cli.test.ts` updated.
- Upstream edits (marked): `packages/cli/src/index.ts` (wiring), `commands/commands.ts` (description), `script/build.ts` (`KETE_TARGET` define), `packages/tui/src/component/dialog-update.tsx` + its test (branded strings).
- `packages/util/src/kete/brand.ts` — `updatesAvailable = true`, new message, `urls.releases`, `distribution`.
- `packages/core/test/kete/job-spawn-sites.test.ts` — `cli/src/kete/updater.ts` classified `client-only`.
- Docs: ADR 0009 + index, `docs/release.md`, `docs/upstream-patches.md`, cards (kete-tools-ci, cli, brand-env, job-mode, repo-map), `contracts.md` §9, `decisions.md`.

## Checks
| Check | Result |
|---|---|
| cli `bun run typecheck`, `bun test test/kete` | pass (198) |
| util typecheck, `bun test test/kete` | pass (211) |
| tui typecheck, `bun test test/kete`, `test/component/dialog-update.test.tsx` | pass |
| core `job-spawn-sites.test.ts` | pass |
| kete-tools typecheck, `bun test` | pass (58) |
| actionlint (docker) on kete-release, kete-extension-publish, kete-build | clean |
| shellcheck `install.sh` (docker) | clean |
| `install.ps1` | **not run or parsed locally** (no pwsh; the amd64 PowerShell image can't run on this arm64 Docker); parsed by the new CI step |
| `bun run lint` | 0 warnings |
| `upstream:check` | pass (leak check skipped: uncommitted, base = HEAD) |
| `card-check` | clean |
| `verify --base main` | 2 "new" failures, both explained: `tui: installation progress replaces checking…` (upstream test expected "OpenCode"; test updated with a marker, passes now); `core: pty > retains exited sessions until removed` (passes 3/3 on rerun; flaky, unrelated). cli 487 pass vs base 464. |
| Local dry run | `release kete-v0.0.0-test.1 --single --skip-vsix` → `distribute public --partial` → the `sign` job's openssl Ed25519 steps with a throwaway key (deleted) → `verifySigned` accepts it, and refuses with the checked-in empty key list; built binary: `kete --version` = `kete v0.0.0-test.1`, `KETE_TARGET` embedded, `kete upgrade` exits 1 with "no pinned update signing key", downgrade refused, `uninstall` message correct. Nothing published. |
| Reviewer | changes needed → fixed: extension workflow checkout order; PS 5.1 native stderr; install.sh trap, single-entry check, probe-before-replace; capped metadata reads; Windows rollback error; exact version match; `--latest` only for the highest stable; cosign ≥ 2.4 and branch-protection notes. Not changed: the background check stays silent on failure (logs a warning; explicit `check`/`upgrade` surface errors). |

## Acceptance criteria
- [x] AC1 — `publish` has no registry steps/environment; `kete-extension-publish.yml` (actionlint clean).
- [x] AC2 — public set + `sign` + `distribute` (actionlint; distribute tests; dry run of the signing commands).
- [x] AC3 — `install.sh` e2e tests (checksum-only install, cosign-missing refusal, tampered checksum, URL/version checks), shellcheck; `install.ps1` reviewed, CI-parsed only.
- [x] AC4 — formula and npm manifest/unpack tests.
- [x] AC5 — `updater.test.ts` (tampered checksum, signature, archive, replayed release, downgrade/current, interrupted replace, Windows rollback and failed rollback, oversized metadata, detection, policy) and `release-verify.test.ts`.
- [x] AC6 — table above.

## Cards updated
kete-tools-ci, cli, brand-env (+ job-mode, repo-map one-liners), contracts §9, decisions (0009).

## Metrics
- Agents used: one build agent, reviewer.
- Scout lookups: 0.
- Tokens / cost: n/a (reviewer ~84k subagent tokens).
- Time: ~3 h.
