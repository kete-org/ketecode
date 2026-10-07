import { describe, expect, test } from "bun:test"
import { KetePermissionModes } from "@opencode/util/kete/permission-mode"
import { applyMode, modeOf, statusText } from "../../src/kete/permission-mode"

describe("TUI permission mode", () => {
  test("reads the mode from session metadata", () => {
    expect(modeOf({ "kete.permissionMode": "plan" })).toBe("plan")
    expect(modeOf({ "kete.permissionMode": "yolo" })).toBeUndefined()
    expect(modeOf(undefined)).toBeUndefined()
  })

  test("the status row shows every mode but Default", () => {
    expect(statusText(undefined)).toBeUndefined()
    expect(statusText("default")).toBeUndefined()
    expect(statusText("auto")).toBe("auto")
    expect(statusText("accept-edits")).toBe("accept edits")
    expect(statusText("plan")).toBe("plan")
  })

  test("cycles Default, Auto, Ask, Plan", () => {
    expect(KetePermissionModes.next("default")).toBe("auto")
    expect(KetePermissionModes.next("auto")).toBe("ask")
    expect(KetePermissionModes.next("ask")).toBe("plan")
    expect(KetePermissionModes.next("plan")).toBe("default")
    expect(KetePermissionModes.next("accept-edits")).toBe("default")
  })

  test("applying a mode keeps the session's other metadata", async () => {
    let metadata: Record<string, unknown> | undefined = { other: 1 }
    const updates: unknown[] = []
    const api = {
      get: async () => ({ metadata }),
      update: async (input: { metadata?: Record<string, unknown> }) => {
        updates.push(input.metadata)
        metadata = input.metadata
      },
    }
    await applyMode(api as never, "ses_1", "ask")
    await applyMode(api as never, "ses_1", "ask")
    expect(updates).toEqual([{ other: 1, "kete.permissionMode": "ask" }])
  })
})
