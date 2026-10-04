// Pure tests for the unattended-run contract (kete/unattended-policy.ts) and its checks
// (kete/unattended.ts): decode, root resolution, `allows`, the required-limit/deadline/budget
// checks, and `limits`. Service-level hook behavior is in unattended-service.test.ts.
import { describe, expect, test } from "bun:test"
import { DateTime, Duration, Effect, FiberMap, Option } from "effect"
import { Agent } from "@opencode/schema/agent"
import { ConfigKete } from "@opencode/schema/config/kete"
import { Money } from "@opencode/schema/money"
import { AbsolutePath } from "@opencode/schema/schema"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { KeteUnattended } from "@opencode/core/kete/unattended"
import { KeteUnattendedPolicy } from "@opencode/core/kete/unattended-policy"
import type { SessionSchema } from "@opencode/core/session/schema"
import { it } from "../lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const info = (overrides: {
  readonly id: SessionSchema.ID
  readonly parentID?: SessionSchema.ID
  readonly metadata?: SessionSchema.Metadata
  readonly created?: number
  readonly cost?: number
}): SessionSchema.Info =>
  ({
    id: overrides.id,
    parentID: overrides.parentID,
    projectID: Project.ID.global,
    cost: Money.USD.make(overrides.cost ?? 0),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(overrides.created ?? 0), updated: DateTime.makeUnsafe(overrides.created ?? 0) },
    location,
    metadata: overrides.metadata,
  }) as SessionSchema.Info

/** A `Get` over a fixed map, like a store lookup would give. */
const mapGet = (sessions: ReadonlyArray<SessionSchema.Info>): KeteUnattendedPolicy.Get => {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  return (id) => Effect.succeed(Option.fromNullishOr(byID.get(id)))
}

const root = Session.ID.make("ses_root")
const child = Session.ID.make("ses_child")
const grandchild = Session.ID.make("ses_grandchild")

describe("KeteUnattendedPolicy.resolve", () => {
  test("no key anywhere in the resolvable chain: interactive", async () => {
    const get = mapGet([info({ id: root })])
    expect(await Effect.runPromise(KeteUnattendedPolicy.resolve(get, root))).toEqual({ kind: "interactive" })
  })

  test("a valid policy on the session itself", async () => {
    const policy = { version: 1 as const, budget: 5, timeout: 30, allow: [{ action: "shell", resource: "bun test*" }] }
    const get = mapGet([info({ id: root, metadata: { "kete.unattended": policy } })])
    const state = await Effect.runPromise(KeteUnattendedPolicy.resolve(get, root))
    expect(state).toMatchObject({ kind: "unattended", policy, root: { id: root } })
  })

  test("an excess property is rejected (strict decode)", async () => {
    const get = mapGet([info({ id: root, metadata: { "kete.unattended": { version: 1, extra: true } } })])
    const state = await Effect.runPromise(KeteUnattendedPolicy.resolve(get, root))
    expect(state.kind).toBe("unattended")
    expect(state).toMatchObject({ policy: KeteUnattendedPolicy.emptyPolicy })
    expect((state as KeteUnattendedPolicy.Unattended).invalid).toBeDefined()
  })

  test("an unknown version is rejected", async () => {
    const get = mapGet([info({ id: root, metadata: { "kete.unattended": { version: 2 } } })])
    const state = await Effect.runPromise(KeteUnattendedPolicy.resolve(get, root))
    expect(state.kind).toBe("unattended")
    expect((state as KeteUnattendedPolicy.Unattended).invalid).toBeDefined()
  })

  test("walks up to the root-most session carrying the key, for a subagent created before every session carried its own copy", async () => {
    const policy = { version: 1 as const, budget: 5, timeout: 30 }
    const get = mapGet([
      info({ id: root, metadata: { "kete.unattended": policy } }),
      info({ id: child, parentID: root, metadata: {} }),
      info({ id: grandchild, parentID: child }),
    ])
    const state = await Effect.runPromise(KeteUnattendedPolicy.resolve(get, grandchild))
    expect(state).toMatchObject({ kind: "unattended", policy, root: { id: root } })
  })

  test("a missing ancestor before any session carries the key: interactive, not unattended", async () => {
    // session_v2.parent_id has no FK; an ordinary interactive session can have a stale/missing
    // parent (e.g. restart.ts treating a missing parent as real). Neither session carries the key.
    const get = mapGet([info({ id: child, parentID: root })])
    expect(await Effect.runPromise(KeteUnattendedPolicy.resolve(get, child))).toEqual({ kind: "interactive" })
  })

  test("a missing ancestor after a session carries the key still fails closed, using that session's value", async () => {
    const policy = { version: 1 as const, budget: 5, timeout: 30 }
    // child carries the key itself; its own parent (root) is missing from the store.
    const get = mapGet([info({ id: grandchild, parentID: child }), info({ id: child, parentID: root, metadata: { "kete.unattended": policy } })])
    const state = await Effect.runPromise(KeteUnattendedPolicy.resolve(get, grandchild))
    expect(state).toMatchObject({ kind: "unattended", policy, root: { id: child } })
  })

  test("a chain deeper than 32 with no session in range carrying the key: interactive", async () => {
    const chain: SessionSchema.Info[] = []
    let parent: SessionSchema.ID | undefined
    for (let i = 0; i < 40; i++) {
      const id = Session.ID.make(`ses_chain_${i}`)
      chain.push(info({ id, parentID: parent }))
      parent = id
    }
    // The only flagged session (index 0) is unreachable within MAX_DEPTH hops from the deepest.
    chain[0] = info({ id: chain[0]!.id, metadata: { "kete.unattended": { version: 1 } } })
    const get = mapGet(chain)
    const deepest = chain.at(-1)!.id
    expect(await Effect.runPromise(KeteUnattendedPolicy.resolve(get, deepest))).toEqual({ kind: "interactive" })
  })

  test("a chain deeper than 32 still resolves when the query session itself carries the key", async () => {
    const chain: SessionSchema.Info[] = []
    let parent: SessionSchema.ID | undefined
    for (let i = 0; i < 40; i++) {
      const id = Session.ID.make(`ses_deep_${i}`)
      chain.push(info({ id, parentID: parent }))
      parent = id
    }
    const policy = { version: 1 as const }
    const deepest = chain.at(-1)!
    chain[chain.length - 1] = info({ id: deepest.id, parentID: deepest.parentID, metadata: { "kete.unattended": policy } })
    const get = mapGet(chain)
    expect(await Effect.runPromise(KeteUnattendedPolicy.resolve(get, deepest.id))).toMatchObject({
      kind: "unattended",
      policy,
      root: { id: deepest.id },
    })
  })
})

describe("KeteUnattendedPolicy.allows", () => {
  const policy = { version: 1 as const, allow: [{ action: "shell", resource: "bun test*" }] }

  test("matches every resource against the policy's allow rules", () => {
    expect(KeteUnattendedPolicy.allows(policy, "shell", ["bun test src"])).toBe(true)
    expect(KeteUnattendedPolicy.allows(policy, "shell", ["bun test src", "rm -rf /"])).toBe(false)
    expect(KeteUnattendedPolicy.allows(policy, "edit", ["src/a.ts"])).toBe(false)
  })

  test("never allows question or budget, even with a matching wildcard rule", () => {
    const wide = { version: 1 as const, allow: [{ action: "*", resource: "*" }] }
    expect(KeteUnattendedPolicy.allows(wide, "question", ["anything"])).toBe(false)
    expect(KeteUnattendedPolicy.allows(wide, "budget", ["anything"])).toBe(false)
    expect(KeteUnattendedPolicy.allows(wide, "shell", ["anything"])).toBe(true)
  })

  test("an empty policy allows nothing", () => {
    expect(KeteUnattendedPolicy.allows(KeteUnattendedPolicy.emptyPolicy, "shell", ["ls"])).toBe(false)
  })
})

describe("KeteUnattendedPolicy.configTarget", () => {
  const options = { globalConfig: "/home/user/.config/kete" }

  test("a relative .kete/ path segment, anywhere in the tree", () => {
    expect(KeteUnattendedPolicy.configTarget("edit", [".kete/x"], options)).toBe(true)
    expect(KeteUnattendedPolicy.configTarget("edit", ["a/.KETE/x"], options)).toBe(true)
    expect(KeteUnattendedPolicy.configTarget("edit", ["../.kete/x"], options)).toBe(true)
  })

  test("a kete.json / kete.jsonc filename, anywhere in the tree", () => {
    expect(KeteUnattendedPolicy.configTarget("edit", ["kete.jsonc"], options)).toBe(true)
    expect(KeteUnattendedPolicy.configTarget("edit", ["sub/kete.json"], options)).toBe(true)
  })

  test("an absolute path inside the global config directory", () => {
    expect(KeteUnattendedPolicy.configTarget("edit", ["/home/user/.config/kete/kete.jsonc"], options)).toBe(true)
    expect(KeteUnattendedPolicy.configTarget("edit", ["/home/user/.config/kete"], options)).toBe(true)
  })

  test("Windows-style backslashes are recognized the same way", () => {
    expect(KeteUnattendedPolicy.configTarget("edit", ["a\\.kete\\x"], options)).toBe(true)
    expect(
      KeteUnattendedPolicy.configTarget("edit", ["C:\\Users\\user\\.config\\kete\\kete.jsonc"], {
        globalConfig: "C:\\Users\\user\\.config\\kete",
      }),
    ).toBe(true)
  })

  test("an ordinary project file is untouched", () => {
    expect(KeteUnattendedPolicy.configTarget("edit", ["src/app.ts"], options)).toBe(false)
  })

  test("a shell command that mentions Kete configuration matches too (best-effort)", () => {
    expect(KeteUnattendedPolicy.configTarget("shell", ["echo x > .kete/kete.json"], options)).toBe(true)
    expect(KeteUnattendedPolicy.configTarget("shell", ["ls src"], options)).toBe(false)
  })

  test("actions other than edit/shell never match", () => {
    expect(KeteUnattendedPolicy.configTarget("question", [".kete/kete.json"], options)).toBe(false)
  })
})

describe("KeteUnattendedPolicy.guardMetadata / guardPermissions", () => {
  test("leaves other keys alone when kete.unattended is absent throughout", async () => {
    await Effect.runPromise(KeteUnattendedPolicy.guardMetadata({ other: 1 }, { other: 2 }))
  })

  test("refuses adding kete.unattended after creation", async () => {
    const exit = await Effect.runPromiseExit(
      KeteUnattendedPolicy.guardMetadata(undefined, { "kete.unattended": { version: 1 } }),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("refuses changing or dropping kete.unattended", async () => {
    const current = { "kete.unattended": { version: 1, budget: 5 } }
    expect((await Effect.runPromiseExit(KeteUnattendedPolicy.guardMetadata(current, {})))._tag).toBe("Failure")
    expect(
      (
        await Effect.runPromiseExit(
          KeteUnattendedPolicy.guardMetadata(current, { "kete.unattended": { version: 1, budget: 10 } }),
        )
      )._tag,
    ).toBe("Failure")
  })

  test("allows an identical resubmission", async () => {
    const current = { "kete.unattended": { version: 1, budget: 5 } }
    await Effect.runPromise(KeteUnattendedPolicy.guardMetadata(current, { ...current }))
  })

  test("guardPermissions refuses only in an unattended family", async () => {
    const unattendedGet = mapGet([info({ id: root, metadata: { "kete.unattended": { version: 1 } } })])
    expect((await Effect.runPromiseExit(KeteUnattendedPolicy.guardPermissions(unattendedGet, root)))._tag).toBe(
      "Failure",
    )
    const interactiveGet = mapGet([info({ id: root })])
    await Effect.runPromise(KeteUnattendedPolicy.guardPermissions(interactiveGet, root))
  })
})

const kete = (fields: { readonly budget?: number; readonly timeout?: number }) =>
  new ConfigKete.Info({
    budget: fields.budget === undefined ? undefined : new ConfigKete.Budget({ session: fields.budget }),
    subagents: fields.timeout === undefined ? undefined : new ConfigKete.Subagents({ timeout: fields.timeout }),
  })

describe("KeteUnattended.limits", () => {
  test("the stricter of the policy's and kete.budget.session's budgets", () => {
    expect(KeteUnattended.limits({ version: 1, budget: 5 }, kete({ budget: 10 })).budget).toBe(5)
    expect(KeteUnattended.limits({ version: 1, budget: 20 }, kete({ budget: 10 })).budget).toBe(10)
    expect(KeteUnattended.limits({ version: 1 }, kete({ budget: 10 })).budget).toBe(10)
    expect(KeteUnattended.limits({ version: 1 }, undefined).budget).toBeUndefined()
  })

  test("the policy's timeout, else an explicit kete.subagents.timeout (0 or default don't count)", () => {
    expect(KeteUnattended.limits({ version: 1, timeout: 15 }, kete({ timeout: 60 })).timeout).toEqual(
      Duration.minutes(15),
    )
    expect(KeteUnattended.limits({ version: 1 }, kete({ timeout: 45 })).timeout).toEqual(Duration.minutes(45))
    expect(KeteUnattended.limits({ version: 1 }, kete({ timeout: 0 })).timeout).toBeUndefined()
    expect(KeteUnattended.limits({ version: 1 }, undefined).timeout).toBeUndefined()
  })

  test("reports what's missing", () => {
    expect(KeteUnattended.limits({ version: 1 }, undefined).missing).toEqual(["budget", "time limit"])
    expect(KeteUnattended.limits({ version: 1, budget: 5 }, undefined).missing).toEqual(["time limit"])
    expect(KeteUnattended.limits({ version: 1, budget: 5, timeout: 10 }, undefined).missing).toEqual([])
  })
})

const agent = Agent.ID.make("test")
const lookupFor = (
  sessions: ReadonlyArray<SessionSchema.Info>,
  options: { readonly kete?: ConfigKete.Info; readonly now?: number } = {},
): KeteUnattended.Lookup => ({
  session: mapGet(sessions),
  children: (parentID) => Effect.succeed(sessions.filter((session) => session.parentID === parentID)),
  config: Effect.succeed(options.kete),
  now: Effect.succeed(options.now ?? 0),
})

describe("KeteUnattended.check", () => {
  test("refuses without a budget or a time limit, naming what's missing", async () => {
    const lookup = lookupFor([info({ id: root, metadata: { "kete.unattended": { version: 1 } } })])
    const error = await Effect.runPromise(
      KeteUnattended.check(lookup, { sessionID: root, agent }).pipe(Effect.flip),
    )
    expect(error.error).toMatchObject({ type: "unattended" })
    expect(error.message).toContain("no spending budget and no time limit")
  })

  test("stops once the deadline passes", async () => {
    const policy = { version: 1, budget: 100, timeout: 10 }
    const lookup = lookupFor([info({ id: root, metadata: { "kete.unattended": policy }, created: 0 })], {
      now: Duration.toMillis(Duration.minutes(10)),
    })
    const error = await Effect.runPromise(
      KeteUnattended.check(lookup, { sessionID: root, agent }).pipe(Effect.flip),
    )
    expect(error.message).toContain("10-minute time limit")
  })

  test("stops once the family's cost reaches the budget", async () => {
    const policy = { version: 1, budget: 5, timeout: 60 }
    const lookup = lookupFor([
      info({ id: root, metadata: { "kete.unattended": policy }, cost: 3 }),
      info({ id: child, parentID: root, cost: 2.5 }),
    ])
    const error = await Effect.runPromise(
      KeteUnattended.check(lookup, { sessionID: root, agent }).pipe(Effect.flip),
    )
    expect(error.message).toContain("reached its $5.00 budget (spent $5.50)")
  })

  test("passes when under both limits", async () => {
    const policy = { version: 1, budget: 5, timeout: 60 }
    const lookup = lookupFor([info({ id: root, metadata: { "kete.unattended": policy }, cost: 1 })])
    await Effect.runPromise(KeteUnattended.check(lookup, { sessionID: root, agent }))
  })

  test("a missing ancestor with no session carrying the key: not unattended, check does nothing", async () => {
    const lookup = lookupFor([info({ id: child, parentID: root })])
    await Effect.runPromise(KeteUnattended.check(lookup, { sessionID: child, agent }))
  })
})

describe("KeteUnattended.watch", () => {
  it.live("interrupts a running session once it passes the run's time limit", () =>
    Effect.gen(function* () {
      // 0.01 minutes is 600ms.
      const policy = { version: 1 as const, budget: 100, timeout: 0.01 }
      const get = mapGet([info({ id: root, metadata: { "kete.unattended": policy }, created: Date.now() })])
      const interrupted: SessionSchema.ID[] = []
      const lookup: KeteUnattended.TimerLookup = {
        session: get,
        config: Effect.succeed(undefined),
        interrupt: (sessionID) =>
          Effect.sync(() => {
            interrupted.push(sessionID)
          }),
      }
      const timers = yield* FiberMap.make<SessionSchema.ID, void>()
      yield* KeteUnattended.watch(lookup, timers, root)
      expect(interrupted).toEqual([])
      yield* Effect.sleep(Duration.seconds(1))
      expect(interrupted).toEqual([root])
    }),
  )

  it.live("does nothing for an interactive session, or without a time limit", () =>
    Effect.gen(function* () {
      const get = mapGet([info({ id: root, created: Date.now() })])
      const interrupted: SessionSchema.ID[] = []
      const lookup: KeteUnattended.TimerLookup = {
        session: get,
        config: Effect.succeed(undefined),
        interrupt: (sessionID) =>
          Effect.sync(() => {
            interrupted.push(sessionID)
          }),
      }
      const timers = yield* FiberMap.make<SessionSchema.ID, void>()
      yield* KeteUnattended.watch(lookup, timers, root)
      yield* Effect.sleep(Duration.millis(50))
      expect(interrupted).toEqual([])
    }),
  )
})
