# Handoff: JetBrains plugin downloads its `kete` on first use (Marketplace build)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-06 build agent
- Done: spec, plan, `core/CliRelease.kt`, `core/CliInstall.kt`, `KeteCliDownload.kt`, `Binary.resolve`
  order, settings/runtime/project/status glue, Gradle `generateUpdateKeys`, tests (unit + opt-in live,
  run locally against `kete-v0.2.4`), release/publish/CI workflows, README, docs/release.md, cards.
  PR kete-org/ketecode#13.
- Decisions: version binding by the exact archive name in the signed SHA256SUMS (equivalent to the
  CLI's `releaseOf` + version check); `--version` probe like `kete upgrade`; no network before consent,
  so the consent text gives the releases' size range (80–95 MB) rather than this file's exact size;
  platform-bundled Commons Compress (no new dependency); `HttpRequests` with an HTTPS-only tuner (runs
  per redirect hop, checked in bytecode); one in-flight download per IDE + a cross-process file lock;
  a failed download isn't retried automatically (`lastFailure`) so focus-driven account refreshes
  can't spam downloads; `RuntimeStatus.Failed.download` so the chat offers Download; the publish
  workflow also checks kete-releases has the tag's release (a Marketplace version can't start without it).
- Open: the README smoke checklist items 13–16 in a real IDE (consent, progress/cancel, error
  balloons, proxy) before the first Marketplace publish; `kete-tools-ci` card is stale for an
  unrelated earlier change (`kete-extension-publish.yml`), left to the librarian.
