// The local OS sandbox for shell commands the agent runs (ADR 0013, docs/sandbox.md).
//
// The permission system (permission-mode.ts, shell-risk.ts) is the first layer: it decides whether a
// command runs. This module decides how: inside `sandbox-exec` (macOS) or `bwrap` (Linux), where it
// can write only the workspace, temp directories and toolchain caches — never Kete Code's
// configuration or git's hooks and config, even inside the workspace — can't read credentials, and
// reaches the network only when a person approved the command. That contains the accepted residual
// risk of docs/permissions.md: a test or build the defaults allow without asking runs the project's
// code, which may have been edited to do anything.
//
// Pieces:
// - `Sandboxer.prepare`, called by the shell tool (tool/plugin/shell.ts) after its permission check:
//   decides sandboxed or not, with or without network, asks for `sandbox_off`/`sandbox_network`
//   when needed (sandbox/actions.ts), resolves the policy (sandbox/resolve.ts) and attaches it to
//   the invocation.
// - `wrap`, called by shell.ts where it spawns: turns the shell's own command line into the
//   sandboxed one.
// - `Plugin`: the permission hook that makes requested escapes always ask (Plan blocks them), and
//   the `kete.sandbox` status RPC for the clients. Guarded: repository config can't remove it.
//
// Job mode (cloud and self-hosted jobs) is left alone: there the job's own sandbox applies and every
// spawn goes through the job's tool runner. Windows has no sandbox in v1.

export * as KeteSandbox from "./sandbox.js"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { define } from "@opencode/plugin/effect/plugin"
import { KeteSandboxRpc } from "@opencode/schema/kete/sandbox"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import type { Entry } from "@opencode/schema/config"
import { Effect, Schema } from "effect"
import { Config } from "../config.js"
import { Global } from "@opencode/util/global"
import { Session } from "../session.js"
import type { SessionSchema } from "../session/schema.js"
import { KetePermissionMode } from "./permission-mode.js"
import { KeteSandboxActions } from "./sandbox/actions.js"
import { KeteSandboxPlans } from "./sandbox/plans.js"
import { KeteSandboxProbe } from "./sandbox/probe.js"
import { KeteSandboxResolve } from "./sandbox/resolve.js"
import { KeteSandboxSettings } from "./sandbox/settings.js"

export const Actions = KeteSandboxActions
export const Settings = KeteSandboxSettings

/** The shell tool's `sandbox` input: run this command with network access, or outside the sandbox. */
export const Request = Schema.Literals(["network", "off"])
export type Request = typeof Request.Type

export const requestDescription =
  'Only when a command failed because of the OS sandbox: "network" runs it with network access, "off" runs it outside the sandbox. Both ask the user first. Omit otherwise.'

// ---------------------------------------------------------------------------------------------
// Availability, checked once per process (it doesn't change while the runtime runs).

let probed: Promise<KeteSandboxProbe.Result> | undefined
export const availability = Effect.promise(() => (probed ??= KeteSandboxProbe.probe()))

// ---------------------------------------------------------------------------------------------
// Settings

export const settingsFrom = (entries: ReadonlyArray<Entry>, globalDirectory: string, env?: Record<string, string | undefined>) =>
  KeteSandboxSettings.resolve({
    documents: entries.flatMap((entry) =>
      entry.type === "document" ? [{ path: entry.path, sandbox: entry.info.kete?.sandbox }] : [],
    ),
    globalDirectory,
    env,
  })

// ---------------------------------------------------------------------------------------------
// Invocation state: what the shell tool decided for one spawn, read back by `wrap` in shell.ts.

const approvals = new WeakMap<object, Readonly<Record<string, unknown>>>()

/** The shell tool records the metadata it gave its permission check (the hooks mark approval on it). */
export function remember(invocation: object, metadata: Readonly<Record<string, unknown>>) {
  approvals.set(invocation, metadata)
}

export const wrap = KeteSandboxPlans.wrap

/** How a command ran, for the tool's output. */
export type Outcome =
  | { readonly kind: "sandboxed"; readonly network: boolean }
  | { readonly kind: "unsandboxed"; readonly reason: KeteSandboxActions.Reason; readonly detail: string }
  | { readonly kind: "job" }

// What a sandbox refusal looks like in a command's output: macOS denies with EPERM, Linux's read-only
// binds give EROFS, and without network DNS fails first.
const FILE_DENIED = /operation not permitted|read-only file system|\beperm\b|\berofs\b/i
const NETWORK_DENIED =
  /could not resolve host|enotfound|eai_again|getaddrinfo|name resolution|nodename nor servname|name or service not known|network is unreachable|enetunreach|failed to resolve|dial tcp: lookup|no address associated with hostname/i

/**
 * A line for the model: after a sandboxed command failed with an error the sandbox causes, and after
 * a command ran outside the sandbox on request. Other failures get nothing, to keep output short.
 */
export function notice(outcome: Outcome, exit: number | undefined, output: string): string | undefined {
  if (outcome.kind === "unsandboxed" && outcome.reason === "requested") return "[Ran outside the OS sandbox, as approved.]"
  if (outcome.kind !== "sandboxed" || exit === undefined || exit === 0) return undefined
  const network = !outcome.network && NETWORK_DENIED.test(output)
  if (!network && !FILE_DENIED.test(output)) return undefined
  const limits = outcome.network
    ? "it can write only inside the workspace, temp directories and package caches, never to .git config or hooks or Kete Code configuration, and can't read credentials"
    : "it can write only inside the workspace, temp directories and package caches, never to .git config or hooks or Kete Code configuration, can't read credentials, and has no network access"
  const retry = outcome.network || !network ? '"off"' : '"network" (or "off" if it also needs to write elsewhere)'
  return `[This command ran in Kete Code's OS sandbox: ${limits}. If the sandbox caused the failure, run it again with sandbox: ${retry}; the user is asked first.]`
}

export interface Deps {
  readonly config: Config.Interface
  readonly global: Pick<Global.Interface, "home" | "config" | "data" | "cache" | "state" | "log" | "bin" | "tmp" | "repos">
  readonly location: { readonly workspace: string; readonly directory: string; readonly projectID: string }
  /** The shell output directory root (`Shell.DIRECTORY` under the data directory). */
  readonly shellDirectory: string
  readonly env?: Record<string, string | undefined>
}

export interface Ask {
  (input: { readonly action: string; readonly reason?: KeteSandboxActions.Reason }): Effect.Effect<void, unknown>
}

export interface Prepared {
  readonly outcome: Outcome
  /** Removes placeholders created for this command; call once the command has ended. */
  readonly release: Effect.Effect<void>
}

const NONE: Effect.Effect<void> = Effect.void

/** Agent and session-bus variables: a command without network must not reach the SSH or GPG agent or
 * the session bus through them. With network (a person approved) they stay, so `git push` over SSH works. */
export const agentVariables = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO", "DBUS_SESSION_BUS_ADDRESS"] as const

/** The sandboxed command's environment: temp variables point at the private temp directory. */
export function environment(env: Record<string, string | undefined>, tmp: string, network: boolean) {
  const next: Record<string, string | undefined> = { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }
  if (!network) for (const name of agentVariables) delete next[name]
  return next
}

export class RefusedError extends Schema.TaggedError<RefusedError>()("KeteSandbox.RefusedError", {
  message: Schema.String,
}) {}

/** One per shell tool activation (a runtime location). */
export function make(deps: Deps) {
  const placeholders = KeteSandboxResolve.shared
  const env = deps.env ?? process.env

  // One private temp directory per session (kept while the runtime runs, so files in TMPDIR survive
  // between a session's commands): TMPDIR/TMP/TEMP inside the sandbox, the only temp place where Unix
  // sockets can be used without network.
  const privateTmps = new Map<string, Promise<string>>()
  const privateTmp = (sessionID: string) => {
    let existing = privateTmps.get(sessionID)
    if (!existing) {
      existing = fs.mkdtemp(path.join(os.tmpdir(), "kete-sandbox-"))
      privateTmps.set(sessionID, existing)
      existing.catch(() => privateTmps.delete(sessionID))
    }
    return existing
  }

  const prepare = Effect.fnUntraced(function* (
    invocation: { readonly cwd: string; env: Record<string, string | undefined> },
    sessionID: string,
    request: Request | undefined,
    ask: Ask,
  ) {
    if (KeteJobMode.enabled(env)) return { outcome: { kind: "job" } as Outcome, release: NONE } satisfies Prepared
    const settings = settingsFrom(yield* deps.config.entries(), deps.global.config, env)

    const unsandboxed = Effect.fnUntraced(function* (reason: KeteSandboxActions.Reason, detail: string) {
      yield* ask({ action: KeteSandboxActions.off, reason })
      return { outcome: { kind: "unsandboxed", reason, detail } as Outcome, release: NONE } satisfies Prepared
    })

    if (settings.mode === "off") return yield* unsandboxed("disabled", `turned off (${settings.modeSource})`)
    const available = yield* availability
    if (!available.available) {
      if (settings.mode === "required")
        return yield* new RefusedError({
          message: `Kete Code's OS sandbox is required (${settings.invalid !== undefined ? `${KeteSandboxSettings.publicName} is "${settings.invalid}", which isn't off, auto or required` : settings.modeSource}) but not available: ${available.reason}.`,
        })
      return yield* unsandboxed("unavailable", available.reason)
    }
    if (request === "off") return yield* unsandboxed("requested", "approved for this command")

    const approvedByPerson = KeteSandboxActions.approved(approvals.get(invocation))
    let network = settings.network === "all" || (settings.network === "approved" && approvedByPerson)
    if (request === "network" && !network) {
      if (settings.network === "none")
        return yield* new RefusedError({
          message: 'Network access in the sandbox is off by configuration (kete.sandbox.network: "none").',
        })
      yield* ask({ action: KeteSandboxActions.network })
      network = true
    }

    const mechanism = available.mechanism
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        const tmp = await privateTmp(sessionID)
        const result = await KeteSandboxResolve.resolve(
          {
            platform: mechanism === "seatbelt" ? "darwin" : "linux",
            home: deps.global.home,
            workspace: deps.location.workspace,
            directory: deps.location.directory,
            kete: deps.global,
            shellOutput: path.join(deps.shellDirectory, deps.location.projectID),
            settings,
            network,
            privateTmp: tmp,
            env,
          },
          placeholders,
        )
        const plan = { mechanism, executable: available.executable, policy: result.policy, cwd: invocation.cwd }
        try {
          KeteSandboxPlans.validate(plan)
        } catch (error) {
          await result.release()
          throw error
        }
        return { ...result, plan, tmp }
      },
      catch: (cause) =>
        new RefusedError({
          message: `Kete Code couldn't set up the OS sandbox for this command: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    })
    KeteSandboxPlans.attach(invocation, resolved.plan)
    invocation.env = environment(invocation.env, resolved.tmp, network)
    return {
      outcome: { kind: "sandboxed", network } as Outcome,
      release: Effect.promise(() => resolved.release()),
    } satisfies Prepared
  })

  return { prepare }
}

// ---------------------------------------------------------------------------------------------
// Status (RPC) and the permission hook

const MAX_REASON = KeteSandboxRpc.MAX_REASON
const clip = (value: string) => (value.length > MAX_REASON ? value.slice(0, MAX_REASON - 1) + "…" : value)

export const status = Effect.fnUntraced(function* (
  entries: ReadonlyArray<Entry>,
  globalDirectory: string,
  env: Record<string, string | undefined> = process.env,
) {
  const settings = settingsFrom(entries, globalDirectory, env)
  const base = { platform: process.platform, mode: settings.mode, network: settings.network, ignored: settings.ignored }
  if (KeteJobMode.enabled(env)) return { ...base, state: "job" } satisfies KeteSandboxRpc.Status
  if (settings.mode === "off")
    return { ...base, state: "off", reason: clip(`turned off (${settings.modeSource})`) } satisfies KeteSandboxRpc.Status
  const available = yield* availability
  if (!available.available) return { ...base, state: "unavailable", reason: clip(available.reason) } satisfies KeteSandboxRpc.Status
  return { ...base, state: "on", mechanism: available.mechanism } satisfies KeteSandboxRpc.Status
})

const short = (value: string) => {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > 120 ? line.slice(0, 117) + "..." : line
}

/** What the permission hook does with a sandbox action, given the session's mode. */
export function decide(
  mode: KetePermissionMode.Mode,
  action: string,
  resources: ReadonlyArray<string>,
  metadata: Readonly<Record<string, unknown>> | undefined,
): { effect: "ask" | "deny"; message: string } | undefined {
  if (!KeteSandboxActions.isSandboxAction(action)) return undefined
  if (KeteSandboxActions.automatic(action, metadata)) return undefined
  const command = short(typeof metadata?.command === "string" ? metadata.command : (resources[0] ?? ""))
  if (mode === "plan")
    return { effect: "deny", message: "Plan mode is read-only: commands can't leave the OS sandbox or use the network." }
  if (action === KeteSandboxActions.network)
    return {
      effect: "ask",
      message: `Let \`${command}\` use the network from inside the OS sandbox? It could send data from this machine.`,
    }
  return {
    effect: "ask",
    message: `Run \`${command}\` outside the OS sandbox? It can then change any of your files, read your credentials and use the network.`,
  }
}

export const Plugin = define({
  id: "kete.sandbox",
  effect: Effect.fn(function* (ctx) {
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const global = yield* Global.Service
    const fallback = KetePermissionMode.parse(process.env.KETE_PERMISSION_MODE) ?? "default"
    const lookup: KetePermissionMode.Lookup = {
      session: (sessionID: SessionSchema.ID) => sessions.get(sessionID).pipe(Effect.option),
      agent: () => Effect.succeed(undefined),
      approved: Effect.succeed([]),
      fallback,
    }

    // Requested escapes always ask (Plan blocks them), whatever a rule or a saved approval says:
    // repository config can carry permission rules, so a rule must not pre-approve leaving the sandbox.
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        if (event.effect === "deny" || !KeteSandboxActions.isSandboxAction(event.action)) return
        if (KeteSandboxActions.automatic(event.action, event.metadata)) return
        const mode = yield* KetePermissionMode.resolveMode(lookup, event.sessionID)
        const outcome = decide(mode, event.action, event.resources, event.metadata)
        if (!outcome) return
        if (outcome.effect === "deny" || event.effect === "allow") {
          event.effect = outcome.effect
          event.message = outcome.message
        }
      }),
    )

    yield* ctx.rpc
      .register(KeteSandboxRpc.Definition, {
        status: () => Effect.flatMap(config.entries(), (entries) => status(entries, global.config)),
      })
      .pipe(Effect.orDie)

    // Said once when the runtime starts, so an unsandboxed machine is never silent.
    if (!KeteJobMode.enabled()) {
      const current = yield* Effect.flatMap(config.entries(), (entries) => status(entries, global.config))
      if (current.state === "unavailable")
        yield* Effect.logWarning(
          `Kete Code's OS sandbox isn't available (${current.reason ?? "unknown"}): agent commands run without it${current.mode === "required" ? " and are refused, because the sandbox is required" : ""}.`,
        )
      if (current.state === "off") yield* Effect.logWarning(`Kete Code's OS sandbox is off (${current.reason ?? ""}).`)
      if (current.ignored.length > 0)
        yield* Effect.logWarning(`Ignored project sandbox settings that would loosen it: ${current.ignored.join(", ")}.`)
    }
  }),
})

/**
 * The sandbox's approval mark (sandbox/actions.ts `approve`), registered last of all `evaluate` hooks
 * (after KeteUnattended.Plugin), so the decision it sees is final: no hook can turn its "ask" into
 * "allow" afterwards, and a command marked here runs only if a person allows the prompt. Guarded.
 */
export const ApprovalPlugin = define({
  id: "kete.sandbox.approval",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.permission.hook("evaluate", (event) => Effect.sync(() => KeteSandboxActions.approve(event)))
  }),
})
