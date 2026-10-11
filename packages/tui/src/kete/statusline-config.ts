// The configurable status line's setting (docs/statusline.md): which items the prompt's footer row
// shows, in what order, and whether they are coloured. Lives in the TUI config (`cli.json`).
//
// `items` is deliberately a plain string array, not a union of item IDs: the CLI decodes the whole
// config file at once, so one invalid value would silently drop every setting in it. Unknown IDs are
// found by `parse` and reported to the user instead.

import { Schema } from "effect"

export const ITEMS = [
  "directory",
  "branch",
  "mode",
  "context",
  "model",
  "sandbox",
  "balance",
  "todo",
  "local-model",
  "cost",
] as const
export type ItemID = (typeof ITEMS)[number]

export const DEFAULT_ITEMS: ReadonlyArray<ItemID> = ["directory", "branch", "mode", "context"]

export const labels: Readonly<Record<ItemID, string>> = {
  directory: "Directory",
  branch: "Git branch",
  mode: "Permission mode",
  context: "Context left",
  model: "Model",
  sandbox: "Sandbox warning",
  balance: "Credit balance",
  todo: "Todo progress",
  "local-model": "Offline indicator",
  cost: "Session cost",
}

export const descriptions: Readonly<Record<ItemID, string>> = {
  directory: "Working directory",
  branch: "Current git branch",
  mode: "Default, Plan, Ask or Auto",
  context: "Share of the context window still free",
  model: "Model and reasoning variant",
  sandbox: "Warns when commands run without the OS sandbox (always shown when it applies)",
  balance: "Kete credit balance",
  todo: "Progress of the session task list",
  "local-model": "Shown while offline mode is on",
  cost: "Spend so far in this session",
}

export const KeteStatusLineConfig = Schema.Struct({
  items: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: `Status line items in display order. Known items: ${ITEMS.join(", ")}`,
  }),
  colors: Schema.optional(Schema.Boolean).annotate({ description: "Colour the status line items" }),
}).annotate({ description: "Status line shown under the prompt" })

export type Parsed = {
  /** Known item IDs, in order, without duplicates. */
  items: ReadonlyArray<ItemID>
  /** IDs in the config that are not items. They are reported, never dropped silently. */
  unknown: ReadonlyArray<string>
  colors: boolean
}

const known = (value: string): value is ItemID => (ITEMS as ReadonlyArray<string>).includes(value)

export function parse(value: { readonly items?: ReadonlyArray<string>; readonly colors?: boolean } | undefined): Parsed {
  const colors = value?.colors ?? true
  if (value?.items === undefined) return { items: DEFAULT_ITEMS, unknown: [], colors }
  const items: ItemID[] = []
  const unknown: string[] = []
  for (const id of value.items) {
    if (!known(id)) {
      if (!unknown.includes(id)) unknown.push(id)
    } else if (!items.includes(id)) items.push(id)
  }
  return { items, unknown, colors }
}

/** Adds `id` at the end, or removes it when it is already listed. */
export function toggle(items: ReadonlyArray<ItemID>, id: ItemID): ItemID[] {
  return items.includes(id) ? items.filter((item) => item !== id) : [...items, id]
}

/** Moves `id` by `delta` places (negative is earlier); stays put at either end. */
export function move(items: ReadonlyArray<ItemID>, id: ItemID, delta: number): ItemID[] {
  const from = items.indexOf(id)
  if (from < 0) return [...items]
  const to = Math.min(items.length - 1, Math.max(0, from + delta))
  const next = [...items]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

export function reset(): ItemID[] {
  return [...DEFAULT_ITEMS]
}

/**
 * A config update for the `statusline` key only. Unknown IDs already in the file are kept after the
 * known ones, so editing the list in the picker never deletes something the user wrote.
 */
export function save(items: ReadonlyArray<ItemID>, colors: boolean) {
  return (draft: { statusline?: { items?: ReadonlyArray<string>; colors?: boolean } }) => {
    const unknown = parse(draft.statusline).unknown
    draft.statusline = { ...draft.statusline, items: [...items, ...unknown], colors }
  }
}
