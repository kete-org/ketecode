# Plan: Self-hosted job hosts P7: cloud-VM kernel and images, Packer in kete-code, docs

<!-- One build agent planned and built (as P1-P5); this records the plan it followed. -->

## Cards read
- docs/context/modules/job-host.md (verified-at 0cb5c576b2, stale: no)
- docs/context/modules/job-image.md, job-entrypoint.md

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/kete-job-host/kernel/{build.sh,check-config.sh,kete.fragment}` | change / read | variant support |
| `packages/kete-job-host/kernel/cloudvm*.fragment`, `config-cloudvm-*` | new | the cloudvm configuration |
| platform `infra/packer/cloudvm/**` | read | content moved and reworked |
| platform `apps/portal/lib/jobs/host/vm/{adapter,gcp,digitalocean,hetzner,oci}.ts` | read | the digest marker the images must carry |
| `packages/kete-job-entrypoint/internal/guestinit/*`, `hostprofile/*`, `bootenv/*` | read / change | what init needs from the disk; the DHCP gap |
| `packages/kete-job-entrypoint/internal/dhcp/*` | new | init's DHCP client |
| `packages/kete-job-image/packer/**` | new | template, disk scripts, boot test |
| `.github/workflows/kete-release.yml` | change (one job + header lines) | call the images workflow |
| `.github/workflows/kete-cloudvm-{packer,images}.yml`, `.github/actions/kete-cloudvm-setup/` | new | CI |
| READMEs, `docs/job-hosts.md`, cards | change / new | docs |

## Steps
1. cloudvm fragments; `check-config.sh` variants; `build.sh --variant`; `--regen-config` both arches;
   diff against microvm configs; build both kernels; rebuild arm64 and compare.
2. Disk scripts (host: checks + cosign; container: rootfs, refusals, GRUB, partitions, manifest).
3. Read kernel `ipconfig.c` for the DHCP path → `internal/dhcp` + `ParseCmdline` + `Machine.Network`.
4. Test rootfs (kete-job-init, entrypoint, nft), test disks, `boot-test.sh` per provider/firmware.
5. Packer template + convert/import scripts; validate in Docker.
6. Workflows; actionlint.
7. Docs, cards, task files.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `packages/kete-job-host/kernel/check-config.sh`; `build.sh <arch> --variant cloudvm --out …` twice for arm64, `cmp` |
| AC2 | `bash packages/kete-job-image/packer/scripts/build-disk.sh --arch <a> --test-rootfs-tar … --kernel-dir … --out …` |
| AC3 | `DOCKER_CONTEXT=colima-kvmtest bash packages/kete-job-image/packer/test/boot-test.sh --disk … --arch <a> --provider <p> [--firmware bios]` |
| AC4 | entrypoint gofmt/vet/race and `scripts/integration.sh` (commands.md "Go job entrypoint") |
| AC5 | `packer fmt -check`, `packer init`, `packer validate` in `hashicorp/packer:1.16.1` (job-image README "Local runs") |
| AC6 | `docker run rhysd/actionlint`, `bun run lint`, `bun run --cwd packages/kete-tools upstream:check`, `node scripts/agent/card-check.mjs` |

## Cards to update after the build
- job-host, job-image, job-entrypoint; contracts.md (§6d/§6f), commands.md, INDEX.md.
