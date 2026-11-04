import { describe, expect, test } from "bun:test"
import { agentSwitchVisible, apply, derive, KeteModeDraft, next, switchTarget, withMode } from "./mode"

describe("derive", () => {
  test("the plan agent always shows Plan", () => {
    expect(derive({ agent: "plan", metadata: { "kete.permissionMode": "ask" } })).toBe("plan")
  })
  test("otherwise reads the session's permission mode", () => {
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "ask" } })).toBe("ask")
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "default" } })).toBe("default")
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "auto" } })).toBe("auto")
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "plan" } })).toBe("plan")
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "accept-edits" } })).toBe("accept-edits")
  })
  test("falls back when there is no metadata yet", () => {
    expect(derive({ agent: "build" })).toBe("default")
    expect(derive({ agent: "build", fallback: "ask" })).toBe("ask")
  })
  test("an unrecognised metadata value falls back too", () => {
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "bogus" } })).toBe("default")
  })
})

describe("next", () => {
  test("cycles Default -> Auto -> Ask -> Plan -> Default", () => {
    expect(next("default")).toBe("auto")
    expect(next("auto")).toBe("ask")
    expect(next("ask")).toBe("plan")
    expect(next("plan")).toBe("default")
    expect(next("ask", { plan: true })).toBe("plan")
  })
  test("without Plan cycles Default -> Auto -> Ask -> Default", () => {
    expect(next("default", { plan: false })).toBe("auto")
    expect(next("auto", { plan: false })).toBe("ask")
    expect(next("ask", { plan: false })).toBe("default")
  })
  test("without Plan, a session already in Plan moves to Default", () => {
    expect(next("plan", { plan: false })).toBe("default")
  })
})

describe("switchTarget", () => {
  test("Plan from another mode selects Plan and remembers that mode", () => {
    expect(switchTarget({ choice: "plan", current: "ask", before: "default" })).toEqual({ mode: "plan", before: "ask" })
  })
  test("Build from Plan returns to the remembered mode", () => {
    expect(switchTarget({ choice: "build", current: "plan", before: "auto" })).toEqual({ mode: "auto", before: "auto" })
  })
  test("choosing the side already selected does nothing", () => {
    expect(switchTarget({ choice: "plan", current: "plan", before: "default" })).toBeUndefined()
    expect(switchTarget({ choice: "build", current: "ask", before: "default" })).toBeUndefined()
  })
})

describe("agentSwitchVisible", () => {
  test("needs the desktop/web app and a plan agent", () => {
    expect(agentSwitchVisible({ browser: true, planAvailable: true })).toBe(true)
    expect(agentSwitchVisible({ browser: true, planAvailable: false })).toBe(false)
    expect(agentSwitchVisible({ browser: false, planAvailable: true })).toBe(false)
  })
})

describe("withMode", () => {
  test("writes only the permission-mode key, keeping the rest of the metadata", () => {
    expect(withMode({ other: "x" }, "ask")).toEqual({ other: "x", "kete.permissionMode": "ask" })
    expect(withMode(undefined, "auto")).toEqual({ "kete.permissionMode": "auto" })
    expect(withMode(undefined, "plan")).toEqual({ "kete.permissionMode": "plan" })
  })
})

describe("KeteModeDraft", () => {
  test("undefined until a mode is set, and after it's cleared", () => {
    expect(KeteModeDraft.metadata("draft-a")).toBeUndefined()
    KeteModeDraft.set("draft-a", "ask")
    expect(KeteModeDraft.metadata("draft-a")).toEqual({ "kete.permissionMode": "ask" })
    KeteModeDraft.clear("draft-a")
    expect(KeteModeDraft.metadata("draft-a")).toBeUndefined()
  })
  test("Plan carries metadata too: the mode is what makes it read-only", () => {
    KeteModeDraft.set("draft-b", "plan")
    expect(KeteModeDraft.metadata("draft-b")).toEqual({ "kete.permissionMode": "plan" })
    KeteModeDraft.clear("draft-b")
  })
})

describe("apply", () => {
  function agentStub(initial: string) {
    let current = initial
    return {
      current: () => current,
      options: () => ["build", "plan"],
      select: (name: string) => {
        current = name
      },
    }
  }

  test("Auto/Ask GET-merge-PATCH the session's metadata, keeping other keys", async () => {
    const calls: unknown[] = []
    const sdk = {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          calls.push(["get", sessionID])
          return { metadata: { other: "kept" } }
        },
        update: async (input: { sessionID: string; metadata: Record<string, unknown> }) => {
          calls.push(["update", input])
        },
      },
    }
    const agent = agentStub("build")
    await apply({ sdk, sessionID: "ses_1", mode: "ask", agent })
    expect(calls).toEqual([
      ["get", "ses_1"],
      ["update", { sessionID: "ses_1", metadata: { other: "kept", "kete.permissionMode": "ask" } }],
    ])
    expect(agent.current()).toBe("build")
  })

  test("Plan writes the plan mode and selects the plan agent", async () => {
    const calls: unknown[] = []
    const sdk = {
      session: {
        get: async () => {
          calls.push("get")
          return { metadata: {} }
        },
        update: async (input: unknown) => {
          calls.push(["update", input])
        },
      },
    }
    const agent = agentStub("build")
    await apply({ sdk, sessionID: "ses_2", mode: "plan", agent })
    expect(calls).toEqual(["get", ["update", { sessionID: "ses_2", metadata: { "kete.permissionMode": "plan" } }]])
    expect(agent.current()).toBe("plan")
  })

  test("leaving Plan restores the agent it replaced", async () => {
    const sdk = {
      session: {
        get: async () => ({ metadata: {} }),
        update: async () => {},
      },
    }
    const agent = agentStub("review")
    await apply({ sdk, sessionID: "ses_3", mode: "plan", agent })
    expect(agent.current()).toBe("plan")
    await apply({ sdk, sessionID: "ses_3", mode: "default", agent })
    expect(agent.current()).toBe("review")
  })

  test("leaving Plan with nothing remembered restores the first non-Plan agent offered", async () => {
    const sdk = {
      session: {
        get: async () => ({ metadata: {} }),
        update: async () => {},
      },
    }
    const agent = agentStub("plan")
    await apply({ sdk, sessionID: "ses_4", mode: "auto", agent })
    expect(agent.current()).toBe("build")
  })

  test("Plan without a plan agent on offer is the permission mode only", async () => {
    const sdk = {
      session: {
        get: async () => ({ metadata: {} }),
        update: async () => {},
      },
    }
    const agent = { current: () => "build", options: () => ["build"], select: () => {} }
    await apply({ sdk, sessionID: "ses_5", mode: "plan", agent })
    expect(agent.current()).toBe("build")
  })
})
