---
module: kete-tools-ci
paths: [packages/kete-tools/src/*, packages/kete-tools/distribution/*, .github/workflows/kete-extension-publish.yml, .github/workflows/kete-installer-smoke.yml, .github/workflows/kete-job-image.yml, packages/kete-tools/leak-allowlist.txt, .github/workflows/kete-build.yml, .github/workflows/kete-release.yml, .github/workflows/kete-root-helper.yml, .github/workflows/kete-egress.yml, .github/workflows/kete-job-entrypoint.yml, .github/workflows/kete-job-host.yml, .opencode-version]
verified-at: 139c15e1b2
---

## Quick answers
- Why does `upstream:check` accept `docs/integrations/*.md` without markers? `isKeteOwned` (`packages/kete-tools/src/lib.ts`) lists `docs/integrations/` (the MCP preset guides) next to `docs/adr/`; upstream has no `docs/` at the pinned tag. A new top-level Kete doc outside these prefixes needs an entry there too.
- **How is the CLI distributed publicly, and what publishes what?** ADR 0009. `build` also runs
  `distribute public` (artifact `public-release`: every CLI archive + `install.sh` + `install.ps1` +
  their own `SHA256SUMS`, never a `.vsix`). With repository variable `KETE_PUBLIC_DISTRIBUTION=true`,
  two tag-only jobs follow: `sign` (`needs: [build, smoke, extension]`, environment
  `release-signing`, `id-token: write`; sparse checkout of `packages/cli/src/kete/update-keys.json`
  only; openssl Ed25519 → `SHA256SUMS.sig`, refusing an unpinned key; cosign keyless →
  `SHA256SUMS.sigstore.json`) and `distribute` (`needs: [publish, sign]`, environment `distribution`;
  `distribute verify` + `cosign verify-blob`; generates notes/formula/npm with no credentials; GitHub
  App token (`actions/create-github-app-token`, `KETE_DIST_APP_CLIENT_ID` var +
  `KETE_DIST_APP_PRIVATE_KEY` secret, repos `kete-releases`,`homebrew-tap`, contents: write) →
  `kete-org/kete-releases` release (draft → published), stable only: releases README + `homebrew-tap`
  `Formula/kete.rb`; then npm with `NPM_TOKEN`, platform packages first, `--tag next` for
  pre-releases, `--provenance` only if the repo is public). Full runbook `docs/release.md`.
- **Why doesn't a release publish the VS Code extension any more?** User decision 2026-10-04 (ADR
  0009 §6): `publish` lost the Marketplace/Open VSX steps and its `registries` environment;
  `.github/workflows/kete-extension-publish.yml` (manual dispatch **on** a stable `kete-v*` tag,
  `-f confirm=<tag>`) downloads that release's `.vsix` + `SHA256SUMS`, checks them and publishes with
  `VSCE_PAT`/`OVSX_PAT` (environment `registries`).
- **What does `distribute` do?** `bun run --cwd packages/kete-tools distribute public|homebrew|npm|notes|verify`
  (`src/distribute.ts`): public file set, Homebrew formula (x64 = baseline builds), npm packages
  (`@ketecode/cli` launcher from `distribution/npm/kete.js` + 8 `@ketecode/cli-<platform>` with
  `os`/`cpu`/`libc`), public notes, and `verify` (SHA256SUMS.sig against the pinned keys, every file
  listed, nothing unlisted). Reuses `packages/cli/src/kete/release-verify.ts`.
- Which files does upstream:check treat as Kete-owned (no markers needed)? → any path with `kete` in a segment, plus the list in `isKeteOwned` (`packages/kete-tools/src/lib.ts:81-106`): CLAUDE.md, NOTICE, `.opencode-version`, the Kete docs (including `docs/jobs.md`, `docs/job-hosts.md`, `docs/local-models.md`), `docs/adr/`, `assets/brand/` (logos, fonts — upstream has no top-level `assets/`), `docs/platform/`, `docs/context/`, `docs/tasks/`, `scripts/agent/`, `.claude/agents/`, `.claude/skills/`, `.claude/settings.json`. A new file anywhere else fails as "new file outside a kete path".

- **What's `kete-release.yml`'s job graph, to add a job (e.g. the job image)?** (Since ADR 0009
  also `sign` and `distribute`, above; `publish` has no environment.) `build`
  → `smoke` and `extension` (both `needs: build`) → `image` (`needs: [build, smoke, extension]`,
  so a failed release never leaves a pushed image) → `publish` (`needs: [smoke, extension, image]`,
  tag pushes only). Since self-hosted P1 there's also `image-publish` (`needs: image`, tags only)
  between them: `publish` needs `[smoke, extension, image, image-publish]`. Since then `extension-e2e`
  and `jetbrains` (both `needs: build`) joined: `image` needs `[build, smoke, extension, extension-e2e,
  jetbrains]` and `publish` needs `[smoke, extension, extension-e2e, jetbrains, image, image-publish,
  kernel-publish]`. `jetbrains` builds the JetBrains plugin zips from the release artifact's archives
  (artifact `jetbrains`, which `publish` downloads into `release/` and checks against
  `kete-code-jetbrains-<v>.sha256`; see the `jetbrains-plugin` card). `image` (75 min,
  `contents: read` only) frees disk,
  downloads the release artifact, verifies `SHA256SUMS`, unpacks the linux-x64 and linux-arm64
  `kete`, sets up QEMU (`docker/setup-qemu-action`, pinned), builds `kete-job:amd64` and runs
  `e2e.sh` on it, builds `kete-job:arm64` and smoke-tests it, and on tags `docker save`s both
  (gzip) as artifact `kete-job-images` with its SHA-256 as an output. `image-publish` (the only job
  with `packages: write` and `id-token: write`; no checkout, no build) verifies the checksum, loads
  them, pushes **those tested images** (`:<tag>-linux-<arch>`, token via `docker login --password-stdin`),
  resolves each platform manifest digest (`buildx imagetools inspect`, a single-platform index
  resolved to its manifest), creates the index `:<tag>`, checks it lists exactly the two, signs index
  + both with cosign keyless (`sigstore/cosign-installer`, cosign v3.0.6) and verifies each against
  the workflow's tag identity; outputs `index`, `amd64`, `arm64`. Manual runs build and test but
  push and sign nothing (image-publish is skipped). The notes and `.digests` say arm64 was
  smoke-tested under QEMU only. `publish`'s "Record the job image digests and signing identity" step writes
  `kete-job-image.digest` (one line, the amd64 digest Fly pins, format unchanged) and
  `kete-job-image.digests` (keyed lines), and appends the image lines and the signing identity to the
  release notes (the platform pins by
  digest). Since self-hosted P4, `kernel` (no `needs`, `contents: read`, 90 min) and
  `kernel-publish` (`needs: kernel`, tags only, `id-token: write`) build and sign the guest kernels;
  `publish` needs `[smoke, extension, extension-e2e, image, image-publish, kernel-publish]` and attaches them
  Also a tag-only `cloudvm-images` job (`needs: [image-publish]`, calls `kete-cloudvm-images.yml` with the
  index digest; no secrets passed, `publish` doesn't wait for it): cloudvm kernels, base disks, per-provider
  Packer imports (`job-image` card). PR check: `kete-cloudvm-packer.yml`.
  Since the Windsurf task, `extension-e2e` (`needs: build`, matrix `vscode`/`vscodium`, 20 min) runs
  the extension's e2e suite (`packages/kete-vscode/script/e2e.ts --assert`) on the linux-x64 `.vsix`
  in pinned, SHA-256-checked editor archives under xvfb; `image` needs
  `[build, smoke, extension, extension-e2e]` and `publish` needs it too (`vscode-extension` card).
  Bump an editor by changing its matrix `archive` and `sha256` together.
  ("Attach the guest kernels"). Find the line numbers with `grep -n "^  [a-z]*:$" .github/workflows/kete-release.yml`.

- **How do I pull in a new OpenCode release?** `bun run --cwd packages/kete-tools upstream:sync
  vX.Y.Z [--verify] [--pr]` on a fresh `upstream/vX.Y.Z` branch off `main`; full runbook
  `docs/upstream-sync.md`, rule origin CLAUDE.md §4, `docs/architecture.md` §15.
- **What does `upstream:check` enforce?** Four things on HEAD vs `.opencode-version`'s pinned tag:
  the pin is an ancestor of HEAD, every edit to an upstream file carries a `kete_change` marker (or
  is documented in `docs/upstream-patches.md`), no new OpenCode-name "leaks" in engine sources, and
  `LICENSE`/`NOTICE` are intact (`packages/kete-tools/src/check.ts:45-128`). Markers and `LICENSE`
  compare the working tree (tracked files), so an uncommitted edit is checked too; untracked files
  and the leak check use commits only.
- **How do I cut a release?** A maintainer tags `kete-vX.Y.Z` on `main` and pushes the tag; never
  push upstream's bare `vX.Y.Z` tags, and never run upstream's `packages/cli/script/publish*.ts` or
  enable `publish.yml` (they publish to OpenCode's own npm/Homebrew/registry). Full steps
  `docs/release.md`.
- **Where does CI run what?** `.github/workflows/kete-build.yml` (PRs/pushes to `main`): lint,
  typecheck, CLI binary build+smoke, `upstream:check`, and every `packages/*/test/kete` (+ analogous
  Kete-owned) suite — including the piece A3 Linux confinement tests (`util/test/kete/*-linux.test.ts`, `core/test/kete/job-files-linux.test.ts`, `server/test/kete/job-files-wiring.test.ts`), which run on the ubuntu x86_64 runner (real `openat2`) and skip on macOS; no workflow change. `.github/workflows/kete-release.yml` (tag `kete-v*` or manual dispatch): builds
  every platform archive and `.vsix` and the public file set, smoke-tests binaries, checks each
  `.vsix`, and (tags only) publishes this repository's GitHub Release, then (public distribution on)
  signs and publishes the CLI to kete-releases, Homebrew and npm.
  `.github/workflows/kete-extension-publish.yml` (manual, on a stable tag): the extension to the
  Marketplace and Open VSX. `kete-installer-smoke.yml` runs the public install commands (via
  `ketecode.ai/cli/install{,.ps1}`, cosign on) on Linux, Alpine, macOS and Windows (pwsh + 5.1) after
  each release, on PRs touching it, and on dispatch. `kete-build.yml`'s `kete-checks` also shellchecks `install.sh` and
  parses `install.ps1` (pwsh).
  `.github/workflows/kete-root-helper.yml` (path-filtered PR/push to `main`, plus manual dispatch):
  the Go root-helper's own workflow, kept separate rather than a job in `kete-build.yml` (D7,
  `docs/tasks/2026-09-29-job-root-helper/plan.md` §7) — a per-job path filter there needs an extra
  detection job on every PR (GitHub rounds each job up to a minute) or a third-party action; a
  separate workflow's native `on.paths` is free. See "Data flow" and the `root-helper` card.
  `.github/workflows/kete-egress.yml` (path-filtered to `packages/kete-egress/**` and itself, plus
  manual dispatch) is the egress proxy's own workflow on the same pattern; see the `egress` card.
  `.github/workflows/kete-job-entrypoint.yml` (path-filtered to the entrypoint, helper and egress
  modules and itself, plus manual dispatch) is the job entrypoint's; see the `job-entrypoint` card.
  `.github/workflows/kete-job-image.yml` is the job image's e2e (see the `job-image` card).
  `.github/workflows/kete-job-host.yml` (path-filtered to `packages/kete-job-host/**` and itself,
  plus manual dispatch) is the self-hosted job host agent's; see the `job-host` card.
- **Go toolchain, where's it pinned?** In four places that must be bumped together:
  `packages/kete-root-helper/go.mod:3,5`, `packages/kete-egress/go.mod:3,5`,
  `packages/kete-job-entrypoint/go.mod:3,5` and `packages/kete-job-host/go.mod:3,5` (also
  `golang.org/x/sys v0.48.0` in all four, and
  `golang.org/x/net v0.59.0` in egress and the entrypoint) — `go 1.26.0` /
  `toolchain go1.26.8` (the exact version `golang:1.26-bookworm` reports); `kete-root-helper.yml`'s
  `actions/setup-go` step reads it via `go-version-file`. No Go is installed on developer Macs — see
  the `root-helper` card for the Docker/Colima local-run commands.

## Purpose

Kete-owned automation that keeps `kete-code` a mergeable fork of OpenCode (upstream sync + hygiene
checks) and produces its own releases (CLI binaries + VS Code extension), separately from OpenCode's
own release/publish machinery, which must never run here. Grounding: CLAUDE.md §4 (upstream-first
rule), §8 (build/release commands), ADR `docs/adr/0001-opencode-upstream-strategy.md`.

## Entry points

- `bun run --cwd packages/kete-tools upstream:sync <vX.Y.Z> [--base main] [--verify] [--pr]` /
  `--continue` / `--abort` → `packages/kete-tools/src/sync.ts` (`sync()`, `abort()`).
- `bun run --cwd packages/kete-tools upstream:check [--base <ref>] [--upstream <tag>]` →
  `src/check.ts` (`runChecks()`), also importable (used by `sync.ts`).
- `bun run --cwd packages/kete-tools verify [--base <ref>] [--packages a,b] [--skip-tests]
  [--markdown]` → `src/verify.ts`.
- `bun run --cwd packages/kete-tools release kete-vX.Y.Z [--out <dir>] [--single] [--skip-vsix]` →
  `src/release.ts` (`main()`).
- `bun run --cwd packages/kete-tools distribute public|homebrew|npm|notes|verify <in> <out>` →
  `src/distribute.ts` (ADR 0009); `--partial` for a `release --single` dry run.
- `bun run --cwd packages/kete-tools role-check --model <provider/model> [--role <name>]
  [--kete-account]` → `src/role-check.ts` (costs real model usage; nothing runs without `--model`).

## Key files

- `sync.ts` (453) — the sync state machine: `start`/`resume`/`sync`/`abort`, auto-resolution of
  version-bump-only conflicts (`autoResolve`, `sync.ts:299`), `conflictReport()` splitting conflicts
  into Kete-touched vs not, report rendering, optional `--pr`.
- `check.ts` (171) — the four `upstream:check` checks (pin/markers/leaks/license,
  `runChecks()` at `:45`); CLI entry at `:160-171`.
- `verify.ts` (145) — `verifyPackages()` runs `bun run typecheck`/`bun run test` per engine package;
  `parseTestOutput()` extracts `(fail) name` lines and pass/fail totals; `withWorktree()` runs the
  same on a `--base` ref in a temp `git worktree` so only new regressions fail.
- `release.ts` (179) — cross-builds the CLI (`bun run build` in `packages/cli`, reads
  `OPENCODE_VERSION`/`OPENCODE_CHANNEL` directly since it runs outside the CLI env bridge), archives
  each target with `LICENSE`+`NOTICE`, packages one `.vsix` per VS Code target via `vsce package
  --target` with that platform's binary in `bin/`, writes `SHA256SUMS`. `releaseVersion()` (`:31-33`)
  only accepts `kete-vX.Y.Z[-pre]` tags.
- `distribute.ts` — public distribution builders (see Quick answers); `distribution/` holds what
  ships: `install.sh` (POSIX sh), `install.ps1` (both read `KETE_VERSION`/`KETE_INSTALL_DIR`; `.ps1` also `KETE_NO_MODIFY_PATH`; flags win; `ketecode.ai/cli/install{,.ps1}` redirect to them), `npm/kete.js` + `npm/README.md`,
  `releases-README.md` (kete-releases' README, synced on stable releases).
- `role-check.ts` (135) + `role-scenarios.ts` (119) — Phase-5 behavior check for role agents: runs a
  small task per role in a throwaway repo/HOME and judges the diff and answer against each
  `Scenario`'s `mayChange`/`mustChange`/`mustSay`/`mustNotSay` (pure and unit-tested without a model
  in `role-scenarios.test.ts`; the live run needs `--model` and costs money).
- `lib.ts` (288) — shared `run()`/`git()`/`gitOk()` process helpers, `SyncError`, version
  parsing/comparison, leak-pattern detection (`countLeaks`, `leakIncreases`, `leakPatterns`),
  `isKeteOwned()`/`isUnmarkable()` path classifiers used by `check.ts`.
- `leak-allowlist.txt` — `<file>:<pattern-id>` entries (one per intentionally-kept OpenCode-name
  literal), each needing a comment explaining why; read by `check.ts:107,133-143`.
- `.github/workflows/kete-build.yml` (96) — `build` job (lint, `bun turbo typecheck
  --concurrency=1`, CLI single-target build + `--version` smoke) and `kete-checks` job
  (`upstream:check` + every `packages/*/test/kete`-style suite); triggers on PR/push to `main`,
  skips docs-only diffs.
- `.github/workflows/kete-release.yml` — `build` (cross-compile via `release.ts`) →
  `smoke` (runs the unpacked binary per platform with a throwaway HOME) + `extension` (checks all 8
  `.vsix` targets/versions/bundled-binary permissions) + `extension-e2e` (VS Code and VSCodium
  end-to-end under xvfb) → `image` (amd64 + arm64 job images, e2e on
  amd64, smoke on arm64, read-only) → `image-publish` (tags only: load the artifact, push, index,
  cosign sign and verify) → `publish` (tag pushes only,
  `environment: registries`): draft GitHub Release, records the image digests and signing identity,
  then Marketplace, then Open VSX, then un-drafts the release. Every action pinned by SHA; lint with
  `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -no-color <workflow>`.
- `.github/workflows/kete-root-helper.yml` — path-filtered (`packages/kete-root-helper/**`, the
  TypeScript client/protocol/tool-runner/job-mode files, `job-server.ts`, the e2e test file, and
  itself) on PR/push to `main`, plus `workflow_dispatch`. One `ubuntu-latest` job, `timeout-minutes:
  10`: `go vet`/`go test` → `sudo … bash scripts/integration.sh` (root, real second user, real
  cgroup v2) → `./.github/actions/setup-bun` → `bash scripts/e2e.sh` (AC5, the real helper end to
  end). Same pinned-SHA `actions/checkout` and `concurrency`/`permissions: contents: read`
  conventions as `kete-build.yml`; `actions/setup-go` pinned by SHA, `go-version-file:
  packages/kete-root-helper/go.mod`. Header comment states the budget rationale (~4-6 min, only runs
  on a path match). Full detail: the `root-helper` card.
- `.github/workflows/kete-egress.yml` — path-filtered (`packages/kete-egress/**`, itself) on
  PR/push to `main`, plus `workflow_dispatch`. One `ubuntu-latest` job, `timeout-minutes: 10`:
  `gofmt -l`, `go vet` (also `-tags integration`), `go test -race` → `sudo env "PATH=$PATH" bash
  scripts/integration.sh` (real users, real nftables rules, inside `unshare --net` so the runner's
  own network is untouched). No bun step. Same pinned `actions/checkout`/`actions/setup-go` SHAs as
  `kete-root-helper.yml`; `go-version-file: packages/kete-egress/go.mod`. ~2-4 min. Full detail:
  the `egress` card.
- `.github/workflows/kete-job-entrypoint.yml` — path-filtered (`packages/kete-job-entrypoint/**`,
  `packages/kete-root-helper/**`, `packages/kete-egress/**`, itself) on PR/push to `main`, plus
  `workflow_dispatch`. One `ubuntu-latest` job, `timeout-minutes: 15`: `gofmt -l`, `go vet` (also
  `-tags integration`), `go test -race` → the integration suite in a `docker run --privileged
  --cgroupns=private` `golang:1.26-bookworm` container mounting `packages/` (it builds the sibling
  helper and proxy). Same pinned `actions/checkout`/`actions/setup-go` SHAs; `go-version-file:
  packages/kete-job-entrypoint/go.mod`. ~3-5 min. Not yet run in CI at `verified-at`. Full detail:
  the `job-entrypoint` card.
- `.github/workflows/kete-job-host.yml` — path-filtered (`packages/kete-job-host/**`, itself) on
  PR/push to `main`, plus `workflow_dispatch`. One `ubuntu-latest` job, `timeout-minutes: 10`:
  apt `nftables e2fsprogs`, `kernel/check-config.sh`, `gofmt -l`, `go vet` (also `-tags kvm` and
  `GOOS=darwin`), `sudo env PATH GOMODCACHE GOCACHE go test -race` (the agent's files must be
  root-owned; the host-table tests apply and delete `inet kete-job-host` on the runner), a compile
  of the KVM tests and the probe, a `CGO_ENABLED=0` build; checkout with `persist-credentials:
  false`. No KVM. Same pinned `actions/checkout`/`actions/setup-go` SHAs; `go-version-file:
  packages/kete-job-host/go.mod`. ~2-3 min. Not yet run in CI at `verified-at`. Full detail: the
  `job-host` card.
- `.github/workflows/kete-job-image.yml` — the job image's end-to-end test. Path-filtered (entrypoint,
  image, helper and egress modules, the job-mode TypeScript files, and itself) on PR/push to `main`,
  plus `workflow_dispatch`; `ubuntu-latest`, 30 min (~12-15 min): setup-bun → `bun run build
  --target=kete-linux-x64 --skip-web-ui` → `build.sh --arch amd64` → `e2e.sh kete-job:local` with
  `E2E_STATE`/`E2E_KEEP_LOGS=1`; on failure it deletes `tokens.json`/`job.env` and uploads the state
  as an artifact. Pushes nothing. Full detail: the `job-image` card.
- `.opencode-version` — single line, currently `v2.0.16`; the tag `upstream:check`'s pin check and
  `sync.ts` compare against.

## Data flow

**Sync:** `upstream:sync vX.Y.Z` → preflight (clean tree, `upstream` remote exists/unpushable, tag
newer than the pinned one, `main` matches `origin/main`) → create `upstream/vX.Y.Z` off `main` →
`git merge --no-ff` the tag → on conflict, auto-resolve pure version-bump/`bun.lock` hunks, then stop
for a human if any remain (split kete-touched vs not) → `--continue` after resolving → pin
`.opencode-version` in its own commit → `runChecks()` → optional `verify.ts` against `main` in a
worktree → render report to `.git/kete-upstream-sync-report.md` → optional `--pr` (push + open PR,
refused if any check failed).

**CI (build):** every PR/push to `main` → lint/typecheck/binary-build+smoke in one job,
`upstream:check` + Kete-owned test suites in another (kept inside GitHub's free-minutes budget by
design — see the workflow's header comment).

**CI (release):** push of tag `kete-v*` → `release.ts` cross-builds every CLI target and packages
every `.vsix` on Linux → artifact uploaded once → `smoke` job unpacks and runs the binary per
platform with `HOME` pointed at a throwaway dir → `extension` job validates each `.vsix`'s target,
version, and bundled-binary executability → `publish` job (tags only) creates a draft GitHub
Release, attaches the image digests and kernels, then publishes it → (public distribution on) `sign`
→ `distribute` (kete-releases, Homebrew for stable, npm). The extension goes to the Marketplace and
Open VSX only through `kete-extension-publish.yml`.

## Data and APIs used

- `git` (via `lib.ts`'s `run`/`git`/`gitOk`): remotes (`upstream`, `origin`), tags, worktrees,
  merge/diff/status — no network calls beyond `git fetch`.
- `bun install`, `bun run typecheck`/`test`/`build` in target packages (`verify.ts`, `release.ts`).
- `vsce package --target <target>` (`@vscode/vsce@4.0.0`, pinned) for `.vsix` packaging
  (`release.ts:120-139`).
- GitHub Actions environments, each gated to `kete-v*` tags (`docs/release.md` "One-time setup"):
  `registries` (VSCE_PAT, OVSX_PAT; only `kete-extension-publish.yml`), `release-signing`
  (KETE_UPDATE_SIGNING_KEY; only `sign`), `distribution` (KETE_DIST_APP_CLIENT_ID variable,
  KETE_DIST_APP_PRIVATE_KEY, NPM_TOKEN; only `distribute`); repository variable
  `KETE_PUBLIC_DISTRIBUTION`.
- `KeteAccount` (`@opencode/util/kete/account`) in `role-check.ts` when `--kete-account` is passed,
  to source model credentials from the signed-in Kete gateway.

## Rules that must not break

- Kete tags are `kete-vX.Y.Z[-pre]`; upstream's bare `vX.Y.Z` tags live in the same repo and must
  never be pushed to `origin` (`sync.ts` fetches them read-only; `release.ts:releaseVersion`
  rejects anything else).
- `upstream` remote must stay unpushable (`push url` must be `no_push`/`DISABLED`) — `sync.ts`'s
  preflight fails the sync otherwise (`sync.ts` `start()`).
- Every edit to an upstream file needs a `kete_change` marker or a `docs/upstream-patches.md` entry
  for unmarkable files (JSON/txt/md/…); `check.ts` fails the build if either is missing.
- No new OpenCode-name literals in engine sources without going through `Brand`
  (`packages/util/src/kete/brand.ts`) or an explained `leak-allowlist.txt` entry.
- `LICENSE` must stay byte-identical to upstream's and `NOTICE` must exist — never remove OpenCode
  attribution (CLAUDE.md §4, §9).
- Never run upstream's own publish scripts (`packages/cli/script/publish*.ts`) or enable
  `publish.yml` — they target OpenCode's own npm/Homebrew/registry, not Kete's.
- Only a maintainer tags a release; CI's `publish`, `sign` and `distribute` jobs only run on an
  actual tag push, and every secret lives in an environment restricted to `kete-v*` tags so no
  PR/branch can read it. A release never publishes the extension (ADR 0009 §6).
- `sign` must keep checking that its key is pinned in `update-keys.json`, and `distribute` must keep
  running `distribute verify` + `cosign verify-blob` before publishing anything.
- `role-check.ts` never runs a model without an explicit `--model`, and without `--kete-account` the
  runs stay signed out (starter roles only) so the check doesn't depend on a developer's account.

## Testing

- Narrowest: `bun test ./test/<file>.test.ts` from `packages/kete-tools/` (e.g.
  `bun test ./test/sync.test.ts`).
- Package: `bun run typecheck`, `bun run test` from `packages/kete-tools/`.
- `test/distribute.test.ts`: the public set (no `.vsix`, tamper and missing-target refusals), the
  formula, the npm manifests and unpacked binaries, `verify`, and `install.sh` end to end against a
  local `Bun.serve` release (checksum-only install, cosign-missing refusal, tampered checksum, URL and
  version validation). Its server and the installer must run with **async** `Bun.spawn`: a
  `spawnSync` blocks the event loop and deadlocks against the in-process server.
- `test/sync.test.ts` (327 lines), `test/lib.test.ts` (155), `test/release.test.ts` (63),
  `test/role-scenarios.test.ts` (52) cover the respective modules; there is no live-model test for
  `role-check.ts` itself (it needs `--model` and real credentials/cost).
- Before opening a PR (CLAUDE.md §8): `bun run --cwd packages/kete-tools verify --base main` and
  `bun run --cwd packages/kete-tools upstream:check`.

## Changes

- `docs/tasks/2026-10-03-cli-distribution/` (ADR 0009): `build` assembles the public set; `publish`
  loses `environment: registries` and the Marketplace/Open VSX steps (now
  `kete-extension-publish.yml`); new `sign` and `distribute` jobs behind `KETE_PUBLIC_DISTRIBUTION`;
  `kete-build.yml` lints the install scripts; new `src/distribute.ts` and `distribution/`.

- `docs/tasks/2026-10-03-job-host-firecracker/` (self-hosted P4): `kete-release.yml` gains `kernel`
  (read-only; `kernel/build.sh` for amd64 and arm64, artifact + SHA-256) and `kernel-publish` (tags
  only, `id-token: write`; `cosign sign-blob --bundle` + `verify-blob` against the tag identity);
  `publish` needs `kernel-publish` and attaches `kete-guest-kernel-*` (+ `.sha256`,
  `.sigstore.json`) with notes lines. `kete-job-host.yml` installs nftables/e2fsprogs, checks the
  kernel configs and compiles the KVM tests.
- `docs/tasks/2026-10-03-job-host-profiles/` (self-hosted P1): the release `image` job builds
  linux/amd64 and linux/arm64, publishes one index and signs it and both per-arch digests with
  cosign keyless; `publish` adds `kete-job-image.digests`; `kete-job-image.yml` also deletes the
  fake's `config.json` before uploading failure state.
- Adding a new hygiene rule: extend `runChecks()` in `check.ts`, add its failure/note strings, and
  cover it in `check.ts`'s tests (via `sync.test.ts`/dedicated fixtures) — `sync.ts` calls
  `runChecks` directly, so a new check applies to both `upstream:check` and every sync.
- Adding a new leak pattern: extend `leakPatterns` in `lib.ts`; existing intentional matches must be
  added to `leak-allowlist.txt` with a reason, or the next `upstream:check` run fails.
- Adding a release artifact/target: extend `release.ts` (`extensionTargets`/`archiveName`) and the
  `kete-release.yml` `extension`/`smoke` matrices together — they assert exact target lists.
- CI budget is a hard constraint: the `kete-build.yml` header explains it stays within GitHub's free
  minutes on purpose; don't add heavy jobs there — put full engine-package suites in local `verify`
  instead (CLAUDE.md §8). A heavy, occasional-change job (like the root helper's) gets its **own**
  path-filtered workflow rather than a conditional job inside `kete-build.yml` (D7 above).

## Gotchas
- **Environments must admit `kete-v*` tags exactly** (`registries`, `release-signing`,
  `distribution`): a narrower deployment-tag pattern refuses rc tags (`kete-v0.2.0-rc.1`), which is
  what failed an earlier rc release's `publish` job when it still used `registries`.
- npm refuses `--provenance` from a private repository; `distribute` passes it only when
  `github.event.repository.private` is false.

- `verify.ts`'s `--base` comparison spins up a real `git worktree` and runs `bun install
  --frozen-lockfile` in it — it needs disk space and network, and cleans itself up in a `finally`
  (`verify.ts:61-72`); an interrupted run can leave a stray worktree under the OS temp dir.
- Upstream tags every release on a commit off its own mainline, so **every** sync conflicts on each
  `package.json` `"version"` and `bun.lock`, even with no real Kete changes; `sync.ts` auto-resolves
  only pure version-bump hunks and regenerates `bun.lock` via `bun install` — a hunk that mixes a
  version bump with anything else is left for a human.
- A sync in progress is tracked in `.git/kete-upstream-sync.json` (`sync.ts:59`) — only one sync can
  be in flight per checkout; `--abort` deletes the `upstream/vX.Y.Z` branch.
- `release.ts` temporarily overwrites `packages/cli/package.json` and `bun.lock` during the CLI
  build (because per-platform `bun install` rewrites them) and restores the originals afterward
  (`release.ts:74-83`) — a crash mid-build can leave them modified.
- A new GitHub workflow file added by an upstream release starts **enabled** even though every
  inherited workflow is supposed to be disabled in repository settings; `docs/upstream-sync.md`
  ("After the checks") requires disabling each one (`gh workflow disable <file>`) before merging a
  sync PR — `sync.ts`'s report lists them (`addedWorkflows`) but does not disable them itself.
- `gh` defaults to `anomalyco/opencode`, not this repo — always pass `--repo kete-org/ketecode` when
  scripting around these tools.
- **`kete-root-helper.yml` runs on `ubuntu-latest` and passes** (PR #59, 2026-09-30): the root
  integration suite (14/14 — so cgroup v2 delegation, `useradd` and `clone3` into a cgroup work on
  GitHub's runners) and the AC5 end-to-end test (a shell tool call in job mode runs through the
  real helper as the tool uid/gid, with no supplementary groups). Lessons from its first runs:
  under `set -e`, capture a failing test's output with `|| status=$?` before printing it; a
  root-owned file in the sticky `/tmp` can't be removed by the runner user (keep root's files in a
  root-owned dir and use `sudo`); a job-mode test session needs an explicit `title` (automatic title
  generation consumes the first scripted model response) and a policy that allows the tool (with
  no rule, `ask` → deny in an unattended run); the tool user's gid needn't equal its uid.
- **`kete-egress.yml` passed its first run on `ubuntu-latest`** (PR #60, 2026-09-30): unit tests
  and the privileged integration suite, 17/17 — so nftables `inet` with `meta skuid`, `th dport`,
  `ct state`, interval sets and hook priority −155 work on GitHub's runners, and `setpriv`
  (util-linux) is available. The suite must stay under `unshare --net`: applying the job ruleset
  in the runner's own netns would cut the runner off.
