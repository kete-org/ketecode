import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import * as KetePermissionMode from "../../src/kete/permission-mode"

describe("permission mode flags", () => {
  test("--auto is the auto permission mode, not a bypass", () => {
    expect(KetePermissionMode.fromFlags({ auto: true, permissionMode: Option.none() })).toBe("auto")
    expect(KetePermissionMode.skipsPermissions({ yolo: false, dangerouslySkipPermissions: false })).toBe(false)
  })

  test("--permission-mode selects a mode; no flag keeps the session's own", () => {
    expect(KetePermissionMode.fromFlags({ auto: false, permissionMode: Option.some("plan") })).toBe("plan")
    expect(KetePermissionMode.fromFlags({ auto: false, permissionMode: Option.none() })).toBeUndefined()
    expect(KetePermissionMode.fromFlags({ auto: true, permissionMode: Option.some("auto") })).toBe("auto")
  })

  test("--auto with a different --permission-mode is an error, not a silent choice", () => {
    expect(() => KetePermissionMode.fromFlags({ auto: true, permissionMode: Option.some("ask") })).toThrow(
      KetePermissionMode.ConflictError,
    )
  })

  test("the explicit bypass is --dangerously-skip-permissions (or --yolo)", () => {
    expect(KetePermissionMode.skipsPermissions({ yolo: false, dangerouslySkipPermissions: true })).toBe(true)
    expect(KetePermissionMode.skipsPermissions({ yolo: true, dangerouslySkipPermissions: false })).toBe(true)
  })
})

describe("applying a mode to a session", () => {
  function fake(initial: Record<string, unknown> | undefined, keep = true) {
    let metadata = initial
    const updates: Array<Record<string, unknown>> = []
    const sessions = {
      get: async () => ({ id: "ses_1", metadata }) as never,
      update: async (input: { metadata?: Record<string, unknown> }) => {
        updates.push(input.metadata ?? {})
        if (keep) metadata = input.metadata
      },
    }
    return { sessions: sessions as never, updates }
  }

  test("merges the mode into the existing metadata", async () => {
    const { sessions, updates } = fake({ "kete.worktree": { id: "x" } })
    await KetePermissionMode.apply(sessions, "ses_1", "plan")
    expect(updates).toEqual([{ "kete.worktree": { id: "x" }, "kete.permissionMode": "plan" }])
  })

  test("doesn't write when the session already has the mode", async () => {
    const { sessions, updates } = fake({ "kete.permissionMode": "ask" })
    await KetePermissionMode.apply(sessions, "ses_1", "ask")
    expect(updates).toEqual([])
  })

  test("fails when the runtime didn't keep the mode", async () => {
    const { sessions } = fake({}, false)
    await expect(KetePermissionMode.apply(sessions, "ses_1", "auto")).rejects.toThrow("didn't keep")
  })
})
