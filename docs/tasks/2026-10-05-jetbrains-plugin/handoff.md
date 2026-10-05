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
