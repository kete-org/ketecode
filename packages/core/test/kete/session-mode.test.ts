// KeteSessionMode's pure guards (WS1 1.2). Work is unavailable until 1.3, so tests that need it inject
// an available profile.
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { KeteModes } from "@opencode/core/kete/modes"
import { KeteSessionMode } from "@opencode/core/kete/session-mode"

const key = "kete.sessionMode"
const lookup = (id: "code" | "work") => ({ ...KeteModes.get(id), available: true })

const defect = <A>(effect: Effect.Effect<A>) =>
  Effect.runSync(
    effect.pipe(
      Effect.exit,
      Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
    ),
  )
const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect)

describe("KeteSessionMode.guardCreate", () => {
  test("accepts no metadata and a code mode", () => {
    expect(run(KeteSessionMode.guardCreate(undefined, undefined))).toBeUndefined()
    expect(run(KeteSessionMode.guardCreate(undefined, { [key]: "code" }))).toEqual({ [key]: "code" })
  })

  test("refuses an unknown mode, naming it", () => {
    for (const value of ["chat", 42]) {
      const error = defect(KeteSessionMode.guardCreate(undefined, { [key]: value }))
      expect(error).toBeInstanceOf(KeteSessionMode.RefusedError)
      expect((error as Error).message).toContain(JSON.stringify(value))
    }
  })

  test("refuses work while its profile is unavailable", () => {
    const error = defect(KeteSessionMode.guardCreate(undefined, { [key]: "work" }))
    expect(error).toBeInstanceOf(KeteSessionMode.RefusedError)
    expect((error as Error).message).toContain("work")
  })

  test("accepts work once its profile is available", () => {
    expect(run(KeteSessionMode.guardCreate(undefined, { [key]: "work" }, lookup))).toEqual({ [key]: "work" })
  })

  test("a child that supplies its own metadata gets a work parent's mode", () => {
    expect(run(KeteSessionMode.guardCreate({ [key]: "work" }, {}, lookup))).toEqual({ [key]: "work" })
  })

  test("a child can't leave its parent's mode", () => {
    expect(defect(KeteSessionMode.guardCreate({ [key]: "work" }, { [key]: "code" }, lookup))).toBeInstanceOf(
      KeteSessionMode.RefusedError,
    )
    expect(defect(KeteSessionMode.guardCreate({}, { [key]: "work" }, lookup))).toBeInstanceOf(
      KeteSessionMode.RefusedError,
    )
  })
})

describe("KeteSessionMode.guardMetadata", () => {
  test("refuses adding, changing and removing the key", () => {
    for (const [current, next] of [
      [{}, { [key]: "code" }],
      [{ [key]: "code" }, { [key]: "work" }],
      [{ [key]: "code" }, {}],
    ] as const) {
      expect(defect(KeteSessionMode.guardMetadata(current, next))).toBeInstanceOf(KeteSessionMode.LockedError)
    }
  })

  test("allows other changes when the key is equal or absent", () => {
    expect(defect(KeteSessionMode.guardMetadata({ [key]: "code", a: 1 }, { [key]: "code", a: 2 }))).toBeUndefined()
    expect(defect(KeteSessionMode.guardMetadata(undefined, { a: 1 }))).toBeUndefined()
  })
})

describe("KeteSessionMode.agent", () => {
  test("code and unset have no agent of their own", () => {
    expect(KeteSessionMode.agent(undefined)).toBeUndefined()
    expect(KeteSessionMode.agent({ [key]: "code" })).toBeUndefined()
  })

  test("work uses its profile's agent", () => {
    expect(String(KeteSessionMode.agent({ [key]: "work" }, lookup))).toBe(KeteModes.get("work").agent)
  })
})
