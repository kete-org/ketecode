// Migrating a v1 `tui.json` copies only the keybinds the user wrote, never v1's defaults. So a migrated
// config doesn't pin rename to v1's `ctrl+r` default, and Ctrl+R stays prompt history search
// (docs/history-search.md); only an explicit v1 `session_rename` keeps Ctrl+R on rename.
import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Info, resolve } from "@opencode/tui/config"
import { TuiConfigV1 } from "@opencode/tui/config/v1"
import { migrateV1 } from "../../src/config/migrate"

const decodeV1 = Schema.decodeUnknownSync(TuiConfigV1.Info)
const decodeInfo = Schema.decodeUnknownSync(Info)
const keys = (info: ReturnType<typeof migrateV1>, command: string) =>
  resolve(decodeInfo(info), { terminalSuspend: true })
    .keybinds.get(command)
    .map((binding) => binding.key)

test("a v1 config without session_rename leaves Ctrl+R to history search", () => {
  const migrated = migrateV1(decodeV1({ keybinds: { session_list: "<leader>s" } }), {})
  expect(migrated.keybinds).toEqual({ "session.list": "<leader>s" })
  expect(keys(migrated, "prompt.history.search")).toEqual(["ctrl+r"])
  expect(keys(migrated, "session.rename")).toEqual(["<leader>shift+r"])
})

test("a v1 config that set session_rename keeps it, and history search gives up the same key", () => {
  const migrated = migrateV1(decodeV1({ keybinds: { session_rename: "ctrl+r" } }), {})
  expect(migrated.keybinds).toEqual({ "session.rename": "ctrl+r" })
  expect(keys(migrated, "session.rename")).toEqual(["ctrl+r"])
  expect(keys(migrated, "prompt.history.search")).toEqual([])
})
