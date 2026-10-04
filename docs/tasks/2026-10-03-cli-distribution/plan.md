# Plan: Public CLI distribution: releases repo, install scripts, Homebrew, npm, verified kete upgrade

<!-- Written by the build agent from spec.md, ADR 0009 and the module cards (no separate planner run). -->

## Cards read
- docs/context/modules/kete-tools-ci.md (verified-at 38ca312eb2, stale: no)
- docs/context/modules/cli.md (verified-at 508e1f85ba, stale: updater lines only)
- docs/context/modules/brand-env.md (verified-at bfd6c66, stale: line numbers)

## Files
| File | Read / change | Why |
|---|---|---|
| `docs/release.md`, `.github/workflows/kete-release.yml` | change | release flow, public set, `sign`, `distribute`, no extension publish |
| `.github/workflows/kete-extension-publish.yml` | new | explicit extension publishing (ADR 0009 §6) |
| `.github/workflows/kete-build.yml` | change | shellcheck `install.sh`, parse `install.ps1` |
| `packages/kete-tools/src/release.ts` | read | `checksums`, `archiveName`, output layout |
| `packages/kete-tools/src/distribute.ts`, `test/distribute.test.ts`, `package.json` | new / change | public set, formula, npm, notes, verify; `distribute` script |
| `packages/kete-tools/distribution/{install.sh,install.ps1,npm/kete.js,npm/README.md,releases-README.md}` | new | what ships publicly |
| `packages/cli/src/services/updater.ts`, `updater-action.ts`, `commands/handlers/upgrade.ts` | read | upstream `Updater` interface, `decodePolicy`, handler style |
| `packages/cli/src/kete/{updater,release-verify,upgrade}.ts`, `update-keys.json` | new | verified updater |
| `packages/cli/src/kete/{updater-disabled,upgrade-disabled}.ts`, `test/kete/updater-disabled.test.ts` | delete | replaced |
| `packages/cli/src/kete/uninstall-disabled.ts`, `test/kete/cli.test.ts` | change | Homebrew/npm guidance; upgrade e2e expectations |
| `packages/cli/test/kete/{updater,release-verify}.test.ts` | new | AC5 |
| `packages/cli/src/index.ts`, `commands/commands.ts`, `script/build.ts` | change (marked) | wiring, description, `KETE_TARGET` define |
| `packages/tui/src/component/dialog-update.tsx` | change (marked) | brand the dialog now that it is reachable |
| `packages/util/src/kete/brand.ts` | change | `updatesAvailable`, message, `urls.releases`, `distribution` |
| `packages/core/test/kete/job-spawn-sites.test.ts` | change | classify `cli/src/kete/updater.ts` (`client-only`) |
| `docs/adr/0009-*.md`, `docs/adr/README.md`, `docs/upstream-patches.md`, `docs/context/*` | new / change | decision, patches, cards, contracts §9 |

## Steps
1. ADR 0009 (design, signature choice and justification).
2. `release-verify.ts` (pure verification) + tests; `updater.ts` (injectable `Deps`, detect, signed
   release, install with staging/probe/atomic swap, service) + tests; `upgrade.ts`; rewire
   `index.ts`; delete the disabled updater; `KETE_TARGET` define; Brand; TUI strings; spawn-site entry.
3. `distribute.ts` + `distribution/*` + tests (including `install.sh` against a local server).
4. Workflows: public set in `build`; `publish` without registries; `sign`; `distribute`;
   `kete-extension-publish.yml`; install-script lint in `kete-build.yml`.
5. Docs and cards; checks; dry run.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `docker run --rm -i rhysd/actionlint:latest -no-color - < .github/workflows/kete-extension-publish.yml`; read `kete-release.yml` `publish` (no vsce/ovsx, no environment) |
| AC2 | actionlint on `kete-release.yml`; `bun test ./test/distribute.test.ts` (kete-tools); local dry run: `release kete-v0.0.0-test.1 --single --skip-vsix` → `distribute public --partial` → openssl Ed25519 sign/verify as in `sign` → `verifySigned` with that key |
| AC3 | `bun test ./test/distribute.test.ts` (install.sh e2e); `docker run --rm -i koalaman/shellcheck:stable -s sh - < distribution/install.sh`; `install.ps1`: CI parse step (no local pwsh) |
| AC4 | `bun test ./test/distribute.test.ts` (formula, manifests, unpacked binaries) |
| AC5 | `bun test ./test/kete/updater.test.ts ./test/kete/release-verify.test.ts ./test/kete/cli.test.ts` (cli); built binary: `kete upgrade` reports unavailable |
| AC6 | `bun run typecheck` + `bun test test/kete` in cli/util/tui; `bun run typecheck` + `bun test` in kete-tools; `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `node scripts/agent/card-check.mjs`; `bun run --cwd packages/kete-tools verify --base main` |

## Cards to update after the build
- kete-tools-ci, cli, brand-env (+ one-line touches: job-mode, repo-map), contracts §9, decisions.
