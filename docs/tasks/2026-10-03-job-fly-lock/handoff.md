# Handoff: Job entrypoint: fail closed on Fly guards; in-VM isolation check

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-03 builder (autonomous)

**Done.** Spec, plan and build in one pass (spec.md, plan.md, result.md). Fly guard fails closed;
isolation self-check before claim; unit and privileged integration tests; README section and
staging runbook; card and `contracts.md` §6d updated. Nothing committed or pushed.

**Decisions (all tighten security; none relaxes a check, touches money or changes a platform-visible
contract):**
- D1 Fly detection: `bootenv.Values.OnFly` = any of `FLY_MACHINE_ID`, `FLY_ALLOC_ID`,
  `FLY_APP_NAME`, `FLY_REGION`, `FLY_PRIVATE_IP` non-empty at boot (values never read or kept),
  carried as one bit across the scrubbed re-exec. `/.fly` existing also counts as Fly, so a
  `/.fly` without `api` fails closed even with no Fly variable.
- D2 The guard also locks `/.fly/api` itself root 0600 (defence in depth under the 0700 dir) and
  refuses a non-socket or symlink `api`.
- D3 The probe is a dedicated re-exec of the entrypoint (`__isolation_probe`) through `launch`,
  not the root helper: the helper's socket is kete-only and its spawns need a worktree that
  doesn't exist before claim. The probe copies the helper's tool identity (uid `kete-tool`, gid
  `kete-job`, `setgroups([])`, NNP) and runs in a leaf of the tool cgroup.
- D4 The Fly guard verifies as the tool user at `setup_fly` (control + `/.fly/api` only, no
  cgroup yet); the full check runs again after the helper.
- D5 "Anything else listening" is checked generically: every listening stream/seqpacket unix
  socket in `/proc/net/unix` (read by root, path or abstract) must be unconnectable by the tool
  user. This is what covers "Fly's API socket lives elsewhere". Consequence: any
  world-connectable unix socket in the machine stops every job (fail closed, by design).
- D6 Positive control: a root listener on `127.0.0.1:<ephemeral>` (allowed by tool_out's
  `>= 1024` rule) must be reachable, or the answer is `control`. Port B itself is never touched
  (an empty connection would put a refused line in the proxy log of every job).
- D7 6PN coverage is a sample: `[fdaa::3]:{80,443,4280}` and the machine's own `fdaa::/16`
  addresses on 1-1023 and 4280; resolvers over TCP and a UDP DNS query. The nft ruleset remains
  the structural guarantee; documented as such.
- D8 Timings: 300 ms per attempt, 64 workers, 10 s probe budget (cut-off → `probe`), 20 s
  launch-to-answer (`layout.ProbeTimeout`; named so gofmt doesn't realign `Default`).

**Open questions / for the user:**
- Whether `_api.internal` (the Machines API over 6PN) resolves to `fdaa::3` or another address is
  unknown here; the sample covers `[fdaa::3]:4280` and the firewall refuses all of `fdaa::/16`
  for the tool user anyway. Confirm on staging (runbook step 3).
- Fly may run other listeners in the guest (e.g. `hallpass` on the 6PN address port 22, TCP: the
  firewall covers it). If Fly exposes any world-connectable unix socket, jobs will stop at
  `isolation` `unix_socket` until handled; the runbook asks to record what step 3 lists.
- The image e2e (`packages/kete-job-image/scripts/e2e.sh`, real `kete`) was not run (disk and
  time); the check runs there too and should pass (Docker containers have no stray unix
  listeners). Run it before the next image release.
- On commit, bump the card's `verified-at` to the commit that lands this (set to `cfe7d2f204`
  now, the base).

## 2026-10-03 builder — reviewer round

Reviewer verdict: approve, 9 minors. Fixed:
1. `isolation.Run` now stops on ctx cancellation (SIGKILLs the probe, interrupts the read).
2. Unix `EAGAIN` counts as reached (permission is checked before the backlog); resource errors
   (`EMFILE`, `ENFILE`, `ENOBUFS`, `ENOMEM`) are `ErrInconclusive` → `probe`. Other errors still
   pass (a strict allowlist of refusal errnos was rejected: unknown-but-harmless errnos such as
   `EADDRNOTAVAIL` on a v6-less machine would stop every job).
3. Positive controls for every probe kind that has one: TCP, an abstract unix listener, opening
   `/` (`isolation.Controls`); DNS has none (documented).
4. An interface address that doesn't parse fails the check instead of being skipped.
5. `/proc/net/unix` over 16 MiB is an error, never treated as complete.
8. README: the probe's environment is `PATH` only; the Fly guard's probe runs in the entrypoint's
   cgroup.
Documented, not changed: 6 (the check is a snapshot; kete's dirs exist at check time, created by
`setup_dirs`) and 9 (the firewall is applied once before claim; post-claim restarts change only
the proxy's allowlists, not the tool user's nft rules). 7 needed no change.
Found while fixing: a world-connectable control listener left open is (rightly) caught by the
sweep, so `CheckIsolation` reads `/proc/net/unix` before opening its controls (card gotcha).
All checks re-run green afterwards (unit, full integration 22/22, lint, upstream:check, card-check).
