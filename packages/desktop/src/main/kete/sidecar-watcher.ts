import { Effect, Exit } from "effect"
import { KeteSidecarReady, KeteSidecarRestarting } from "../../shared/kete/sidecar-events"
import { SidecarCredentials } from "../service/sidecar-credentials"

export type Event = KeteSidecarRestarting | KeteSidecarReady

export interface Input {
  /** Resolves once the first connection attempt is over; a failed attempt does not stop the watcher. */
  readonly connection: Effect.Effect<unknown>
  /** True when the service answers. Never fails. */
  readonly check: Effect.Effect<boolean>
  /** Brings the service back; may die, and is retried with backoff. */
  readonly restart: Effect.Effect<SidecarCredentials.Data>
  readonly emit: (event: Event) => void
  /** Milliseconds. */
  readonly interval?: number
  readonly threshold?: number
  readonly backoff?: { readonly base: number; readonly cap: number }
}

export function make(input: Input) {
  const interval = input.interval ?? 1_000
  const threshold = input.threshold ?? 2
  const { base, cap } = input.backoff ?? { base: 500, cap: 30_000 }
  let stopped = false

  const run = Effect.gen(function* () {
    yield* Effect.exit(input.connection)
    let failures = 0

    while (!stopped) {
      yield* Effect.sleep(interval)

      if (stopped) return

      if (yield* input.check) {
        failures = 0
        continue
      }

      if (++failures < threshold) continue

      input.emit(new KeteSidecarRestarting())

      for (let attempt = 0; !stopped; attempt++) {
        const exit = yield* Effect.exit(input.restart)

        if (Exit.isSuccess(exit)) {
          input.emit(new KeteSidecarReady({ url: exit.value.url }))
          break
        }

        yield* Effect.logWarning("sidecar restart failed; retrying", { attempt })
        yield* Effect.sleep(Math.min(base * 2 ** attempt, cap))
      }

      failures = 0
    }
  })

  return { run, stop: () => void (stopped = true) }
}

/** Concurrent callers share one run of `effect`; the next call after it finishes starts a new one. */
export function singleFlight<A>(effect: Effect.Effect<A>): Effect.Effect<A> {
  let flight: Promise<Exit.Exit<A>> | undefined

  return Effect.suspend(() => {
    const current =
      flight ??
      (flight = Effect.runPromiseExit(effect).finally(() => {
        flight = undefined
      }))

    return Effect.promise(() => current).pipe(Effect.flatMap((exit) => exit))
  })
}

/** An authenticated GET /api/info; any error, timeout or non-2xx status is unhealthy. No credential yet counts as healthy. */
export function healthy(get: () => SidecarCredentials.Data | undefined, timeout: number): Effect.Effect<boolean> {
  return Effect.promise(async () => {
    const data = get()

    if (!data) return true

    try {
      const url = new URL("/api/info", data.url)
      const authorization = SidecarCredentials.authorization(data, url.href)

      const response = await fetch(url, {
        headers: authorization ? { authorization } : {},
        signal: AbortSignal.timeout(timeout),
      })

      return response.ok
    } catch {
      // A refused connection, a timeout or a bad URL is the signal this check exists to detect.
      return false
    }
  })
}
