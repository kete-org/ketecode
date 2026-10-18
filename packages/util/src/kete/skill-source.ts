// Where a skill installed with `kete skill add` comes from (cli/src/kete/skill-flow.ts): a git
// repository or a local folder. A third kind (the skills marketplace) can be added to `Source`
// without reshaping `add`. Credentials in a URL (`https://user:token@host/…`) are never printed,
// stored or used as the policy resource: `display` and `policyResource` strip them.

import { stat } from "node:fs/promises"
import path from "node:path"

export type Source =
  | { readonly kind: "git"; readonly url: string }
  | { readonly kind: "local"; readonly path: string }

export class SourceError extends Error {
  override readonly name = "SkillSource.SourceError"
}

const HOSTED = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/
const SCP = /^[\w.-]+@[\w.-]+:[^\s]+$/
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
// Characters where WHATWG URL parsing and git/curl disagree (`https://github.com\@evil/x` is github.com to
// one and evil to the other), so the policy and the review could see another host than git fetches.
const UNSAFE = /[\\%?#\s\x00-\x1f\x7f]/

export const validName = (name: string) => NAME.test(name)

/** A git URL, `owner/repo` (GitHub), or an existing local folder; throws SourceError otherwise. */
export async function parse(input: string, cwd: string): Promise<Source> {
  const text = input.trim()
  if (text === "" || text.startsWith("-")) throw new SourceError("the source must be a git URL, owner/repo, or a folder")
  if (/^(https|ssh):\/\//i.test(text) || SCP.test(text)) return { kind: "git", url: gitUrl(text) }
  const folder = path.resolve(cwd, text)
  const found = await stat(folder).catch(() => undefined)
  if (found?.isDirectory()) return { kind: "local", path: folder }
  if (found) throw new SourceError(`${folder} is not a folder`)
  if (HOSTED.test(text)) return { kind: "git", url: `https://github.com/${text}` }
  throw new SourceError(`${text} is not a git URL, owner/repo, or an existing folder`)
}

/**
 * A git URL in the one form git, the policy and the review all read the same way: `https://` or `ssh://`
 * (normalized by WHATWG URL) or `user@host:path`. Throws SourceError for anything else, including a lockfile
 * source someone edited to `ext::…` or `foo::…`.
 */
export function gitUrl(text: string): string {
  if (UNSAFE.test(text)) throw new SourceError("the source URL has a character that isn't allowed (\\ % ? # a space or a control character)")
  if (text.split(/[/:]/).some((segment) => segment === "." || segment === ".."))
    throw new SourceError("the source URL can't contain . or .. segments")
  if (/^(https|ssh):\/\//i.test(text)) {
    if (!URL.canParse(text)) throw new SourceError("the source URL is not valid")
    return new URL(text).href
  }
  if (SCP.test(text) && !text.startsWith("-")) return text
  throw new SourceError("the source must be an https://, ssh:// or user@host:path git URL")
}

function strip(url: string) {
  if (!/^[a-z]+:\/\//i.test(url) || !URL.canParse(url)) return url
  const parsed = new URL(url)
  parsed.username = ""
  parsed.password = ""
  return parsed.toString()
}

/** The source as shown or stored: no credentials. */
export const display = (source: Source) => (source.kind === "git" ? strip(source.url) : source.path)

const HOST_ALIASES: Record<string, string> = { "www.github.com": "github.com", "www.gitlab.com": "gitlab.com", "www.bitbucket.org": "bitbucket.org" }

/**
 * `host/path` for a git source (`github.com/acme/skills`), the folder's absolute path for a local one.
 * Lower-case throughout (GitHub-style hosts ignore case in owner and repo names, so a deny on
 * `github.com/evil/*` must also catch `Evil/repo`), with `www.` aliases of the big hosts folded.
 */
export function policyResource(source: Source) {
  if (source.kind === "local") return source.path
  const clean = (value: string) => value.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()
  const host = (value: string) => HOST_ALIASES[value.toLowerCase()] ?? value.toLowerCase()
  if (!/^[a-z]+:\/\//i.test(source.url)) {
    const [, name = "", rest = ""] = /^[^@]+@([^:]+):(.*)$/.exec(source.url) ?? []
    return `${host(name)}/${clean(rest)}`
  }
  const parsed = new URL(source.url)
  return `${host(parsed.hostname)}/${clean(parsed.pathname)}`
}

/** A full commit id (SHA-1 or SHA-256): it can't move, so `update` has nothing to do. */
export const pinned = (ref: string | undefined) => ref !== undefined && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(ref)

const SAFE_LANGUAGES = new Set(["", "yaml", "yml"])
const FRONT = /^﻿?---([^\r\n]*)\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/

/**
 * SKILL.md front matter, with core's rules (core/src/config/markdown.ts; the CLI can't import core):
 * YAML only (a `---js` block is refused, GHSA-m7hc-g593-r9wg), `name` and `description` optional strings.
 * Keep in step with core. shortcut: no retry for unquoted colons like core's `sanitize`, add it if users
 * report valid skills rejected.
 */
export function frontmatter(text: string): { readonly name?: string; readonly description?: string } {
  if (!/^﻿?---/.test(text)) return {}
  const match = FRONT.exec(text)
  if (!match) throw new SourceError("SKILL.md front matter is not closed")
  const language = match[1]!.trim().toLowerCase()
  if (!SAFE_LANGUAGES.has(language)) throw new SourceError(`SKILL.md front matter must be YAML, not "${language}"`)
  let data: unknown
  try {
    data = Bun.YAML.parse(match[2] ?? "")
  } catch {
    throw new SourceError("SKILL.md front matter is not valid YAML")
  }
  if (data === null || data === undefined) return {}
  if (typeof data !== "object" || Array.isArray(data)) throw new SourceError("SKILL.md front matter must be a mapping")
  const record = data as Record<string, unknown>
  for (const key of ["name", "description"])
    if (record[key] !== undefined && typeof record[key] !== "string")
      throw new SourceError(`SKILL.md front matter ${key} must be a string`)
  return { name: record.name as string | undefined, description: record.description as string | undefined }
}

export * as KeteSkillSource from "./skill-source.js"
