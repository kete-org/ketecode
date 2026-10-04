# Handoff: Cloud job container image and entrypoint (platform ADRs 0018-0021, docs/jobs.md §8 items 1-2)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-09-30 scout

(Summary pasted by the coordinator; the scout has no write tool.)

- Q1 entrypoint steps → docs enough: no — missing: a requirement→mechanism table (new job-image card). Exists: `kete job run --json` (unattended run, result v1), job mode (config ignored, request conformance, registration off, `kete_cloud`), the root helper (per-spawn leaves). New: nftables + proxy + CA, claim client, claim-token hygiene, root pristine clone + agent copy, users/groups/worktree parent, top-level cgroups and limits, kete launch with the clamped timeout and no_new_privs, heartbeats, proxy supervision, kill sequence, bundle reader, uploads, finish, hard deadline, kete stdout to a file. Runtime gaps: kete's server on a unix socket with a per-run secret (today TCP only, `cli/src/server-process.ts`); the gateway key by descriptor (today `OPENCODE_GATEWAY_KEY` env, `gateway.ts:40`); kete's own `openat2` file confinement; `PR_SET_DUMPABLE`; the entrypoint-owned audit/result sink.
- Q2 callbacks → docs enough: no — missing: a jobs-v1 mirror in docs/platform and contracts.md. Shapes in kete-code-platform `docs/jobs.md:178-206`: claim `{claim_token}` → `{spec, gateway_key, callback_token, clone{url,token,ref,base_sha}, gateway_url, platform_url, deadline}`; events `{phase, message?, effective_timeout_minutes?, kete_cgroup_extra?}` → 204 (≥1/60 s); result = `kete job run --json` v1 → 204; uploads `{bundle}` → signed URLs (audit ≤20 MB, proxy log ≤10 MB, bundle ≤10 MB, 10 min); finish `{push_error?}` → 202. Callback token as Bearer; mismatch → 404.
- Q3 egress → docs enough: no — missing: where the proxy lives and its language. Entirely new (ADR 0019 rule 4): nftables inet, proxy user only to 443, privileged loopback ports A/B/R per uid, DNS only for the proxy user, TLS terminated for every host with a per-VM CA, CONNECT = SNI = Host, exact hosts per phase, registries GET/HEAD with path limits, 10 MB log that fails closed.
- Q4 bundle → docs enough: no — missing: the safe reader's shape and location. New (ADR 0021 rules 4-5): root pristine shallow clone, token via extraHeader, HEAD = base_sha, separate agent clone with its own objects; after kete exits kill everything (≤30 s) else `processes_alive`; git lists paths using the pristine git-dir and the job worktree; root reads each with openat/O_NOFOLLOW; gzip tar with manifest.json + files/.
- Q5 packaging → docs enough: no — missing: image workflow, digest pinning, the safe.directory/rg fixes. No image build exists; ADR 0019 rule 7: public GHCR by digest from `kete-v*` release. Binaries: Linux `kete`, the helper, the proxy, distro `git` and `ripgrep` on the tool user's PATH; git safe.directory for the worktree parent.
- Q6 testing → docs enough: no — missing: a fake platform and fake DNS/TLS targets. Precedent: the root-helper workflow (privileged, path-filtered) and `job-helper-e2e.test.ts` gating via non-`KETE_*` env.

## 2026-09-30 coordinator

- User decisions (2026-09-30): split the container-image work into A runtime gaps (TS), B egress proxy + firewall, C entrypoint, D image + publishing + fake platform; order B, then C+D, with A alongside; the proxy and entrypoint in Go next to the root helper. This folder keeps the shared scout notes; each piece has its own task folder.
