import { describe, expect, test } from "bun:test"
import { apply, derive, KeteModeDraft, next, withMode } from "./mode"

describe("derive", () => {
  test("the plan agent always shows Plan", () => {
    expect(derive({ agent: "plan", metadata: { "kete.permissionMode": "ask" } })).toBe("plan")
  })
  test("otherwise reads the session's permission mode", () => {
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "ask" } })).toBe("ask")
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "default" } })).toBe("auto")
  })
  test("falls back when there is no metadata yet", () => {
    expect(derive({ agent: "build" })).toBe("auto")
    expect(derive({ agent: "build", fallback: "ask" })).toBe("ask")
  })
  test("an unrecognised metadata value falls back too", () => {
    expect(derive({ agent: "build", metadata: { "kete.permissionMode": "bogus" } })).toBe("auto")
  })
})

describe("next", () => {
  test("cycles Auto -> Ask -> Plan -> Auto", () => {
    expect(next("auto", true)).toBe("ask")
    expect(next("ask", true)).toBe("plan")
    expect(next("plan", true)).toBe("auto")
  })
  test("skips Plan when the plan agent isn't available", () => {
    expect(next("ask", false)).toBe("auto")
    expect(next("auto", false)).toBe("ask")
  })
})

describe("withMode", () => {
  test("writes only the permission-mode key, keeping the rest of the metadata", () => {
    expect(withMode({ other: "x" }, "ask")).toEqual({ other: "x", "kete.permissionMode": "ask" })
    expect(withMode(undefined, "auto")).toEqual({ "kete.permissionMode": "default" })
  })
  test("writes only default/ask, never anything else", () => {
    const metadata = withMode(undefined, "ask")
    expect(Object.values(metadata)).toEqual(["ask"])
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
  test("Plan carries no metadata (it's an agent choice, applied separately)", () => {
    KeteModeDraft.set("draft-b", "plan")
    expect(KeteModeDraft.metadata("draft-b")).toBeUndefined()
    KeteModeDraft.clear("draft-b")
  })
  test("Auto carries metadata too, so a draft's explicit choice always reaches the new session", () => {
    KeteModeDraft.set("draft-c", "auto")
    expect(KeteModeDraft.metadata("draft-c")).toEqual({ "kete.permissionMode": "default" })
    KeteModeDraft.clear("draft-c")
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

  test("Plan selects the plan agent without touching metadata", async () => {
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
    expect(calls).toEqual([])
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
    await apply({ sdk, sessionID: "ses_3", mode: "auto", agent })
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
})
