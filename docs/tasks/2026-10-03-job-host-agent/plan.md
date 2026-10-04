# Plan: Self-hosted job hosts P2: kete-job-host agent core with a fake driver

Written by the build agent (one session: spec, plan, build; user approved design + build).

## Cards read
- docs/context/modules/root-helper.md, egress.md (module layout, Docker test commands, CI pattern)
- docs/context/modules/job-entrypoint.md (bootenv.Config, phaselog, config disk; P1 handoff D1–D14)
- docs/context/modules/kete-tools-ci.md (Go workflow pattern, go.mod pins)
- Design (kete-code-platform, read only): ADR 0023, plan-overview P2, `docs/contracts/job-host-v1.md`,
  test vectors, `packages/shared/src/job-host-crypto.ts` (blocklist, verify order), P2.0 handoff.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/kete-job-host/go.mod`, `.gitignore` | new | module `github.com/kete-org/ketecode/packages/kete-job-host`, go 1.26.0 / toolchain go1.26.8, `golang.org/x/sys v0.48.0` (same pins as siblings) |
| `internal/contract/` | new | wire types, limits, enums, validators (UUID, base64url32, generation, version, image ref, phase line), strict request encoding, tolerant response decoding + validation |
| `internal/sig/` | new | Content-Digest, signature base, signer, verifier (contract order), key hygiene, fingerprint |
| `internal/seal/` | new | HPKE info + binding validation, open (agent), seal (fake platform/tests), `JobMachineConfig` validation, config disk |
| `internal/keys/` | new | generate, store (0600 / 0700), load with permission and key checks |
| `internal/config/` | new | `/etc/kete-job-host/config.json` strict parse: platform URL, driver, slots, reset, generation, resolvers, allowlists, versions, state dir |
| `internal/state/` | new | durable `state.json`: atomic write, 0600, schema version |
| `internal/client/` | new | signed HTTPS client (TLS verify, 15 s, 1 MiB cap), error parsing, backoff |
| `internal/clock/` | new | NTP sync check (`adjtimex` on Linux; not-synced elsewhere) |
| `internal/driver/` | new | `Driver` interface; `driver/fake` test driver |
| `internal/image/` | new | allowlist + `Verifier` interface; `Unconfigured` (refuses all) |
| `internal/phase/` | new | phase-line filter and per-machine buffer with acknowledgement |
| `internal/agent/` | new | machine table, state machine, assignment checks, desired-state apply, poll loop, deadline killer, restart reconcile |
| `internal/enroll/` | new | enrollment flow (keys, facts, request, response check, state) |
| `internal/fakeplatform/` | new | P2.0 routes for tests |
| `cmd/kete-job-host/main.go` | new | `enroll`, `run`, `doctor`, `fingerprint`, `version` |
| `testdata/job-host-v1/*.json`, `SHA256SUMS` | new | vectors, byte for byte |
| `packaging/kete-job-host.service`, `README.md` | new | systemd unit, module contract/README |
| `.github/workflows/kete-job-host.yml` | new | path-filtered CI |
| `docs/platform/job-host-v1.md` | new | contract copy (platform commit 04d406a) |
| `docs/context/{INDEX,repo-map,commands,contracts}.md`, `modules/job-host.md`, `modules/kete-tools-ci.md` | change/new | knowledge base |

## Steps
1. Copy vectors + SHA256SUMS; contract + sig + seal packages with vector tests (AC1).
2. keys, config, state, clock, client, image, phase, driver + fake.
3. agent core (apply, checks, killer, reconcile, poll loop with error table) and enroll.
4. fakeplatform; scenario tests (AC2–AC8) over real TLS with a generated CA and dial override.
5. cmd, systemd unit, README, workflow; docs/context; result, handoff, metrics.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `go test ./internal/sig ./internal/seal ./testdata/...` (vector tests incl. drift) |
| AC2–AC5, AC7, AC8 | `go test -race ./internal/agent/...` (scenario tests against the fake platform) |
| AC6 | `go test ./internal/image` + `TestScenarioImageSignatureRefused` |
| AC9 | `docker run --rm -v "$PWD/packages/kete-job-host:/src" -w /src golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go test -race ./...'`; actionlint (docker `rhysd/actionlint`); `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `node scripts/agent/card-check.mjs` |

## Cards to update after the build
- new `job-host`; `kete-tools-ci` (workflow, go.mod pins); INDEX, repo-map, commands, contracts §6f.
