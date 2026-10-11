// Prompt history search (Ctrl+R, docs/history-search.md): the pure parts, testable without the app.
//
// - `find` searches prompt history newest first: a case-insensitive substring match on the entry's text.
//   `skip` holds the texts this search has already shown, so repeated Ctrl+R never shows the same text twice.
// - `excerpt` turns a match into one line that fits the bar, with the matched span's offsets.
// - `keteHistorySearchKeys` keeps a user's own `session.rename` key working: if the user gave rename a key
//   and didn't set `prompt.history.search`, that key is removed from history search's default. Without
//   this, the search layer (targeted at the focused prompt) would beat the user's Ctrl+R rename.

import type { PromptInfo } from "../prompt/history"
import { stringWidth } from "../util/string-width"

/** The default key of `session.rename`. `<leader>r` stays `session.redo`'s, as upstream has it. */
export const RENAME_DEFAULT = "<leader>shift+r"
/** The default key of `prompt.history.search`. */
export const SEARCH_DEFAULT = "ctrl+r"

export type Match = {
  /** Index in `entries` (oldest first, as the history provider stores them). */
  readonly index: number
  readonly entry: PromptInfo
  /** The match's offsets in `entry.text` (UTF-16 code units). */
  readonly start: number
  readonly end: number
}

/**
 * The newest entry before `before` (an index in `entries`, exclusive; default: all) whose text contains
 * `query`, ignoring case, and whose text isn't in `skip`. An empty query matches nothing.
 */
export function find(
  entries: readonly PromptInfo[],
  query: string,
  before: number = entries.length,
  skip: ReadonlySet<string> = new Set(),
): Match | undefined {
  if (!query) return undefined
  const needle = query.toLowerCase()
  for (let index = Math.min(before, entries.length) - 1; index >= 0; index--) {
    const entry = entries[index]
    if (!entry || skip.has(entry.text)) continue
    const lower = entry.text.toLowerCase()
    const start = lower.indexOf(needle)
    if (start < 0) continue
    // Lower-casing changes the length of a few characters (e.g. "İ"); then the offsets don't map back, so
    // the whole text is the highlighted span.
    if (lower.length !== entry.text.length) return { index, entry, start: 0, end: entry.text.length }
    return { index, entry, start, end: start + needle.length }
  }
  return undefined
}

export type Excerpt = {
  readonly before: string
  readonly match: string
  readonly after: string
}

const NEWLINE = "⏎"
const ELLIPSIS = "…"

/**
 * One line of at most `width` terminal cells around `text[start, end)`: newlines are shown as `⏎`, and
 * text cut on either side is marked with `…`. The match itself is kept whole when it fits, else cut.
 */
export function excerpt(text: string, start: number, end: number, width: number): Excerpt {
  const flat = (value: string) => value.replace(/\r?\n/g, NEWLINE)
  let before = flat(text.slice(0, start))
  let match = flat(text.slice(start, end))
  let after = flat(text.slice(end))
  const max = Math.max(1, width)
  const size = (value: string) => stringWidth(value)

  if (size(match) >= max) return { before: "", match: cut(match, max - 1) + ELLIPSIS, after: "" }

  // Keep up to a third of the room for text before the match, the rest after it.
  let room = max - size(match)
  if (size(before) + size(after) <= room) return { before, match, after }
  const lead = Math.min(size(before), Math.max(Math.floor(room / 3), room - size(after)))
  if (size(before) > lead) before = lead <= 1 ? (lead === 1 ? ELLIPSIS : "") : ELLIPSIS + tail(before, lead - 1)
  room -= size(before)
  if (size(after) > room) after = room <= 1 ? (room === 1 ? ELLIPSIS : "") : cut(after, room - 1) + ELLIPSIS
  return { before, match, after }
}

/** The longest prefix of `value` that is at most `width` cells wide. */
function cut(value: string, width: number) {
  let result = ""
  for (const char of value) {
    if (stringWidth(result + char) > width) break
    result += char
  }
  return result
}

/** The longest suffix of `value` that is at most `width` cells wide. */
function tail(value: string, width: number) {
  let result = ""
  for (const char of Array.from(value).reverse()) {
    if (stringWidth(char + result) > width) break
    result = char + result
  }
  return result
}

/** One configured binding value (as `cli.json` `keybinds` allows it). */
type BindingValue = false | "none" | string | BindingItem | readonly (string | BindingItem)[]
type BindingItem = { readonly key?: unknown; readonly name?: unknown } & Record<string, unknown>

type Overrides = {
  readonly "session.rename"?: unknown
  readonly "prompt.history.search"?: unknown
}

/**
 * The `prompt.history.search` override `resolve()` applies: none when the user set search themselves or
 * didn't set rename; otherwise search's default minus every key the user gave rename (`"none"` when
 * nothing is left).
 */
export function keteHistorySearchKeys(overrides: Overrides): { "prompt.history.search"?: string } {
  if (overrides["prompt.history.search"] !== undefined) return {}
  if (overrides["session.rename"] === undefined) return {}
  const taken = new Set(keys(overrides["session.rename"] as BindingValue))
  const left = SEARCH_DEFAULT.split(",")
    .map((key) => key.trim())
    .filter((key) => !taken.has(key.toLowerCase()))
  if (left.length === SEARCH_DEFAULT.split(",").length) return {}
  return { "prompt.history.search": left.length ? left.join(",") : "none" }
}

/** The lower-cased key strings in a binding value. Key-stroke objects become `ctrl+shift+…+name`. */
function keys(value: BindingValue): string[] {
  if (value === false || value === "none") return []
  if (typeof value === "string")
    return value
      .split(",")
      .map((key) => key.trim().toLowerCase())
      .filter(Boolean)
  if (Array.isArray(value)) return value.flatMap((item) => keys(item as BindingValue))
  if (typeof value !== "object" || value === null) return []
  const item = value as BindingItem
  if (typeof item.key === "string" || (typeof item.key === "object" && item.key !== null))
    return keys(item.key as BindingValue)
  if (typeof item.name === "string") {
    const modifiers = (["ctrl", "meta", "super", "hyper", "shift"] as const).filter((name) => item[name] === true)
    return [[...modifiers, item.name].join("+").toLowerCase()]
  }
  return []
}
