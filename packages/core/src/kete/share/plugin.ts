// Session sharing (docs/sharing.md): the `kete.share` RPC. `preview` builds the redacted snapshot and
// uploads nothing; `share` creates the share on the Kete portal, or updates it when this session is
// already shared; `unshare` deletes it. The share's id and link live in the session's metadata
// (`kete.share`, see ./record.ts). Nothing here runs on its own: config `share: "auto"` acts like
// `manual`, and every client asks the person before calling `share`.
//
// Refusals come before any request, in this order: a request for another folder than the session's
// (config is always read for the session's own folder), job mode, offline, a child session, signed out,
// `share: "disabled"` in ANY config entry (the more restrictive setting wins), then the synced
// organization policy, then a visibility other than an existing share's. `share` given the preview's
// digest refuses (`changed`) when the session changed since. With no sync cache yet the request is sent and the platform decides. `unshare`
// is refused only for another folder, in job mode, offline and signed out: deleting your own share stays possible after an
// organization turns sharing off.

export * as KeteShare from "./plugin.js"

import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import { KeteShareRpc } from "@opencode/schema/kete/share"
import { KeteAccount } from "@opencode/util/kete/account"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteShareClient, ShareError } from "@opencode/util/kete/share"
import { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { Session } from "../../session.js"
import type { SessionSchema } from "../../session/schema.js"
import { KeteOffline } from "../offline.js"
import { KeteShareRecord } from "./record.js"
import { KeteShareSnapshot } from "./snapshot.js"

export type Options = {
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  readonly env?: KeteOffline.Environment
  readonly account?: KeteAccount.Options
  readonly now?: () => Date
}

type Refusal = KeteShareRpc.Refusal
const refusal = (kind: Refusal["kind"], message: string): Refusal => ({ kind, message })

const messages = {
  job: "Sharing is not available in job mode.",
  offline: "Sharing is not available in offline mode.",
  signed_out: "Sign in with `kete login` to share. Sessions using only your own API keys can't be shared.",
  config_disabled: 'Sharing is turned off by `share: "disabled"` in your configuration.',
  org_disabled: "Your organization has turned session sharing off.",
  link_not_allowed: "Your organization allows sharing with its members only; link sharing is not allowed.",
  child_session: "Share the main session, not a subagent session.",
  too_large: "This session is too large to share, even after dropping tool output and patches (limit 2 MiB).",
  changed: "The session changed since the preview; review it again.",
  location_mismatch: "The request is for another folder than the session's; open the session's own folder to share it.",
} as const

const audience = { org: "your organization", link: "anyone with the link" } as const

const describe = (error: unknown) => (error instanceof Error ? error.message : "unknown error")

export function make(options: Options = {}) {
  return define({
    id: "kete.share",
    effect: Effect.fn(function* (ctx) {
      const sessions = yield* Session.Service
      const config = yield* Config.Service
      const location = yield* Location.Service
      const env = options.env ?? process.env
      const account = options.account ?? KeteAccount.defaults()
      const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: (error) => error })
      const client = (platform: string, key: string, signal: AbortSignal): KeteShareClient.Options => ({
        platform,
        key,
        signal,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })

      // The refusals before any account read: another folder, job mode, offline.
      const environment = Effect.fnUntraced(function* (session: SessionSchema.Info) {
        if (path.resolve(session.location.directory) !== path.resolve(location.directory))
          return refusal("location_mismatch", messages.location_mismatch)
        if (KeteJobMode.enabled(env)) return refusal("job", messages.job)
        if (yield* KeteOffline.active(config, env)) return refusal("offline", messages.offline)
        return undefined
      })

      const signedIn = Effect.fnUntraced(function* () {
        return yield* attempt(() => KeteAccount.read(account))
      })

      type Ready = {
        readonly session: SessionSchema.Info
        readonly signedIn: KeteAccount.Account
        readonly visibility: KeteShareRpc.Visibility
        readonly linkAllowed: boolean
        readonly maxDays: number
        readonly existing: KeteShareRpc.Record | undefined
      }

      const prepare = Effect.fnUntraced(function* (sessionID: string, visibility: KeteShareRpc.Visibility | undefined) {
        const session = yield* sessions.get(sessionID as SessionSchema.ID)
        const early = yield* environment(session)
        if (early) return { refusal: early } as const
        if (session.parentID) return { refusal: refusal("child_session", messages.child_session) } as const
        const who = yield* signedIn()
        if (!who) return { refusal: refusal("signed_out", messages.signed_out) } as const
        const entries = yield* config.entries()
        if (entries.some((entry) => entry.type === "document" && entry.info.share === "disabled"))
          return { refusal: refusal("config_disabled", messages.config_disabled) } as const
        // An unreadable cache is treated as none: the platform decides.
        const cached = yield* attempt(() => KeteSyncCache.read(account.config, who.organization.id)).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        const policy = KeteShareClient.policy(cached?.response)
        const existing = KeteShareRecord.read(session.metadata, session.id)
        // An existing share keeps its visibility (PUT never changes it; the platform may turn a revoked link into org).
        if (existing && visibility && visibility !== existing.visibility)
          return {
            refusal: refusal(
              "already_shared",
              `This session is already shared for ${audience[existing.visibility]}; unshare it first to change who can see it.`,
            ),
          } as const
        const chosen = existing?.visibility ?? visibility ?? "org"
        if (cached && policy.mode === "disabled") return { refusal: refusal("org_disabled", messages.org_disabled) } as const
        // Only a new link share is refused: re-sharing an existing one lets the platform report the revocation.
        if (cached && !existing && chosen === "link" && policy.mode !== "link")
          return { refusal: refusal("link_not_allowed", messages.link_not_allowed) } as const
        const ready: Ready = {
          session,
          signedIn: who,
          visibility: chosen,
          linkAllowed: !cached || policy.mode === "link",
          maxDays: policy.max_days,
          existing,
        }
        return { ready } as const
      })

      const snapshot = Effect.fnUntraced(function* (session: SessionSchema.Info) {
        const all = yield* sessions.messages({ sessionID: session.id, order: "asc" })
        const users = all.filter((item) => item.type === "user")
        // The whole session: from the first prompt's turn to the last one's. A failure (a location
        // change inside the session, a missing snapshot) is not hidden: the share is marked truncated.
        const read = users.length
          ? yield* sessions.diff({ sessionID: session.id, from: users[0].id, to: users[users.length - 1].id }).pipe(
              Effect.map((diffs) => ({ diffs, incomplete: false })),
              Effect.catch(() => Effect.succeed({ diffs: [] as const, incomplete: true })),
            )
          : { diffs: [] as const, incomplete: false }
        return KeteShareSnapshot.build({
          messages: all,
          diffs: read.diffs,
          diffsIncomplete: read.incomplete,
          workspace: location.directory,
          title: session.title || "Untitled session",
          version: ctx.app.version,
          now: (options.now ?? (() => new Date()))(),
        })
      })

      const store = (session: SessionSchema.Info, record: KeteShareRpc.Record | undefined) =>
        Effect.gen(function* () {
          // Read the metadata again: the upload took time.
          const current = yield* sessions.get(session.id)
          const rest = KeteShareRecord.without(current.metadata) ?? {}
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: record ? { ...rest, [KeteShareRecord.metadataKey]: record } : rest,
          })
        })

      const failed = (error: unknown) =>
        Effect.succeed({ refusal: refusal("failed", (error instanceof ShareError ? error.message : describe(error)).slice(0, 400)) })

      const empty = (refused: Refusal): KeteShareRpc.PreviewOutput => ({
        refusal: refused,
        counts: { messages: 0, tools: 0, diffs: 0 },
        bytes: 0,
        redactions: 0,
        truncated: false,
        visibility: "org",
        linkAllowed: false,
        maxDays: 0,
      })

      yield* ctx.rpc
        .register(KeteShareRpc.Definition, {
          preview: ({ sessionID, visibility }) =>
            Effect.gen(function* () {
              const checked = yield* prepare(sessionID, visibility)
              if (checked.refusal) return empty(checked.refusal)
              const { ready } = checked
              const built = yield* snapshot(ready.session)
              if (!built) return empty(refusal("too_large", messages.too_large))
              return {
                counts: built.counts,
                bytes: built.bytes,
                redactions: built.redactions,
                truncated: built.snapshot.truncated,
                visibility: ready.visibility,
                linkAllowed: ready.linkAllowed,
                maxDays: ready.maxDays,
                ...(ready.existing ? { existing: ready.existing } : {}),
                digest: built.digest,
              } satisfies KeteShareRpc.PreviewOutput
            }).pipe(Effect.catch((error) => failed(error).pipe(Effect.map((out) => empty(out.refusal))))),

          share: ({ sessionID, visibility, digest }) =>
            Effect.gen(function* () {
              const checked = yield* prepare(sessionID, visibility)
              if (checked.refusal) return { refusal: checked.refusal }
              const { ready } = checked
              const built = yield* snapshot(ready.session)
              if (!built) return { refusal: refusal("too_large", messages.too_large) }
              if (digest !== undefined && digest !== built.digest) return { refusal: refusal("changed", messages.changed) }
              const key = yield* attempt(() => KeteAccount.key(account, ready.signedIn))
              if (key === undefined)
                return { refusal: refusal("signed_out", "The account key is missing from this device. Run `kete login` again.") }
              const platform = ready.signedIn.platform_url
              const body = { session_id: ready.session.id, title: built.snapshot.title, visibility: ready.visibility, snapshot: built.snapshot }
              const create = attempt((signal) => KeteShareClient.create(client(platform, key, signal), body))
              const update = (id: string) =>
                attempt((signal) => KeteShareClient.update(client(platform, key, signal), id, { title: body.title, snapshot: body.snapshot }))
              const created = ready.existing
                ? yield* update(ready.existing.id).pipe(
                    // The share is gone on the platform (expired, deleted): start a new one.
                    Effect.catch((error) => (error instanceof ShareError && error.code === "not_found" ? create : Effect.fail(error))),
                  )
                : yield* create
              const reused = ready.existing && created.id === ready.existing.id
              const record: KeteShareRpc.Record = {
                id: created.id,
                // A link share's token is only returned once; an update returns the plain share page. A link the
                // organization revoked (mode lowered) comes back as "org", so the dead link is dropped.
                url: reused && created.visibility === "link" ? ready.existing!.url : created.url,
                visibility: created.visibility,
                expires_at: created.expires_at,
                session: ready.session.id,
              }
              yield* store(ready.session, record).pipe(
                Effect.catch((error) =>
                  Effect.fail(
                    new Error(
                      `The share was created at ${record.url} but could not be recorded in this session, so remove it in the Kete portal (${describe(error)}).`,
                    ),
                  ),
                ),
              )
              return { record }
            }).pipe(Effect.catch(failed)),

          unshare: ({ sessionID }) =>
            Effect.gen(function* () {
              const session = yield* sessions.get(sessionID as SessionSchema.ID)
              const early = yield* environment(session)
              if (early) return { refusal: early }
              const who = yield* signedIn()
              if (!who) return { refusal: refusal("signed_out", messages.signed_out) }
              const record = KeteShareRecord.read(session.metadata, session.id)
              if (!record) return { removed: false }
              const key = yield* attempt(() => KeteAccount.key(account, who))
              if (key === undefined)
                return { refusal: refusal("signed_out", "The account key is missing from this device. Run `kete login` again.") }
              yield* attempt((signal) => KeteShareClient.remove(client(who.platform_url, key, signal), record.id)).pipe(
                // Already gone: the local record is cleared all the same.
                Effect.catch((error) => (error instanceof ShareError && error.code === "not_found" ? Effect.void : Effect.fail(error))),
              )
              yield* store(session, undefined)
              return { removed: true }
            }).pipe(Effect.catch(failed)),
        })
        .pipe(Effect.orDie)
    }),
  })
}

export const Plugin = make()
