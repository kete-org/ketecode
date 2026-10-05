# Handoff: JetBrains plugin (IntelliJ Platform), parity with the VS Code extension

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-05 build agent
- Done: plan, web UI IDE-host adapter, `packages/kete-jetbrains` (scope 1–9, 11), CI, release job, manual
  publish workflow, docs and cards. Draft PR kete-org/ketecode#5; CI green (kete-jetbrains + kete-build).
- Decisions: Gradle 9.8.0 wrapper committed (official jar, checksum-verified); IPGP 2.19.0; compile against
  IC 2024.3.7; host detection by query flag + sessionStorage + injected bridge; bridge theme reuses
  `kete.theme` with `--vscode-*` names; per-OS release zips because six binaries exceed the Marketplace's
  400 MB limit; diagnostics = open files' daemon highlights.
- Open: the Marketplace size decision (runtime download vs. smaller binary) before go-live; the README's
  manual smoke checklist in a real IDE; high-contrast theme detection.

## 2026-10-05 build agent (security review fixes)
- Done: merged `origin/main` (conflicts in `kete-tools-ci.md` verified-at and `metrics.md`, both sides
  kept); fixed security-review findings 1–12 (result.md, "Security review fixes"); recorded the 400 MB
  go-live decision in docs/release.md; card `jetbrains-plugin` refreshed.
- Decisions: popups never open anything (JCEF has no gesture info for them); real clicks on
  `target="_blank"` links are turned into page navigations by the bridge script so `onBeforeBrowse`
  sees the gesture. Editor-tools tokens are per project (rotating one shared token would break the other
  projects' registrations).
- Open:
  - **Marketplace binary download (before the first Marketplace publish):** the Marketplace build ships
    without binaries and downloads the platform's `kete` from `kete-org/kete-releases` on first use,
    verifying `SHA256SUMS.sig` (Ed25519, pinned update key from `packages/cli/src/kete/update-keys.json`,
    Java's built-in Ed25519) and then the archive's SHA-256 before running it. Not built.
  - Plugin zips aren't in the signed `SHA256SUMS`; listing them there would let the publish workflow
    verify a signature instead of a same-release checksum.
  - Manual smoke checklist in a real IDE (now includes external links), high-contrast theme detection.
