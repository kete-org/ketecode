import { expect, test } from "bun:test"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import type { SidecarCredentials } from "../service/sidecar-credentials"
import { make, singleFlight, type Event } from "./sidecar-watcher"

const data: SidecarCredentials.Data = { url: "http://127.0.0.1:4100", password: "secret" }

function harness(input: { checks: boolean[]; restart?: Effect.Effect<SidecarCredentials.Data>; cap?: number }) {
  const events: Event[] = []
  const state = { checks: 0, restarts: [] as number[] }
  const watcher = make({
    connection: Effect.void,
    check: Effect.sync(() => input.checks[Math.min(state.checks++, input.checks.length - 1)] ?? true),
    restart: Effect.gen(function* () {
      state.restarts.push(yield* Clock.currentTimeMillis)

      return yield* input.restart ?? Effect.succeed(data)
    }),
    emit: (event) => events.push(event),
    backoff: { base: 500, cap: input.cap ?? 30_000 },
  })

  return { events, state, watcher }
}

const run = (effect: Effect.Effect<void>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

test("two failed checks restart the service once and announce it", () =>
  run(
    Effect.gen(function* () {
      const { events, state, watcher } = harness({ checks: [false] })
      yield* Effect.forkChild(watcher.run)
      yield* TestClock.adjust("2 seconds")

      expect(state.restarts).toHaveLength(1)
      expect(events.map((event) => event._tag)).toEqual(["KeteSidecarRestarting", "KeteSidecarReady"])
      expect(events[1]).toMatchObject({ url: data.url })
      watcher.stop()
    }),
  ))

test("one failed check followed by a healthy one restarts nothing", () =>
  run(
    Effect.gen(function* () {
      const { events, state, watcher } = harness({ checks: [false, true] })
      yield* Effect.forkChild(watcher.run)
      yield* TestClock.adjust("5 seconds")

      expect(state.restarts).toHaveLength(0)
      expect(events).toEqual([])
      watcher.stop()
    }),
  ))

test("a restart that keeps failing is retried with doubling delays", () =>
  run(
    Effect.gen(function* () {
      const { state, watcher } = harness({ checks: [false], restart: Effect.die("down") })
      yield* Effect.forkChild(watcher.run)
      yield* TestClock.adjust("7 seconds")
      watcher.stop()

      expect(state.restarts.slice(0, 4).map((time, index, all) => time - (all[index - 1] ?? time))).toEqual([
        0, 500, 1_000, 2_000,
      ])
    }),
  ))

test("the retry delay stops growing at the cap", () =>
  run(
    Effect.gen(function* () {
      const { state, watcher } = harness({ checks: [false], restart: Effect.die("down"), cap: 1_000 })
      yield* Effect.forkChild(watcher.run)
      yield* TestClock.adjust("6 seconds")
      watcher.stop()

      expect(state.restarts.slice(0, 5).map((time, index, all) => time - (all[index - 1] ?? time))).toEqual([
        0, 500, 1_000, 1_000, 1_000,
      ])
    }),
  ))

test("no check runs after stop", () =>
  run(
    Effect.gen(function* () {
      const { state, watcher } = harness({ checks: [true] })
      yield* Effect.forkChild(watcher.run)
      yield* TestClock.adjust("1 second")
      const before = state.checks
      watcher.stop()
      yield* TestClock.adjust("10 seconds")

      expect(before).toBe(1)
      expect(state.checks).toBe(before)
    }),
  ))

test("concurrent callers share one run, and a later call starts a new one", async () => {
  let runs = 0
  const shared = singleFlight(
    Effect.promise(async () => {
      await Bun.sleep(20)

      return ++runs
    }),
  )

  const results = await Effect.runPromise(Effect.all([shared, shared], { concurrency: "unbounded" }))

  expect(results).toEqual([1, 1])
  expect(await Effect.runPromise(shared)).toBe(2)
})
