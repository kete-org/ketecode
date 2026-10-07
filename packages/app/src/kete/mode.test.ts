import { describe, expect, test } from "bun:test"
import { apply, derive, KeteModeDraft, next, withMode } from "./mode"

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
