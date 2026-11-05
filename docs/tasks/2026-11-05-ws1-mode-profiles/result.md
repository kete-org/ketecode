# Result: WS1 mode profiles

## What changed
- `packages/schema/src/kete/modes.ts` (new): `KeteModesRpc` — `Id`, `Shell`, `Profile`, `Summary`, the `kete.modes` RPC (`list`).
- `packages/core/src/kete/modes.ts` (new): `KeteModes` loader — embeds `modes/*.jsonc` (Bun `.jsonc` import), decodes strictly (`onExcessProperty: "error"`, id must match the file), `list`/`get`/`summaries`/`available`.
- `packages/core/src/kete/modes/code.jsonc`, `work.jsonc`: every field filled in; Work `available: false` until 1.3.
- `packages/core/src/kete/handshake.ts`: handshake `modes` from `KeteModes.available()`; the same plugin registers `kete.modes`.
- Tests: `schema/test/kete/modes.test.ts` (new), `core/test/kete/modes.test.ts` (rewritten), `server/test/kete/handshake.test.ts` (`kete.modes/list`).
- Docs: `docs/desktop-enhancement-plan.md` (RPC instead of `GET /api/kete/modes`), `docs/upstream-patches.md`.
- No upstream file changed (plan change from the spec: no `internal.ts` edit).

## Checks
The implementer had no shell; the main session ran every check.

| Check | Result |
|---|---|
| schema `bun run typecheck`, `bun run test` | clean; 98 pass (after fixing the wrong-id assertion to match the field path) |
| core `bun run typecheck`, `bun run test ./test/kete` | clean; 1725 pass / 12 skip / 0 fail |
| server `bun run test ./test/kete` | 50 pass / 1 skip / 0 fail |
| `bun run lint`, `upstream:check` | exit 0; pass |
| AC4 binary | built `cli-darwin-arm64`; `kete.modes/list` returned code (available) and work (unavailable); handshake `modes: ["code"]` |
| Review | reviewer: approve; minors were the card notes (done at close) and an untested id-mismatch branch (not added: the loader reads embedded files only) |

## Acceptance criteria
- [x] AC1 — schema tests: shipped profiles decode; unknown key (top level and in `shell`), wrong id and missing field rejected, each naming the field.
- [x] AC2 — core `modes.test.ts`: order, Work unavailable, code agent `build`, Work network/git/Windows shell.
- [x] AC3 — server test: both modes with `available` flags; handshake `["code"]`.
- [x] AC4 — built binary answered (above).
- [x] AC5 — checks above.

## Cards updated
config-kete, server-sdk, permissions (refreshed before planning, then the profile/RPC notes); gaps added: how files are embedded in the binary, the strict-decode pattern.

## Metrics
- Agents used: librarian ×3, planner ×2 (first stopped on stale cards), implementer (no shell), reviewer
- Scout lookups: 0, docs enough: – (–)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-05)
