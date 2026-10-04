import { describe, expect } from "bun:test"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { Permission } from "@opencode/schema/permission"
import { Effect } from "effect"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const setup = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* KetePermissionMode.Plugin.effect(host)
})

const session = Effect.fn(function* (mode?: string) {
  const sessions = yield* Session.Service
  const location = yield* Location.Service
  return yield* sessions.create({
    location: Location.Ref.make({ directory: location.directory }),
    metadata: mode === undefined ? undefined : { [KetePermissionMode.metadataKey]: mode },
  })
})

const evaluate = Effect.fn(function* (sessionID: Session.ID, action: string, effect: Permission.Effect = "allow") {
  const hooks = yield* PluginHooks.Service
  const event = yield* hooks.trigger("permission", "evaluate", { sessionID, action, resources: ["*"], effect })
  return event.effect
})

describe("KetePermissionMode", () => {
  it.effect("asks before edits, shell commands and web fetches in ask mode", () =>
    withEnv({ KETE_PERMISSION_MODE: undefined }, () =>
      Effect.gen(function* () {
        yield* setup()
        const asking = yield* session("ask")
        expect(yield* evaluate(asking.id, "edit")).toBe("ask")
        expect(yield* evaluate(asking.id, "shell")).toBe("ask")
        expect(yield* evaluate(asking.id, "webfetch")).toBe("ask")
        // Reading and other actions are untouched.
        expect(yield* evaluate(asking.id, "read")).toBe("allow")
        expect(yield* evaluate(asking.id, "question")).toBe("allow")
      }),
    ),
  )

  it.effect("never loosens: deny and ask stay as they are", () =>
    withEnv({ KETE_PERMISSION_MODE: undefined }, () =>
      Effect.gen(function* () {
        yield* setup()
        const asking = yield* session("ask")
        const normal = yield* session()
        expect(yield* evaluate(asking.id, "edit", "deny")).toBe("deny")
        expect(yield* evaluate(normal.id, "edit", "deny")).toBe("deny")
        expect(yield* evaluate(normal.id, "shell", "ask")).toBe("ask")
      }),
    ),
  )

  it.effect("leaves sessions without a mode (or in default mode) alone", () =>
    withEnv({ KETE_PERMISSION_MODE: undefined }, () =>
      Effect.gen(function* () {
        yield* setup()
        expect(yield* evaluate((yield* session()).id, "edit")).toBe("allow")
        expect(yield* evaluate((yield* session("default")).id, "edit")).toBe("allow")
        // An unknown value is not a mode.
        expect(yield* evaluate((yield* session("yolo")).id, "edit")).toBe("allow")
      }),
    ),
  )

  it.effect("uses KETE_PERMISSION_MODE for sessions without a mode; a session's own mode wins", () =>
    withEnv({ KETE_PERMISSION_MODE: "ask" }, () =>
      Effect.gen(function* () {
        yield* setup()
        expect(yield* evaluate((yield* session()).id, "edit")).toBe("ask")
        expect(yield* evaluate((yield* session("default")).id, "edit")).toBe("allow")
      }),
    ),
  )

  it.effect("subagent sessions inherit the parent's mode", () =>
    withEnv({ KETE_PERMISSION_MODE: undefined }, () =>
      Effect.gen(function* () {
        yield* setup()
        const parent = yield* session("ask")
        const sessions = yield* Session.Service
        const child = yield* sessions.create({ parentID: parent.id })
        expect(yield* evaluate(child.id, "edit")).toBe("ask")
      }),
    ),
  )

  it.effect("an unknown session is left alone", () =>
    withEnv({ KETE_PERMISSION_MODE: undefined }, () =>
      Effect.gen(function* () {
        yield* setup()
        expect(yield* evaluate(Session.ID.make("ses_missing"), "edit")).toBe("allow")
      }),
    ),
  )
})
