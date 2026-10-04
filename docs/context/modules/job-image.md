---
module: job-image
paths: [packages/kete-job-image/**, .github/workflows/kete-job-image.yml, .github/workflows/kete-release.yml, .github/workflows/kete-cloudvm-packer.yml, .github/workflows/kete-cloudvm-images.yml, .github/actions/kete-cloudvm-setup/**]
verified-at: e65d087e3c
---

## Quick answers
- What is this module? The cloud job image (piece D of the container work; platform `docs/jobs.md`
  §8 items 1-2, ADR 0019 rule 5): one container runs one job end to end. It holds only the image
  definition, its build and its e2e test; no Go or TypeScript code (`packages/kete-job-image/README.md`).
  The contract is the entrypoint's (`job-entrypoint` card) and `contracts.md` §6d "Image".
- What is in the image? `debian:trixie-slim` pinned by digest (`Dockerfile:9`) plus git, ripgrep,
  nftables, ca-certificates, nodejs, npm, python3, venv and pip (`:23-27`; cargo only in the test
  layer, `test/Dockerfile.e2e`). `kete` at `/usr/local/bin/kete`; entrypoint, `kete-job-init`
  (self-hosted microvm/cloudvm PID 1, unused on Fly), root helper and egress proxy at
  `/usr/local/libexec/kete/`, all root 0755, checked at build. Users
  `kete`, `kete-tool`, `kete-proxy`, group `kete-job` made at build time (`:31-34`). Every setuid/setgid
  bit stripped (`:27`, verified `:46`). `ENTRYPOINT` is the entrypoint (`:53`); no `USER`, no `CMD`.
  No secret and no CA key (the proxy's CA is per VM, in memory).
- Why does the Dockerfile have no Go build stage? D-choice: `scripts/build.sh` compiles the Go
  binaries in `golang:1.26-bookworm` (the host has no Go), stages `.build/ctx-<arch>/`, then a plain
  `docker build` (no buildx needed locally).
- How do I build and test it? `commands.md` "Job image": `build.sh` then `e2e.sh <image> --scenario
  no-agent|lifecycle|ac5|all`. The Linux `kete` must be built first (`packages/cli`, `bun run build
  --target=kete-linux-<arm64|x64> --skip-web-ui`) or passed with `--kete`.
- What do the scenarios cover? `no-agent`: `kete job run` refuses (exit 2) before any model call, the
  job still reports. `lifecycle`: AC1 with the real `kete` (sync with the gateway key, scripted model
  runs `id -un` = `kete-tool`, edits README.md, then (piece A3) the tool user plants two symlinks into kete's home (`e2e-read` to `spec.json`, `e2e-write`), `read` and `write` through them must be refused (the read result holds nothing of the spec) and the links are removed; bundle = that file, audit `run ended completed` plus an error `tool` line for the refused read).
  `ac5`: npm, pip and cargo installs through the proxy with its name-constrained CA (needs the
  network; a registry outage fails it, retry once). Every scenario also scans the stopped
  container's streamed `docker export` for the claim, callback and clone tokens and the gateway key
  (`TestExportScan`). The export scan also checks (A3) that kete's data dir holds no audit log, that the refused write created nothing in kete's home, and that the root 0600 `/var/log/kete-job/kete.audit.jsonl` is byte-equal to the uploaded audit (empty when none was uploaded).
- Where does the e2e run? Containerised fake platform at `198.51.100.10` on a Docker network
  `198.51.100.0/24` (Docker's own ranges are in the proxy blocklist; its embedded DNS is loopback,
  which the proxy refuses), job container `--privileged --cgroupns=private` run **as the dedicated
  host profile** (`KETE_JOB_HOST_PROFILE=dedicated`, `--config-fd 0`, the fake's `config.json` on
  stdin via `docker run -i` in the background), bind-mounted `resolv.conf` and a CA bundle plus the
  fake's per-run test CA (`scripts/e2e.sh`). A host-side nft table `inet kete_e2e_host` (applied from
  a `--network host` container, removed on exit) stands in for the host agent's table so the
  entrypoint's host-boundary probe passes: job → Docker host dropped, private/special ranges
  dropped, only the fake and TCP 443 forwarded. It saves and restores the host-wide
  `user.max_user_namespaces`. State: `.build/e2e-state/<scenario>/`
  (`E2E_STATE`, `E2E_KEEP_LOGS=1`, `E2E_JOB_TIMEOUT`); it holds test credentials only.
- Which workflows? `.github/workflows/kete-job-image.yml` (path-filtered PR/push to `main` + dispatch;
  linux-x64 `kete`, `build.sh --arch amd64`, `e2e.sh`; pushes nothing). The release workflow's `image`
  job: after build, smoke and extension, builds `kete-job:amd64` (released linux-x64 `kete`, e2e)
  and `kete-job:arm64` (linux-arm64 `kete`, QEMU via `docker/setup-qemu-action`, smoke: entrypoint
  exit 2 `boot invalid`, init exit 2 off PID 1), read-only, and on tags saves both as an artifact;
  the tag-only `image-publish` job (alone holding `packages`/`id-token: write`) loads them and pushes both
  (`:<tag>-linux-<arch>`), resolves each platform manifest digest, `buildx imagetools create`s the
  index `:<tag>`, cosign-signs (keyless, `sigstore/cosign-installer`, cosign v3.0.6, `id-token:
  write`) index + both digests and verifies each against
  `https://github.com/<repo>/.github/workflows/kete-release.yml@refs/tags/<tag>`. `publish` writes
  `kete-job-image.digest` (unchanged: the amd64 line Fly pins), `kete-job-image.digests` (index,
  per-arch, identity, issuer) and the notes lines. Manual dispatch builds and tests both, never
  pushes or signs. `kete-tools-ci` card.
- A job can only use a model in the shipped `kete`'s bundled models.dev snapshot (fetch disabled by
  `KETE_DISABLE_MODELS_FETCH=1`, port A never allows models.dev); hand that to the platform with
  each release (`job-mode` card).
- Which architectures? linux/amd64 and linux/arm64, one signed index (self-hosted P1, ADR 0023 rule
  17); Fly keeps pinning the amd64 digest until a Fly staging machine is confirmed to start from the
  index. `build.sh` passes `--platform linux/<arch>`; locally build the host's arch (Colima: arm64).
- Provider images (cloudvm, self-hosted P7, ADR 0023 rules 15, 18, 21)? README "Provider images
  (cloudvm)". `packer/scripts/build-disk.sh` (host: input checks, kernel `.sha256` + `check-config.sh
  --variant cloudvm`, `cosign verify` of the job image's **index digest** before any pull) runs
  `assemble-disk.sh` in a pinned Debian builder (container root, no loop devices): skopeo + umoci
  rootfs; refuses sshd/dropbear/cloud-init/guest agents/`google_*`/waagent/`authorized_keys` by name anywhere, systemd, `/etc/ssh`, `/etc/cloud`, any unlocked account (only `*`/`!` password fields); GRUB
  (BIOS + UEFI amd64, UEFI arm64) with its config built in; GPT 1 `bios-boot`, 2 `kete-efi` (FAT
  `KETE-EFI`: GRUB + `vmlinuz`), 3 `kete-root` (ext4, read-only), 4 `kete-scratch`; manifest
  `kete-cloudvm-<arch>.json` format `kete-cloudvm-disk v1` (`contracts.md` §6g). Kernel cmdline
  includes `quiet` (kernel messages would interleave with the serial phase lines the GCP/OCI adapters
  read) and `kete.net=dhcp kete.dns=…` (`job-entrypoint` card, kete-job-init). `packer/cloudvm.pkr.hcl`
  (`gcp`, `digitalocean`, `hetzner`, `oci` builds; plugins pinned exactly; description or OCI tag
  `kete_job_image` = `kete-job-image=<index digest>`, what the platform adapters check, `:101`) calls
  `convert-disk.sh` (refuses test disks, wrong arch or image, sha mismatch; DigitalOcean amd64 only)
  and `oci-import.sh`.
- How is the cloudvm disk tested? `packer/test/boot-test.sh` + `boot-test-inner.sh`: QEMU + dnsmasq +
  fake metadata in one container with `/dev/kvm`, per provider lease shapes (gcp /32 + option 121,
  hetzner /32 + off-link router, oci/digitalocean /24); passes on `init_*` ok, `init_entrypoint`
  start and the entrypoint's `boot`, `setup_host`. `commands.md` "Job image".
- Which cloudvm workflows? `kete-cloudvm-packer.yml` (PR, path-filtered: kernel configs, shell syntax,
  `packer fmt/init/validate` with placeholders). `kete-cloudvm-images.yml` (reusable; called by the
  release's `cloudvm-images` job after `image-publish`, `kete-release.yml:516`, no secrets passed; or by
  hand from a tag): kernels, base disks (signature checked), then one job per provider in environment
  `cloudvm-images` that imports only when its image-builder secret exists. `.github/actions/
  kete-cloudvm-setup` is the shared setup. Operator guide: `docs/job-hosts.md`.

## Purpose
Package the cloud job runtime as one container image the platform pins by digest, and prove it
end to end with the real entrypoint, helper, proxy and `kete` against a fake platform before it is
published. Image size is about 1 GB (test layer about 1 GB more), so disk matters locally.

## Entry points
- `packages/kete-job-image/scripts/build.sh` — compile, stage, `docker build` (`--arch`, `--kete`,
  `--tag` default `kete-job:local`, `--version`, `--revision`, `--no-image`).
- `packages/kete-job-image/scripts/e2e.sh <image> [--scenario …]` — the e2e.
- `.github/workflows/kete-job-image.yml` and the `image` job of `.github/workflows/kete-release.yml`.

## Key files
| File | What |
|---|---|
| `packages/kete-job-image/Dockerfile` | the published image, from a staged context |
| `packages/kete-job-image/gitconfig` | `/etc/gitconfig`: `safe.directory` for the job users' git |
| `packages/kete-job-image/test/Dockerfile.e2e` | test layer: the image plus cargo, the fake platform and the asserter; never published |
| `packages/kete-job-image/scripts/build.sh`, `scripts/e2e.sh` | build and e2e drivers |
| `packages/kete-job-image/packer/cloudvm.pkr.hcl`, `packer/scripts/{build-disk,assemble-disk,convert-disk,oci-import}.sh`, `packer/test/boot-test{,-inner}.sh` | provider images (cloudvm): disk build, Packer template, import, local boot test |
| `packages/kete-job-entrypoint/cmd/kete-job-fake-platform/`, `internal/fakeplatform/`, `internal/e2e/` | the fake and the asserter (`job-entrypoint` card) |

## Data flow
`build.sh`: Go binaries (entrypoint, fake platform, `e2e.test`, helper, proxy) in `golang:1.26-bookworm`
→ `.build/<arch>/bin` → staged `.build/ctx-<arch>/` with the Dockerfiles, LICENSE, NOTICE and `kete`
→ image. `e2e.sh`: test layer → network → fake (`-scenario`) writes `job.env` and `ca.pem` → job
container runs to exit → `docker export` piped into `TestExportScan` → asserter over the fake's state.

## Data and APIs used
Docker (Colima locally), `golang:1.26-bookworm` with cache volumes `kete-egress-gomod` and
`kete-egress-gocache`, GHCR (`ghcr.io/kete-org/kete-job`), real npm, PyPI and crates.io (`ac5` only).

## Rules that must not break
- No secret, token or CA key is baked into the image; the export scan must stay clean.
- No setuid/setgid file; entrypoint, helper, proxy and `kete` root-owned 0755 (the entrypoint verifies
  the users at boot).
- The release pushes the exact image the e2e tested, after the extension check; credentials never go
  on a command line (`docker login --password-stdin`).
- Don't commit `packages/cli/package.json` reordering from the CLI build; `.build/` is git-ignored.
- Never ship test credentials: the e2e state's `tokens.json` and `job.env` are deleted before upload.

## Testing
`bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario no-agent` (fastest), then `all`.
Go side: `go test -tags e2e` compiles via `build.sh`; `go vet -tags e2e` runs in
`kete-job-entrypoint.yml`. Not verified here: a real Fly machine, the GHCR pull by digest from Fly; for cloudvm, a real import and boot per provider (DigitalOcean may not offer DHCP), GCP Secure Boot (keep off), growing `kete-scratch` past `--disk-gib`.

## Changes
- `docs/tasks/2026-10-03-job-host-cloudvm-images/` (self-hosted P7): `packer/` moved here from the
  platform's `infra/packer/cloudvm/`; the cloudvm disk, provider images, boot test, two workflows and
  the composite action; `kete-release.yml` job `cloudvm-images`.
- `docs/tasks/2026-10-03-job-host-profiles/` (self-hosted P1): `kete-job-init` in the image;
  `build.sh --platform`; e2e as the dedicated profile over a pipe with the host-side table; the
  release's multi-arch signed index.
`docs/tasks/2026-09-30-job-entrypoint/` (PR 2, piece D). A new package in the image: add it to the
Dockerfile `COPY`, `build.sh`'s staging and the build-time checks. A new e2e scenario: the fake's
`-scenario` switch, an `internal/e2e` test and the `e2e.sh` case list.

## Gotchas
- `build.sh`'s CLI build runs `bun install` for the target's native packages (see Rules).
- cargo downloads need the egress `crate_download` shape (`egress` card).
- The entrypoint sends `events(agent, eff)` right after starting `kete`, so the e2e asserts
  `revoke < sync < skill_files < first messages`, not an exact sync-then-events order.
- The `no-agent` scenario uploads no audit log (`kete` refuses before any session).
- Seen once, not reproduced: an `ac5` tool result missing its last line and `exit` field (the helper
  sends `EXIT` before draining output by design; see the `root-helper` card on the half-close fix).
