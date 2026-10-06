# Result: JetBrains plugin downloads its `kete` on first use (Marketplace build)

Built on `feature/jetbrains-first-use-download`, PR kete-org/ketecode#13 (not merged).

## What changed
- `packages/kete-jetbrains/build.gradle.kts` — `generateUpdateKeys` (validates and copies
  `packages/cli/src/kete/update-keys.json` into the jar), test inputs/properties, plugin description
  discloses the download.
- `core/CliRelease.kt` (new) — pinned keys, Ed25519 (JDK), strict `SHA256SUMS`, archive names, URLs.
- `core/CliInstall.kt` (new) — installer (lock, caps, signature → checksum → safe extraction → probe →
  atomic move, cleanup) and `Archives` (Commons Compress from the platform).
- `core/Binary.kt` — setting → bundled → downloaded → `Resolved.Download`.
- `KeteCliDownload.kt` (new) — consent notification, background task, `HttpRequests` fetcher
  (HTTPS-only tuner), probe, restart after install.
- `KeteRuntime.kt`, `KeteSettings.kt` (`cliDownloadConsent`), `KeteProject.kt` (Download action),
  `core/Status.kt` (`Failed.download`, honest status line), `plugin.xml` (sticky notification group).
- Tests: `CliReleaseTest`, `CliInstallTest`, `UpdateKeysResourceTest`, `CliLiveReleaseTest` (opt-in),
  `BinaryTest` (+2).
- Workflows: `kete-release.yml` (Marketplace zip without binaries + checks), `kete-jetbrains-publish.yml`
  (no size stop; no-`bin/` guard; kete-releases release check), `kete-jetbrains.yml` (path filter).
- Docs: plugin README (+ smoke items 13–16), docs/release.md, cards `jetbrains-plugin`, `job-image`
  (verified-at only), INDEX, repo-map.

## Checks
| Check | Result |
|---|---|
| `./gradlew test` (local, JDK 21) | 93 tests: 92 passed, 1 skipped (live, opt-in), 0 failed |
| `KETE_LIVE_RELEASE=0.2.4 … --tests '*CliLiveReleaseTest*'` | passed: darwin-arm64 downloaded, signature + checksum verified with the real pinned key, `--version` → `kete v0.2.4` |
| same with `KETE_LIVE_TARGET=linux-arm64` | passed: tar.gz verified and extracted (not run) |
| Mutation: signature check always true | 4 tests fail (reverted) |
| `generateUpdateKeys` with `{"keys":[]}` / file removed | build fails with the expected message (file restored) |
| `./gradlew buildPlugin -PpluginVersion=0.2.4` | 357 KB zip, no `bin/`, keys resource present |
| `upstream:check`, `bun run lint` | pass |
| `card-check`, `stale-cards` | clean; `kete-tools-ci` and `vscode-extension` stale for earlier, unrelated changes |
| PR checks (kete-build, kete-jetbrains incl. verifier IC 2024.3.7) | pass |
| `kete-jetbrains.yml` manual run (verifier IC 2024.3.7, IC 2025.2.6, IU/PY/WS/GO 2026.2.3) | all pass (run 37427209118) |
| `kete-release.yml` manual run `kete-v0.0.0-test.30` | pass (run 37427204735); jetbrains job: Marketplace zip 0 MB without `bin/`, per-OS zips 161/180/181 MB with executable binaries, keys equal to the CLI's |

## Acceptance criteria
- [x] AC1 — `UpdateKeysResourceTest`; build fails on empty/missing file (above).
- [x] AC2 — `BinaryTest` resolution-order tests.
- [x] AC3 — `CliReleaseTest`, `CliInstallTest`.
- [x] AC4 — `CliInstallTest` archive and install tests.
- [x] AC5 — live test passed locally against `kete-v0.2.4`.
- [x] AC6 — release run 37427204735 passed.
- [x] AC7 — description, README, docs/release.md, card.

## Not verified
- The IDE UI flow (consent balloon, progress, cancel, error balloons) and `HttpRequests` through a real
  proxy: README smoke checklist 13–16, before the first Marketplace publish.

## Cards updated
- `jetbrains-plugin` (quick answers, key files, APIs, rules, testing, gotchas), `job-image` (verified-at),
  INDEX and repo-map rows.

## Metrics
- Agents used: build agent only (no sub-agents).
- Scout lookups: 0.
- Tokens / cost: not available to the agent.
- Time: ~1.5 h including CI.

## Security review follow-ups (2026-10-06, commit 370606839e)
| Check | Result |
|---|---|
| `./gradlew test` | 98 tests: 97 passed, 1 skipped (live, opt-in), 0 failed |
| Live test, darwin-arm64 / linux-arm64 / windows-x64 (stricter archive checks) | all passed; darwin ran `--version` → `kete v0.2.4` |
| `verify-public-release.ts` dry run against kete-v0.2.4 (keys from a locally built plugin jar) | passed: signature (key `kete-update-2026`) + 6 archives |
| Same with a tampered archive / tampered sig / wrong key / wrong version / missing archive | each refused with an `::error::` line; exit code 1 confirmed |
| `upstream:check`, `bun run lint`, `card-check` | pass |

The publish workflow itself can't run off a tag (it refuses non-tag refs), so it was validated by the
dry run above using the same `gh release download` patterns and script invocation.
