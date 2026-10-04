# Result: Self-hosted job hosts P7: cloud-VM kernel and images, Packer in kete-code, docs

## What changed
All Kete-owned paths; no upstream file touched.
- `packages/kete-job-host/kernel/`: `cloudvm.fragment`, `cloudvm-amd64.fragment`,
  `cloudvm-arm64.fragment`, `config-cloudvm-amd64`, `config-cloudvm-arm64` (new);
  `check-config.sh` (`--variant`/`--arch`, all four configs by default); `build.sh` (`--variant
  cloudvm`: bzImage/Image, `.sha256`, `.config`).
- `packages/kete-job-entrypoint/internal/dhcp/` (new): `dhcp.go`, `packet.go`, `client_linux.go`,
  `netlink_linux.go`, `dhcp_test.go`, `netlink_linux_test.go` — kete-job-init's DHCPv4 client.
- `packages/kete-job-entrypoint/internal/guestinit/`: `cmdline.go` + `cmdline_test.go` (new,
  `ParseCmdline`), `init_linux.go` (`Machine.Network`: DHCP when `kete.net=dhcp`, `DHCP` field),
  `guestinit.go` (docs).
- `packages/kete-job-image/packer/` (new; moved from platform `infra/packer/cloudvm/` and reworked):
  `cloudvm.pkr.hcl`, `.gitignore`, `scripts/{build-disk,assemble-disk,convert-disk,oci-import}.sh`,
  `test/{boot-test,boot-test-inner}.sh`.
- `.github/workflows/kete-cloudvm-packer.yml`, `.github/workflows/kete-cloudvm-images.yml`,
  `.github/actions/kete-cloudvm-setup/action.yml` (new); `.github/workflows/kete-release.yml`
  (`cloudvm-images` job + header lines only).
- Docs: `docs/job-hosts.md` (new operator guide); `packages/kete-job-host/README.md` ("Guest
  kernel" cloudvm variant, guide pointer); `packages/kete-job-image/README.md` ("Provider images
  (cloudvm)", files); `packages/kete-job-entrypoint/README.md` ("kete-job-init" steps 1, 3, 6,
  "Not verified without a real host").
- `docs/context/`: `modules/{job-host,job-image,job-entrypoint,kete-tools-ci}.md`, `contracts.md`
  §6g, `commands.md`, `INDEX.md` (librarian).

## Checks
| Check | Result |
|---|---|
| `kernel/check-config.sh` (microvm + cloudvm, amd64 + arm64) | pass (4 configs) |
| cloudvm vs microvm config diff | only additions (EFI, GPT, drivers, RTCs, consoles, NET_VENDOR menus) |
| `build.sh arm64 --variant cloudvm` (native, Colima) | pass, `sha256:20da9078…6832`, 4 min 45 s |
| `build.sh amd64 --variant cloudvm` (cross) | pass, `sha256:072081c2…75ec5` |
| arm64 rebuild | bit-identical (`cmp`) |
| `build-disk.sh` arm64 + amd64 (test rootfs, 8 GiB) | pass; manifests written |
| `build-disk.sh` refusals | undigested image, kernel ≠ `.sha256`, `.config` failing check-config, `/usr/sbin/sshd` in the image: all refused |
| `convert-disk.sh` | refuses test manifest, sha mismatch, DO arm64; gcp tar holds exactly `disk.raw` |
| boot test arm64 (KVM, kvmtest) | PASS gcp, hetzner, oci, digitalocean (UEFI): init steps ok → entrypoint `boot`, `setup_host` ok; one user-data request; ~5 s firmware to entrypoint |
| boot test amd64 (TCG, kvmtest) | PASS BIOS/hetzner, UEFI/gcp |
| entrypoint gofmt, vet (+ `integration`, `e2e` tags, `GOOS=darwin`), `go test -race ./...` | pass |
| entrypoint integration suite (privileged) | pass |
| `packer fmt -check`, `init`, `validate` (1.16.1, both arches, all builds); undigested `job_image` | pass; refused |
| actionlint (`kete-release.yml`, `kete-cloudvm-images.yml`, `kete-cloudvm-packer.yml`, `kete-job-host.yml`) | pass |
| shellcheck `-S warning` (packer scripts, boot test, kernel scripts) | pass (SC2054 disabled in the boot test: QEMU/dnsmasq arguments) |
| `bun run lint` | pass (0 warnings) |
| `bun run --cwd packages/kete-tools upstream:check` | pass |
| `node scripts/agent/card-check.mjs` | pass (27 cards) |
| firecracker KVM acceptance tests (P4) | not re-run (no Firecracker/microvm kernel staged); microvm network path unchanged apart from reading `/proc/cmdline` |
| real provider import/boot | not possible (no accounts, U3) |

## Acceptance criteria
- [x] AC1 — check-config, diff, both builds, bit-identical arm64 rebuild.
- [x] AC2 — disks for both arches; refusals above.
- [x] AC3 — six boot-test passes above.
- [x] AC4 — `internal/dhcp` (`TestProviderLeases`, `TestLeaseRefuses`, `TestParseRefuses`,
  `TestPackets`, `TestAddrMessage`, `TestRouteMessage`, `TestAckFor`), `TestParseCmdline`; race and
  integration suites.
- [x] AC5 — packer validate; description `Kete Code cloud job VM (cloudvm <arch>)
  kete-job-image=sha256:<64 hex>` (matches `IMAGE_DIGEST_MARKER`), OCI `freeformTags.kete_job_image`.
- [x] AC6 — actionlint, lint, upstream:check, card-check.

## Cards updated
job-host, job-image, job-entrypoint, kete-tools-ci; contracts.md §6g; commands.md; INDEX.md.
`stale-cards.mjs` lists them until the commit (it counts uncommitted files).

## Metrics
- Agents used: one build agent, librarian
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: ~3 h

## Review fixes (2026-10-04)
Security review: approve with 7 minors, all fixed (handoff.md "security review fixes").
| Check | Result |
|---|---|
| entrypoint gofmt, vet (+ `integration`, `e2e`, `GOOS=darwin`), `go test -race -count=1 ./...` | pass (new `TestCheckAck`, extended `TestLeaseRefuses`, `TestParseCmdline`) |
| entrypoint integration suite (privileged) | pass (28 tests, 0 failures) |
| assemble-disk checks on the job image's package set | pass; empty shadow password refused |
| `build-disk.sh --resolvers` | public accepted; 10/8, 100.64/10, 172.16/12, 169.254/16, 0/8, 240/4, 256.x, `01.x`, trailing comma, three addresses refused |
| shellcheck `-S warning` | pass |
| packer fmt/init/validate (both arches), undigested image refused | pass |
| actionlint (release, cloudvm-images, cloudvm-packer, job-host) | pass |
| cloudvm kernel arm64 rebuilt | same digest `sha256:20da9078…6832` (third identical build) |
| boot test arm64 KVM (new init) | PASS gcp, hetzner, oci |
| `bun run lint`, `upstream:check`, `card-check` | pass |
