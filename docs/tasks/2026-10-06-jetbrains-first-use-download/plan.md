# Plan: JetBrains plugin downloads its `kete` on first use (Marketplace build)

<!-- Written by the build agent from spec.md and the module card. -->

## Cards read
- docs/context/modules/jetbrains-plugin.md
- docs/release.md ("Publish the JetBrains plugin", "The 400 MB Marketplace limit")
- packages/cli/src/kete/release-verify.ts, updater.ts (the format and checks to mirror)

## Decisions taken while planning
- **Version binding:** the archive name in the signed SHA256SUMS carries the version
  (`kete-<v>-<target>.<ext>`), so requiring that exact name binds the signed file to the requested
  version, as `releaseOf` + the `release.version !== ref` check do in the CLI.
- **Probe:** like `kete upgrade`, the extracted binary is run with `--version` (60 s timeout) after
  signature and checksum passed and before it is moved into place; it must report the version.
- **No network before consent:** the consent notification states an approximate size (80–95 MB,
  from the 0.2.x releases) instead of asking GitHub; the progress shows the exact size.
- **Archives:** Apache Commons Compress as bundled with the IntelliJ Platform (`ZipFile`,
  `TarArchiveInputStream`), no new dependency; `java.util.zip.GZIPInputStream` for gzip.
- **HTTP:** `com.intellij.util.io.HttpRequests` (IDE proxy settings and certificates). Its
  `ConnectionTuner` runs for every redirect hop before connecting (checked in the 2024.3 bytecode), so
  it refuses any non-HTTPS URL, including a redirect target.
- **Concurrency:** one in-flight download per IDE (the app service's future) plus a cross-process
  `FileChannel` lock in the download root.
- **Failed status:** `RuntimeStatus.Failed` gains `download` so the chat offers "Download" instead of
  "Restart Server" when the CLI is missing; the status tooltip no longer claims "repeated failures"
  for every stop.

## Files
| File | Read / change | Why |
|---|---|---|
| packages/kete-jetbrains/build.gradle.kts | change | generate the keys resource; test inputs; description |
| packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/core/Binary.kt | change | resolution order, `Download` result, archive names |
| packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/core/CliRelease.kt | new | keys, Ed25519, SHA256SUMS, archive names |
| packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/core/CliInstall.kt | new | fetch with caps, verify, extract, lock, move, cleanup |
| packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/KeteCliDownload.kt | new | app service: consent, background task, HttpRequests fetcher |
| packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/KeteRuntime.kt | change | `binary()` uses the downloader |
| packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/KeteSettings.kt | change | `cliDownloadConsent` setting and checkbox |
| packages/kete-jetbrains/src/main/kotlin/ai/ketecode/jetbrains/KeteProject.kt, core/Status.kt | change | "Download" action, honest status line |
| packages/kete-jetbrains/src/main/resources/META-INF/plugin.xml | change | sticky notification group for consent |
| packages/kete-jetbrains/src/test/kotlin/ai/ketecode/jetbrains/core/* | new/change | tests (spec 8) |
| .github/workflows/kete-release.yml, kete-jetbrains-publish.yml, kete-jetbrains.yml | change | Marketplace zip; guards; path filter for update-keys.json |
| packages/kete-jetbrains/README.md, docs/release.md, docs/context/modules/jetbrains-plugin.md | change | docs |

## Steps
1. Gradle task `generateUpdateKeys` (validates, copies) wired as a resources source dir.
2. `CliRelease` + tests; `Binary` changes + tests; `CliInstall` + tests (fake fetcher, test keypair).
3. IDE glue: `KeteCliDownload`, settings, runtime, project/status.
4. Live test (`KETE_LIVE_RELEASE=0.2.4`), run locally.
5. Workflows, docs, card; repo checks; push; PR; manual release run; plugin-verifier run on all IDEs.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `./gradlew test --tests '*UpdateKeys*'`; temporarily point the task at a missing file |
| AC2–AC4 | `./gradlew test` in packages/kete-jetbrains |
| AC5 | `KETE_LIVE_RELEASE=0.2.4 ./gradlew test --tests '*LiveRelease*'` |
| AC6 | `gh workflow run kete-release.yml --ref feature/jetbrains-first-use-download -f version=kete-v0.0.0-test.30` |
| AC7 | `node scripts/agent/card-check.mjs`, `node scripts/agent/stale-cards.mjs` |

## Cards to update after the build
- docs/context/modules/jetbrains-plugin.md
