# Commands

Narrowest first. **Run tests inside the package directory, never from the repo root** (the
root `bun run test` fails on purpose). Verified on 2026-09-28 at bfd6c66 unless marked
otherwise. Set `NO_COLOR=1` when parsing output. For agents:
`node scripts/agent/check-summary.mjs bash -c "cd packages/<pkg> && <command>"` prints only
pass/fail and the failing tests.

## Tests: one file

| Package | Command (inside the package) | Verified |
|---|---|---|
| core | `bun run test ./test/kete/budget.test.ts` (the script isolates HOME/XDG; never bare `bun test` here) | ✓ 6 |
| util | `bun test ./test/kete/env.test.ts` | ✓ 8 |
| cli | `bun test ./test/kete/login.test.ts` | ✓ 33 |
| tui | `bun test ./test/kete/theme.test.ts` | ✓ 5 |
| server | `bun run test ./test/kete/local-guard.test.ts` (isolated HOME) | ✓ 6 |
| app | `bun test --conditions=solid --preload ./happydom.ts ./src/kete/brand-text.test.ts` | ✓ 7 |
| ui | `bun test ./src/theme/kete/theme.test.ts` | ✓ 4 |
| kete-tools | `bun test ./test/lib.test.ts` | ✓ 13 |
| kete-vscode | `bun test ./test/status.test.ts` | ✓ 8 |
| one test by name | add `-t "<name>"` | — |

Kete tests live in `packages/<pkg>/test/kete/` (core, util, cli, tui, server),
`packages/app/src/kete/*.test.ts`, `packages/ui/src/theme/kete/`, `packages/kete-tools/test/`
and `packages/kete-vscode/test/`.

## Tests: suites

| Scope | Command (inside the package) | Verified |
|---|---|---|
| core, Kete tests | `bun run test ./test/kete` | ✓ 125 (19 files) |
| util, Kete tests | `bun test ./test/kete` | ✓ 48 |
| cli, Kete tests | `bun test ./test/kete` | ✓ 58 |
| kete-vscode | `bun run test` | ✓ 75 |
| kete-tools | `bun run test` | ✓ 42 |
| app unit | `bun run test:unit` | — (950 on 2026-09-28) |
| core, full | `bun run test` | 30 known machine-dependent failures (ripgrep, shell) that `main` has too; `pty` can time out under load |
| server, full | `bun run test` | — (65 on 2026-09-28) |
| tui, full | `bun test` | 2 `dialog-shell-output` timeouts that `main` has too |

## Go root helper (`packages/kete-root-helper/`; no Go needed locally)

Everything runs in the official `golang` Docker image (Colima works as the Docker runtime on
macOS — confirm `docker info --format '{{.CgroupVersion}}'` prints `2` first). Full detail: the
`root-helper` card and `packages/kete-root-helper/README.md`.

| Task | Command (from the repo root) |
|---|---|
| Go vet + unit tests | `docker run --rm -v "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm sh -c 'go vet ./... && go test ./...'` |
| Linux integration tests (root, real users, cgroup v2) | `docker run --rm --privileged --cgroupns=private -v "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm bash scripts/integration.sh` (append `-test.run <Name>` for a subset) |
| AC5 end to end, via CI (Linux+sudo+bun+Go, not practical on a Mac) | `gh workflow run kete-root-helper.yml --repo kete-org/ketecode --ref <branch>` then `gh run watch --repo kete-org/ketecode` |

## Go egress proxy (`packages/kete-egress/`; no Go needed locally)

Same Docker/Colima setup as the root helper (cgroup v2 not needed). Full detail: the `egress` card
and `packages/kete-egress/README.md` "How to test".

| Task | Command (from the repo root) |
|---|---|
| gofmt + vet + unit tests (race) | `docker run --rm -v "$PWD/packages/kete-egress:/src" -w /src golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'` |
| Integration suite (root, real users, real nftables, own netns) | `docker run --rm --privileged -v "$PWD/packages/kete-egress:/src" -w /src golang:1.26-bookworm bash scripts/integration.sh` (append `-test.run <Name>` for a subset) |
| CI | `gh workflow run kete-egress.yml --repo kete-org/ketecode --ref <branch>` then `gh run watch --repo kete-org/ketecode` |

## Go job host agent (`packages/kete-job-host/`; no Go needed locally)

Unit tests need no KVM or network: the in-repo fake platform (real TLS), the fake driver, a local
registry, checked-in Sigstore data. They need root (the container's default user; `sudo` in CI)
because the agent refuses files not owned by root; `--privileged` (the container's own network
namespace) and `nft` let the host-table tests run (they skip otherwise). The KVM acceptance tests
need a KVM host. Full detail: the `job-host` card and `packages/kete-job-host/README.md` "How to
test".

| Task | Command (from the repo root) |
|---|---|
| gofmt + vet + tests (race) | `docker run --rm --privileged -v "$PWD/packages/kete-job-host:/src" -w /src golang:1.26-bookworm sh -c 'apt-get update -qq && apt-get install -y -qq nftables iproute2 >/dev/null; test -z "$(gofmt -l .)" && go vet ./... && go vet -tags kvm ./... && go test -race ./...'` |
| Guest kernel config check | `packages/kete-job-host/kernel/check-config.sh` |
| Build a guest kernel (Docker, ~5 min + apt from the Debian snapshot) | `packages/kete-job-host/kernel/build.sh <amd64\|arm64> [--variant microvm\|cloudvm] [--out DIR]`; `--regen-config` rebuilds that variant's `config-<arch>` / `config-cloudvm-<arch>`. Always a `linux/amd64` container; `--check-only` checks a config without compiling. Regenerate configs from CI's `kernel-config` job artifacts, not under emulation on arm64 (unreliable); a local `--out` must be a Colima-shared path (`kernel/.cache/…`, not `/tmp`) |
| Cloudvm kernel config check | `packages/kete-job-host/kernel/check-config.sh --variant cloudvm --arch arm64 [file]` (no arguments: all four configs) |
| Golden files (host table, jailer args) | `go test ./internal/hostnet/ ./internal/driver/firecracker/ -update` (review the diff) |
| KVM acceptance tests | build `go test -c -tags kvm ./internal/kvmtest` and `go build ./internal/kvmtest/probe` (CGO off), stage the files `scripts/kvm-test.sh` lists, then `sudo scripts/kvm-test.sh <dir> [TestName]` on the KVM host (locally: `colima ssh -p kvmtest -- sudo …`) |
| Dedicated driver real job (any Linux root host, no KVM) | stage `kvm.test`, `probe`, `kete-job.tar` (`DOCKER_CONTEXT=colima-kvmtest packages/kete-job-image/scripts/build.sh --arch arm64 --tag kete-job:p5`, then `docker save` in the VM) and `kete-job-fake-platform` (from `packages/kete-job-image/.build/<arch>/bin/`), then `sudo scripts/kvm-test.sh <dir> TestDedicated` |
| One test | append `-run TestLifecycle ./internal/agent/` instead of `./...` |
| Vectors vs the platform's files | add `-v ../kete-code-platform/docs/contracts/test-vectors/job-host-v1:/pv:ro -e KETE_PLATFORM_VECTORS=/pv` and run `go test ./internal/vectors/` |
| Lint the workflow | `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -no-color .github/workflows/kete-job-host.yml` |
| CI | `gh workflow run kete-job-host.yml --repo kete-org/ketecode --ref <branch>` then `gh run watch --repo kete-org/ketecode` |

## Go job entrypoint (`packages/kete-job-entrypoint/`; no Go needed locally)

Same Docker/Colima setup as the root helper (cgroup v2 required for the integration suite). Mount
`packages/`, not the module: the suite builds the sibling helper and proxy. Full detail: the
`job-entrypoint` card and `packages/kete-job-entrypoint/README.md` "How to test".

| Task | Command (from the repo root) |
|---|---|
| gofmt + vet + unit tests (race) | `docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'` |
| Integration suite (root, real helper/proxy/users/cgroups/nftables, fake platform, fake `kete`) | `docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm bash scripts/integration.sh` (append `-test.run <Name>`) |
| CI | `gh workflow run kete-job-entrypoint.yml --repo kete-org/ketecode --ref <branch>` then `gh run watch --repo kete-org/ketecode` |
| `kete job run` job-mode tests | `bun test ./test/kete/job-run.test.ts` in `packages/cli/`; `bun run test ./test/kete/job-run.test.ts` in `packages/server/` |
| Linux `kete` cross-build | `bun run build --target=kete-linux-arm64 --skip-web-ui` in `packages/cli/` → `dist/cli-linux-arm64/bin/kete` |

## Job image (`packages/kete-job-image/`; no Go needed locally)

Colima (or Docker) must run; the Go binaries are built in `golang:1.26-bookworm` with the
`kete-egress-gomod`/`kete-egress-gocache` volumes. Full detail: the `job-image` card and
`packages/kete-job-image/README.md`. Disk: ~1 GB image + ~1 GB test layer; build only the host arch.

| Task | Command (from the repo root) |
|---|---|
| Linux `kete` for the Docker host (Apple-silicon: arm64; CI: x64) | `(cd packages/cli && bun run build --target=kete-linux-arm64 --skip-web-ui)` |
| Build Go binaries, stage context, build image `kete-job:local` | `bash packages/kete-job-image/scripts/build.sh` (`--arch amd64\|arm64`, `--kete <path>`, `--tag`, `--no-image`) |
| End-to-end, fastest scenario | `bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario no-agent` |
| End-to-end, one or all scenarios | `bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario lifecycle\|ac5\|all` (`ac5` needs the network) |
| Keep the job's logs / move state | `E2E_KEEP_LOGS=1`, `E2E_STATE=<dir>` (default `.build/e2e-state`), `E2E_JOB_TIMEOUT=<s>` |
| Vet the e2e asserter | `docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm go vet -tags e2e ./...` |
| CI | `gh workflow run kete-job-image.yml --repo kete-org/ketecode --ref <branch>` |
| Cloudvm kernel (host arch) | `packages/kete-job-host/kernel/build.sh arm64 --variant cloudvm --out packages/kete-job-host/kernel/dist` |
| Cloudvm test disk (a rootfs tar with `kete-job-init`, `kete-job-entrypoint`, `nft`) | `bash packages/kete-job-image/packer/scripts/build-disk.sh --arch arm64 --test-rootfs-tar <tar> --kernel-dir packages/kete-job-host/kernel/dist --out packages/kete-job-image/.build/disk --disk-gib 8` (a real disk: `--job-image ghcr.io/kete-org/kete-job@sha256:…`, needs cosign v3) |
| Boot the disk (QEMU, needs `/dev/kvm`) | `DOCKER_CONTEXT=colima-kvmtest bash packages/kete-job-image/packer/test/boot-test.sh --disk <raw> --arch arm64 --provider gcp\|digitalocean\|hetzner\|oci` (`--firmware bios` for amd64) |
| Packer validate | `docker run --rm --entrypoint sh … hashicorp/packer:1.16.1 -c 'packer init . && packer validate …'`: full command in `packages/kete-job-image/README.md` "Local runs" |

## Typecheck, lint, upstream hygiene

| Scope | Command | Verified |
|---|---|---|
| One package | `bun run typecheck` inside it (core runs `tsgo -b` over src and tests) | ✓ core, util, cli, kete-vscode, kete-tools |
| All packages | `bun turbo typecheck` (root) | — (37 tasks on 2026-09-28) |
| Lint | `bun run lint` (root, oxlint) | ✓ 0 warnings |
| Markers, leaks, licence | `bun run --cwd packages/kete-tools upstream:check` (root) | ✓ |
| Before a PR | `bun run --cwd packages/kete-tools verify --base main` (typecheck + tests, only failures `main` doesn't have) | — |
| Upstream edits list | `git grep -n kete_change -- packages` | — |

## Generated code

- After changing server endpoints, the protocol, or schema types they expose (e.g. the config
  schema): `bun run generate` in `packages/protocol` (writes `openapi.json`), then
  `bun run generate` in `packages/client` (writes `src/*/generated/`). Commit both; never
  hand-edit generated files.
- Kete agents for Kete Code: edit `.claude/agents/*.md`, then `node scripts/agent/kete-agents.mjs`
  (`--check` fails when `.kete/` is out of date).

## Build and run

| Task | Command |
|---|---|
| Dev CLI | `bun run dev` (root) |
| Binary for this platform | `bun run build --single --skip-install --skip-web-ui` in `packages/cli` → `dist/cli-<os>-<arch>/bin/kete` |
| List agents the binary loads here | `packages/cli/dist/cli-<os>-<arch>/bin/kete debug agents` |
| VS Code extension | `bun run build` in `packages/kete-vscode`; `bun run e2e` for the local end-to-end check |
| Role check (real model, costs money) | `bun run --cwd packages/kete-tools role-check --model …` |

## Upstream sync and release (maintainers)

- Sync: `bun run --cwd packages/kete-tools upstream:sync vX.Y.Z --verify` on an `upstream/vX.Y.Z`
  branch (`--continue`, `--abort`; report in `.git/kete-upstream-sync-report.md`); runbook
  `docs/upstream-sync.md`.
- Release: tag `kete-vX.Y.Z` (never bare `vX.Y.Z`); `docs/release.md`. Never push upstream's tags
  or run upstream's `packages/cli/script/publish*.ts`.

## Agent scripts

| Script | Purpose |
|---|---|
| `node scripts/agent/stale-cards.mjs [card …]` | cards whose `paths` changed since `verified-at` |
| `node scripts/agent/card-check.mjs` | card sections, `path:line` references, no secrets |
| `node scripts/agent/check-summary.mjs <command…>` | run a check; print pass/fail and failing excerpts |
| `node scripts/agent/task-new.mjs <slug> [medium\|large] [title]` | create `docs/tasks/<date>-<slug>/` |
| `node scripts/agent/kete-agents.mjs [--check]` | generate `.kete/agents/` and `.kete/kete.jsonc` from `.claude/` |
