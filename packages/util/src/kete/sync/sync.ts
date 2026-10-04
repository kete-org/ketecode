// One sync of the organization's managed agents: read the signed-in account, fetch with the cached
// ETag, write the cache on 200, nothing on 304. On any error the cache is left exactly as it was.
// Shared by `kete sync` and `kete login` (CLI) and the runtime's periodic sync (core/src/kete/sync).
// In job mode (piece A2) a `credential` — the job's gateway key and the platform URL — replaces the
// account: nothing reads account.json or the OS key store, and 401 wording drops the `kete login` advice.

import { KeteAccount } from "../account.js"
import { KeteSyncCache } from "./cache.js"
import { KeteSyncClient } from "./client.js"
import { KeteSyncSkills } from "./skills.js"

/** A job's key (job mode piece A2): sync with it instead of the signed-in account, which is never read. */
export type Credential = {
  readonly platform: string
  readonly key: string
  /** The organization id (a GUID) an earlier sync found: where this call finds its cache and ETag. */
  readonly organization?: string
}

export type Options = KeteAccount.Options & {
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  readonly now?: () => Date
  /** Replaces the account: `signed-out` is never returned, the account file and key store are not touched. */
  readonly credential?: Credential
}

// Where one sync gets its platform, key and the organization whose cache it started from.
type Source = { readonly platform: string; readonly key: string; readonly organization: string | undefined; readonly kind: "account" | "job" }

export type Changes = { readonly added: string[]; readonly updated: string[]; readonly removed: string[] }

export type Outcome =
  | { readonly kind: "signed-out" }
  | { readonly kind: "unchanged"; readonly cached: KeteSyncCache.Cached; readonly skills: KeteSyncSkills.Result }
  | {
      readonly kind: "updated"
      readonly cached: KeteSyncCache.Cached
      readonly changes: Changes
      readonly skills: KeteSyncSkills.Result
    }
  /** The cache (if any) is untouched and still in use. */
  | { readonly kind: "failed"; readonly error: Error; readonly cached: KeteSyncCache.Cached | undefined }

/**
 * The cached agents for the signed-in account, without a network request; undefined when signed out or
 * never synced. With a credential the account is not read (`account` is absent) and the cache is the
 * credential's organization's; undefined when it names none.
 */
export async function load(options: Pick<Options, keyof KeteAccount.Options | "credential">): Promise<
  { readonly account?: KeteAccount.Account; readonly cached: KeteSyncCache.Cached } | undefined
> {
  if (options.credential) {
    if (!options.credential.organization) return undefined
    const cached = await KeteSyncCache.read(options.config, options.credential.organization)
    return cached && { cached }
  }
  const account = await KeteAccount.read(options)
  if (!account) return undefined
  const cached = await KeteSyncCache.read(options.config, account.organization.id)
  return cached && { account, cached }
}

export async function sync(options: Options): Promise<Outcome> {
  let account: KeteAccount.Account | undefined
  if (!options.credential) {
    account = await KeteAccount.read(options)
    if (!account) return { kind: "signed-out" }
  }
  const organization = options.credential ? options.credential.organization : account?.organization.id
  // An unreadable cache is treated as absent: the fetch then runs without If-None-Match, and a 200
  // replaces the broken file. load() (what the runtime serves agents from) reports it instead.
  const cached = organization ? await KeteSyncCache.read(options.config, organization).catch(() => undefined) : undefined
  const outcome = await attempt(options, account, organization, cached).catch(
    (error: unknown): Outcome => ({ kind: "failed", error: error instanceof Error ? error : new Error(String(error)), cached }),
  )
  return outcome
}

async function source(options: Options, account: KeteAccount.Account | undefined): Promise<Source> {
  if (options.credential)
    return { platform: options.credential.platform, key: options.credential.key, organization: options.credential.organization, kind: "job" }
  if (!account) throw new Error("No account to sync with")
  const key = await KeteAccount.key(options, account)
  if (key === undefined) throw new Error(`The account key is missing from ${KeteAccount.store(options, account.storage).description}. Run \`kete login\` again.`)
  return { platform: account.platform_url, key, organization: account.organization.id, kind: "account" }
}

async function attempt(
  options: Options,
  account: KeteAccount.Account | undefined,
  organization: string | undefined,
  cached: KeteSyncCache.Cached | undefined,
): Promise<Outcome> {
  const { platform, key, kind } = await source(options, account)
  const fetched = await KeteSyncClient.fetchAgents({
    platform,
    key,
    credential: kind,
    // A version-1 cache predates `delegable` (cache.ts): its ETag was earned by a response that
    // never had the field, so sending it back risks a 304 that leaves `delegable` missing forever.
    // Fetch fresh instead; the new copy is written at version 2.
    etag: cached?.version === 2 ? cached.etag : undefined,
    fetch: options.fetch,
  })
  // Skill files are brought in line on a 304 too, so a download that failed earlier is retried.
  const skills = (response: KeteSyncCache.Cached["response"]) =>
    KeteSyncSkills.sync({
      config: options.config,
      organization: response.organization.id,
      platform,
      key,
      skills: response.skills ?? [],
      fetch: options.fetch,
    })
  if (fetched.kind === "unchanged") {
    if (!cached) throw new Error("The platform answered 304 Not Modified without a cached copy")
    return { kind: "unchanged", cached, skills: await skills(cached.response) }
  }
  const next: KeteSyncCache.Cached = {
    version: 2,
    etag: fetched.etag,
    synced_at: (options.now?.() ?? new Date()).toISOString(),
    response: fetched.response,
  }
  await KeteSyncCache.write(options.config, next)
  // A different organization than the account's (the key was re-issued elsewhere): drop the old one's copy.
  if (organization && fetched.response.organization.id.toLowerCase() !== organization.toLowerCase())
    await KeteSyncCache.remove(options.config, organization)
  return { kind: "updated", cached: next, changes: diff(cached, next), skills: await skills(next.response) }
}

export function diff(before: KeteSyncCache.Cached | undefined, after: KeteSyncCache.Cached): Changes {
  const old = new Map((before?.response.agents ?? []).map((agent) => [agent.slug, agent.version]))
  const now = new Map(after.response.agents.map((agent) => [agent.slug, agent.version]))
  return {
    added: [...now.keys()].filter((slug) => !old.has(slug)),
    updated: [...now].filter(([slug, version]) => old.has(slug) && old.get(slug) !== version).map(([slug]) => slug),
    removed: [...old.keys()].filter((slug) => !now.has(slug)),
  }
}

export * as KeteSync from "./sync.js"
