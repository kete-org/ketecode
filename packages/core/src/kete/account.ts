// Sign in to and out of the Kete account from a client (desktop Settings -> Account, the new-session
// prompt): the `kete.account` plugin RPC. The runtime runs `kete login --no-browser` / `kete logout` as a
// child process (util/src/kete/login-child.ts); the client opens the approval URL in the user's browser,
// so the runtime never opens one. The key, key id, code and verifier never pass through this plugin:
// it sees only the approval URL and the child's exit.
//
// - `status`: signed in or not (read fresh), the organization, the platform host, offline, signing in.
// - `login`: one attempt per plugin instance; a second call returns the same URL. Waits up to 30 s for the
//   child to print the URL, and only accepts an https URL (http for a loopback host) ending `/cli/authorize`.
// - `cancel`, `logout`.
// - After a change it emits `rpc.kete.account.changed`; the gateway reloads and sync runs a tick on it.
// Offline mode and job mode refuse (as data). The server's `KeteAccountGate` refuses every method but
// `status` unless the server is local-only: a handler can't see its caller (server/src/kete/account-gate.ts).

export * as KeteAccount from "./account.js"

import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { KeteAccountRpc } from "@opencode/schema/kete/account"
import { Global } from "@opencode/util/global"
import { KeteAccount as AccountStore } from "@opencode/util/kete/account"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteLoginChild } from "@opencode/util/kete/login-child"
import { KeteOffline as OfflineFlag } from "@opencode/util/kete/offline"
import { Effect } from "effect"
import { Config } from "../config.js"
import { KeteOffline } from "./offline.js"

export const id = "kete.account"

/** How long `login` waits for the child to print the approval URL. */
export const URL_TIMEOUT = 30_000
const LOGOUT_TIMEOUT = 60_000
export const REVOKE_WARNING =
  "Signed out on this computer, but the platform could not revoke the key. To be sure it can't be used, revoke it from the Kete Code portal."

export type Options = {
  /** Directory holding account.json (default: the global config directory). */
  readonly config?: string
  /** The CLI command to run (default: this executable). Tests inject a stand-in. */
  readonly command?: string[]
  readonly urlTimeout?: number
  /** Overrides the child's environment (default: process.env). */
  readonly env?: NodeJS.ProcessEnv
}

/** Whether `value` is an approval URL we pass to a client: https (http only for loopback), `/cli/authorize`. */
export function validURL(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  const secure = url.protocol === "https:" || (url.protocol === "http:" && OfflineFlag.isLoopbackHost(url.hostname))
  return secure && url.pathname.endsWith("/cli/authorize")
}

type Attempt = { readonly cancel: () => void; url?: string; silent: boolean }

export function make(options: Options = {}) {
  return {
    id,
    effect: Effect.fn("KeteAccount.Plugin")(function* (ctx: PluginContext) {
      const config = yield* Config.Service
      const account = { config: options.config ?? Global.Path.config }
      const env = options.env ?? process.env
      let attempt: Attempt | undefined
      // Set once the RPC is registered; the handlers (registered first) announce through it.
      const emitter: { current: (state: KeteAccountRpc.Changed["state"], message?: string) => Effect.Effect<void> } = {
        current: () => Effect.void,
      }
      const announce = (state: KeteAccountRpc.Changed["state"], message?: string): Effect.Effect<void> =>
        emitter.current(state, message)

      const registration = yield* ctx.rpc
        .register(KeteAccountRpc.Definition, {
          status: () =>
            Effect.gen(function* () {
              const offline = yield* KeteOffline.active(config)
              const found = yield* Effect.tryPromise(() => AccountStore.read(account)).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("account file unreadable", { cause }).pipe(Effect.as(undefined)),
                ),
              )
              return {
                signedIn: found !== undefined,
                organization: found?.organization.name,
                platform: found && URL.canParse(found.platform_url) ? new URL(found.platform_url).host : undefined,
                offline,
                signingIn: attempt !== undefined,
              }
            }),
          login: () => login(),
          cancel: () =>
            Effect.sync(() => {
              if (!attempt) return { cancelled: false }
              attempt.cancel()
              return { cancelled: true }
            }),
          logout: () => logout(),
        })
        .pipe(Effect.orDie)

      emitter.current = (state, message) =>
        registration.events
          .emit("changed", { state, message })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to announce an account change", { cause })))
      const run = Effect.runForkWith(yield* Effect.context())

      const refusal = Effect.fn("KeteAccount.refusal")(function* (command: string) {
        if (KeteJobMode.enabled()) return { kind: "refused" as const, reason: "job-mode" as const, message: KeteJobMode.message(command) }
        if (yield* KeteOffline.active(config))
          return { kind: "refused" as const, reason: "offline" as const, message: OfflineFlag.refuse(command) }
        return undefined
      })

      const login = Effect.fn("KeteAccount.login")(function* () {
        const refused = yield* refusal("kete login")
        if (refused) return refused
        if (attempt?.url) return { kind: "started" as const, url: attempt.url }
        if (attempt) return { kind: "failed" as const, message: "Sign-in is starting; try again in a moment." }
        return yield* Effect.promise(
          () =>
            new Promise<KeteAccountRpc.Login>((resolve) => {
              const current: Attempt = { cancel: () => child.cancel(), silent: false }
              const timer = setTimeout(() => {
                current.silent = true
                child.cancel()
                resolve({ kind: "failed", message: "The platform did not return a sign-in address in time." })
              }, options.urlTimeout ?? URL_TIMEOUT)
              const child = KeteLoginChild.start({
                args: ["login", "--no-browser"],
                command: options.command,
                env,
                onURL: (url) => {
                  clearTimeout(timer)
                  if (!validURL(url)) {
                    current.silent = true
                    child.cancel()
                    resolve({ kind: "failed", message: "The platform returned an unexpected sign-in address." })
                    return
                  }
                  current.url = url
                  resolve({ kind: "started", url })
                },
              })
              attempt = current
              void child.result.then((result) => {
                clearTimeout(timer)
                if (attempt === current) attempt = undefined
                // Already settled when the URL came first; this only answers a child that ended before it.
                resolve({
                  kind: "failed",
                  message: result.kind === "failed" ? result.reason : result.kind === "cancelled" ? "Sign-in was cancelled." : "Sign-in finished before an address was shown.",
                })
                if (current.silent) return
                run(
                  result.kind === "ok"
                    ? announce("signed-in")
                    : result.kind === "cancelled"
                      ? announce("cancelled")
                      : announce("failed", result.reason),
                )
              })
            }),
        )
      })

      const logout = Effect.fn("KeteAccount.logout")(function* () {
        const refused = yield* refusal("kete logout")
        if (refused) return refused
        // A sign-in still waiting for approval must not complete after we sign out.
        if (attempt) {
          attempt.silent = true
          attempt.cancel()
          attempt = undefined
        }
        const result = yield* Effect.promise(
          () => KeteLoginChild.start({ args: ["logout"], command: options.command, env, timeout: LOGOUT_TIMEOUT }).result,
        )
        if (result.kind === "ok") {
          yield* announce("signed-out")
          // The CLI's warning names the key id; say only that the platform didn't revoke it.
          const unrevoked = result.warnings?.some((line) => /could not revoke/i.test(line))
          return unrevoked ? { kind: "done" as const, message: REVOKE_WARNING } : { kind: "done" as const }
        }
        return { kind: "failed" as const, message: result.kind === "failed" ? result.reason : "Sign-out was cancelled." }
      })

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (attempt) attempt.silent = true
          attempt?.cancel()
        }),
      )
    }),
  }
}

export const Plugin = make()
