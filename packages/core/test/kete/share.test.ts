// The `kete.share` RPC (kete/share/plugin.ts): every refusal happens before a request, the share
// lifecycle (create, update in place, delete), and an imported session never claims a share record.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "@opencode/core/config"
import { KeteShare } from "@opencode/core/kete/share/plugin"
import { KeteShareRecord } from "@opencode/core/kete/share/record"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import type { Plugin } from "@opencode/plugin/effect"
import { KeteAccount } from "@opencode/util/kete/account"
import { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { Effect } from "effect"
import { host } from "../plugin/host"

const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"
const key = "kete_test_SHARE0123456789abcdef"
const platform = "https://portal.example"
const at = { created: 0 }

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

type Handlers = Record<"preview" | "share" | "unshare", (input: unknown) => Effect.Effect<any>>

type Setup = {
  env?: Record<string, string>
  signedIn?: boolean
  config?: Array<Record<string, unknown>>
  share?: { mode: "disabled" | "org" | "link"; max_days: number } | "absent" | "no-cache"
  parentID?: string
  metadata?: Record<string, unknown>
  replies?: Array<{ status: number; body?: unknown }>
  /** The session's own folder; the request's is always /workspace. */
  directory?: string
  storeFails?: boolean
}

async function setup(options: Setup = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kete-share-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const account = { config: path.join(dir, "config"), data: path.join(dir, "data"), native: undefined }
  if (options.signedIn !== false)
    await KeteAccount.save(
      account,
      { platform_url: platform, gateway_url: "https://gw.example", organization: { id: org, name: "Kete Labs" }, key_id: "k1", device_name: "dev" },
      key,
    )
  if (options.share !== "no-cache")
    await KeteSyncCache.write(account.config, {
      version: 3,
      etag: '"e1"',
      synced_at: "2026-10-18T00:00:00.000Z",
      response: {
        organization: { id: org, name: "Kete Labs" },
        generated_at: "2026-10-18T00:00:00Z",
        agents: [],
        ...(options.share && options.share !== "absent" ? { share: options.share } : {}),
      },
    })

  const requests: Array<{ method: string; url: string; body: unknown; authorization: string | null }> = []
  const replies = [...(options.replies ?? [])]
  const fetch = async (url: string, init: RequestInit) => {
    requests.push({
      method: String(init.method),
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      authorization: (init.headers as Record<string, string>).authorization ?? null,
    })
    const reply = replies.shift() ?? { status: 500 }
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status })
  }

  const state = {
    metadata: options.metadata as Record<string, unknown> | undefined,
    messages: [
      { type: "user", id: "msg_1", time: at, text: "hello" },
      { type: "assistant", id: "msg_2", time: at, agent: "build", model: { providerID: "anthropic", id: "claude" }, content: [{ type: "text", text: "hi" }] },
    ] as object[],
  }
  const info = () => ({
    id: "ses_1",
    title: "My session",
    parentID: options.parentID,
    metadata: state.metadata,
    location: { directory: options.directory ?? "/workspace" },
  })
  const sessions = {
    get: () => Effect.succeed(info()),
    messages: () => Effect.succeed(state.messages),
    diff: () => Effect.succeed([]),
    setMetadata: (input: { metadata: Record<string, unknown> }) =>
      options.storeFails ? Effect.fail(new Error("disk full")) : Effect.sync(() => void (state.metadata = input.metadata)),
  }
  const configService = { entries: () => Effect.succeed((options.config ?? []).map((info) => ({ type: "document", info }))) }

  const handlers: { current?: Handlers } = {}
  const context = host({
    app: { name: "test", version: "9.9.9", channel: "test" },
    rpc: Object.assign(() => {
      throw new Error("unused")
    }, {
      register: (_definition: unknown, registered: Handlers) =>
        Effect.sync(() => {
          handlers.current = registered
          return { dispose: Effect.void, events: { emit: () => Effect.void } }
        }),
    }) as unknown as Plugin.Context["rpc"],
  })
  await Effect.runPromise(
    KeteShare.make({ fetch, env: options.env ?? {}, account })
      .effect(context)
      .pipe(
        Effect.provideService(Session.Service, sessions as never),
        Effect.provideService(Config.Service, configService as never),
        Effect.provideService(Location.Service, { directory: "/workspace" } as never),
      ) as Effect.Effect<void>,
  )
  const call = <K extends keyof Handlers>(method: K, input: object = {}) =>
    Effect.runPromise(handlers.current![method]({ sessionID: "ses_1", ...input }))
  return { call, requests, state, replies }
}

const created = (id = "s1", visibility = "org", url = "https://portal.example/shares/s1") => ({
  status: 201,
  body: { id, url, visibility, expires_at: "2026-11-17T00:00:00Z", created_at: "2026-10-18T00:00:00Z" },
})

describe("share refusals", () => {
  const cases: Array<[string, Setup, object, string]> = [
    ["job mode", { env: { OPENCODE_JOB_MODE: "1" } }, {}, "job"],
    ["offline", { env: { OPENCODE_OFFLINE: "1" } }, {}, "offline"],
    ["a child session", { parentID: "ses_0" }, {}, "child_session"],
    ["signed out", { signedIn: false }, {}, "signed_out"],
    ["config disabled", { config: [{ share: "manual" }, { share: "disabled" }, {}] }, {}, "config_disabled"],
    ["synced disabled", { share: { mode: "disabled", max_days: 30 } }, {}, "org_disabled"],
    ["synced org with link", { share: { mode: "org", max_days: 30 } }, { visibility: "link" }, "link_not_allowed"],
    ["synced absent (org) with link", { share: "absent" }, { visibility: "link" }, "link_not_allowed"],
    ["a request for another folder", { directory: "/elsewhere" }, {}, "location_mismatch"],
    [
      "another visibility than the existing share's",
      { share: { mode: "link", max_days: 7 }, metadata: { "kete.share": { id: "s1", url: "https://portal.example/shares/s1", visibility: "org", expires_at: "x", session: "ses_1" } } },
      { visibility: "link" },
      "already_shared",
    ],
  ]

  for (const [name, options, input, kind] of cases)
    test(`refuses ${name} before any request`, async () => {
      const { call, requests } = await setup(options)
      expect((await call("preview", input)).refusal.kind).toBe(kind)
      expect((await call("share", input)).refusal.kind).toBe(kind)
      expect(requests).toEqual([])
    })

  test("unshare is refused in job mode, offline and signed out, without a request", async () => {
    for (const [options, kind] of [
      [{ env: { OPENCODE_JOB_MODE: "1" } }, "job"],
      [{ env: { OPENCODE_OFFLINE: "1" } }, "offline"],
      [{ signedIn: false }, "signed_out"],
    ] as const) {
      const { call, requests } = await setup(options)
      expect((await call("unshare")).refusal.kind).toBe(kind)
      expect(requests).toEqual([])
    }
  })

  test("share auto uploads nothing on its own: preview sends no request", async () => {
    const { call, requests } = await setup({ config: [{ share: "auto" }] })
    const preview = await call("preview")
    expect(preview.refusal).toBeUndefined()
    expect(preview.counts.messages).toBe(2)
    expect(requests).toEqual([])
  })

  test("with no sync cache the request is sent and the platform decides", async () => {
    const { call, requests } = await setup({ share: "no-cache", replies: [{ status: 403, body: { error: { code: "share_link_not_allowed", message: "no" } } }] })
    const out = await call("share", { visibility: "link" })
    expect(requests).toHaveLength(1)
    expect(out.refusal.kind).toBe("failed")
  })
})

describe("share lifecycle", () => {
  test("a link share the organization revoked is re-shared, and the dead link is dropped", async () => {
    const link = { id: "s1", url: "https://portal.example/s/TOKEN", visibility: "link", expires_at: "x", session: "ses_1" }
    const { call, requests, replies } = await setup({ share: { mode: "org", max_days: 30 }, metadata: { "kete.share": link } })
    replies.push(created("s1", "org", "https://portal.example/shares/s1"))
    const out = await call("share", {})
    expect(requests[0]).toMatchObject({ method: "PUT" })
    expect(out.record).toMatchObject({ id: "s1", visibility: "org", url: "https://portal.example/shares/s1" })
  })

  test("share, share again in place, unshare", async () => {
    const { call, requests, state, replies } = await setup({ share: { mode: "link", max_days: 7 } })
    replies.push(created("s1", "link", "https://portal.example/s/TOKEN"))
    const first = await call("share", { visibility: "link" })
    expect(first.record).toMatchObject({ id: "s1", url: "https://portal.example/s/TOKEN", visibility: "link", session: "ses_1" })
    expect(state.metadata?.["kete.share"]).toEqual(first.record)
    expect(requests[0]).toMatchObject({ method: "POST", url: `${platform}/api/v1/shares`, authorization: `Bearer ${key}` })
    expect((requests[0]!.body as { snapshot: { runtime_version: string } }).snapshot.runtime_version).toBe("9.9.9")

    replies.push({ status: 200, body: { ...created("s1", "link").body, url: "https://portal.example/shares/s1" } })
    const again = await call("share")
    expect(requests[1]).toMatchObject({ method: "PUT", url: `${platform}/api/v1/shares/s1` })
    expect(again.record.id).toBe("s1")
    expect(again.record.url).toBe("https://portal.example/s/TOKEN") // the original link is kept

    replies.push({ status: 204 })
    expect(await call("unshare")).toEqual({ removed: true })
    expect(requests[2]).toMatchObject({ method: "DELETE", url: `${platform}/api/v1/shares/s1` })
    expect(state.metadata).toEqual({})
    expect(await call("unshare")).toEqual({ removed: false })
    expect(requests).toHaveLength(3)
  })

  test("a 404 on update starts a new share; a 404 on unshare clears the record", async () => {
    const record = { id: "old", url: "https://portal.example/shares/old", visibility: "org", expires_at: "x", session: "ses_1" }
    const { call, requests, state, replies } = await setup({ metadata: { other: 1, "kete.share": record } })
    replies.push({ status: 404, body: { error: { code: "not_found", message: "gone" } } }, created("new"))
    const out = await call("share")
    expect(requests.map((item) => item.method)).toEqual(["PUT", "POST"])
    expect(out.record.id).toBe("new")
    expect(state.metadata).toMatchObject({ other: 1, "kete.share": { id: "new" } })

    replies.push({ status: 404, body: { error: { code: "not_found", message: "gone" } } })
    expect(await call("unshare")).toEqual({ removed: true })
    expect(state.metadata).toEqual({ other: 1 })
  })

  test("a platform error comes back as a message and the record is kept", async () => {
    const record = { id: "s1", url: "https://portal.example/shares/s1", visibility: "org", expires_at: "x", session: "ses_1" }
    const { call, state, replies } = await setup({ metadata: { "kete.share": record } })
    replies.push({ status: 503, body: { error: { code: "unavailable", message: "later", request_id: "r9" } } })
    const out = await call("unshare")
    expect(out.refusal.kind).toBe("failed")
    expect(out.refusal.message).toContain("r9")
    expect(out.refusal.message).not.toContain(key)
    expect(state.metadata?.["kete.share"]).toEqual(record)
  })

  test("share with the preview's digest uploads only an unchanged session", async () => {
    const { call, requests, state, replies } = await setup()
    const preview = await call("preview")
    expect(preview.digest).toMatch(/^[0-9a-f]{64}$/)
    expect((await call("preview")).digest).toBe(preview.digest) // the time is not part of it
    state.messages = [...state.messages, { type: "user", id: "msg_3", time: at, text: "one more" }]
    const changed = await call("share", { digest: preview.digest })
    expect(changed.refusal).toEqual({ kind: "changed", message: "The session changed since the preview; review it again." })
    expect(requests).toEqual([])
    replies.push(created())
    expect((await call("share", { digest: (await call("preview")).digest })).record.id).toBe("s1")
  })

  test("a share that can't be recorded says where it was created; failures are cut to 400 characters", async () => {
    const { call, replies } = await setup({ storeFails: true })
    replies.push(created())
    const out = await call("share")
    expect(out.refusal.kind).toBe("failed")
    expect(out.refusal.message).toStartWith("The share was created at https://portal.example/shares/s1")
    expect(out.refusal.message).toContain("remove it in the Kete portal")
    const long = await setup({ replies: [{ status: 400, body: { error: { code: "bad", message: "x".repeat(1000) } } }] })
    expect((await long.call("share")).refusal.message.length).toBe(400)
  })

  test("a record made by another session is ignored, and an import drops it", () => {
    const record = { id: "s1", url: "https://portal.example/shares/s1", visibility: "org" as const, expires_at: "x", session: "ses_parent" }
    expect(KeteShareRecord.read({ "kete.share": record }, "ses_child")).toBeUndefined()
    expect(KeteShareRecord.read({ "kete.share": record }, "ses_parent")).toEqual(record)
    expect(KeteShareRecord.without({ other: 1, "kete.share": record })).toEqual({ other: 1 })
    expect(KeteShareRecord.without(undefined)).toBeUndefined()
  })
})
