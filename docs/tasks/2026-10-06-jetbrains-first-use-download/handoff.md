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

## 2026-10-06 build agent (security review follow-ups)
- Done:
  - `kete-jetbrains-publish.yml` now verifies the public release instead of checking asset names. It
    checks `SHA256SUMS.sig` against the update keys inside the plugin zip, then the SHA-256 of each of
    the six archives (`packages/kete-jetbrains/script/verify-public-release.ts`, which reuses
    `release-verify.ts`). `ArchiveTargetsTest` keeps the script's target list equal to `Binary.targets`.
  - The final atomic move is retried up to 5 times (200/400/800/1600 ms, cancellable) on a
    `FileSystemException` such as Windows' "file in use".
  - Links and duplicate names are refused anywhere in the archive.
  - `deleteTree` and old-version removal never descend into symlinks or Windows junctions.
  - New test: the streaming size cap with an unknown length.
  - The download task is queued with `ModalityState.any()`, and the EDT never waits on it.
  - Ticking consent in Settings clears `lastFailure`.
  - README notes the copies per IDE and per IDE version.
- Disk note (§11): each IDE and each major IDE version has its own system folder and so its own copy
  (~180–210 MB unpacked). A plugin update removes the previous plugin version's copy in the same
  folder. Copies in the system folders of old IDE versions are not cleaned, because the plugin can't
  know which of them are still in use.
