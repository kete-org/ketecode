// The folder-trust question (kete/folder-trust.ts): a session-less form (`"global"` owner, kind
// `kete.folder.trust`) listing exactly what is held back. The description is plain text: every item
// and the folder's path pass through util/src/kete/folder-trust.ts `safe` (control, format, bidi and
// zero-width characters escaped), so nothing can hide or reorder text. It is bounded in length; when an
// item, the list or the whole text had to be cut short, the person hasn't seen everything, so the form
// offers "Not now" only and says how to review it all (`trustable`). A folder that can't be trusted
// (home, the filesystem root, too many files to check) gets "Not now" only too, with the reason.

export * as KeteFolderTrustForm from "./form.js"

import { Brand } from "@opencode/util/kete/brand"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import type { Form } from "../../form.js"

export const SESSION = "global"
export const FIELD = "decision"
export const MAX_ITEMS = 40
/** Characters of one item shown. */
export const MAX_ITEM = 600
export const MAX_DESCRIPTION = 8_000

export type Decision = "trust" | "later"

export interface Input {
  readonly root: string
  readonly items: ReadonlyArray<string>
  /** Why this folder can't be trusted, when it can't. */
  readonly refusal?: string
}

const HEAD = (root: string) =>
  `The project configuration in ${KeteFolderTrustRules.shown(root)} can run code on this machine or send data elsewhere. Until you trust this folder, ${Brand.displayName} holds back:`

/** Whether everything held back fits in the question as shown (nothing cut short). */
export function trustable(input: Input): boolean {
  if (input.items.length > MAX_ITEMS) return false
  const items = input.items.map(KeteFolderTrustRules.safe)
  if (items.some((item) => item.length > MAX_ITEM)) return false
  return `${HEAD(input.root)}\n\n${items.map((item) => `- ${item}`).join("\n")}`.length <= MAX_DESCRIPTION - 600
}

export function description(input: Input): string {
  const items = input.items.map(KeteFolderTrustRules.safe)
  const shown = items.slice(0, MAX_ITEMS).map((item) => `- ${item.length > MAX_ITEM ? `${item.slice(0, MAX_ITEM)}…` : item}`)
  const more = items.length > MAX_ITEMS ? [`- …and ${items.length - MAX_ITEMS} more`] : []
  const tail = input.refusal
    ? `This folder can't be trusted: ${KeteFolderTrustRules.safe(input.refusal)}.`
    : !trustable(input)
      ? `Some of it is too long to show here in full, so it can't be trusted from this question. Review the project configuration, then trust the folder with \`${Brand.cliName} trust add\` in a terminal, which shows everything.`
      : "Trust it only if you trust whoever wrote this repository. You'll be asked again if these settings change. Its other settings (instructions, agents, commands, local skills) load either way."
  const body = `${HEAD(input.root)}\n\n${[...shown, ...more].join("\n")}`
  const room = MAX_DESCRIPTION - tail.length - 3
  return `${body.length > room ? `${body.slice(0, room)}…` : body}\n\n${tail}`
}

export function create(input: Input): Form.CreateInput {
  return {
    sessionID: SESSION,
    title: input.refusal || !trustable(input) ? "This folder's settings are held back" : "Trust this folder?",
    metadata: { kind: KeteFolderTrustRules.FORM_KIND, root: input.root },
    fields: [
      {
        key: FIELD,
        type: "string",
        title: "Project configuration",
        description: description(input),
        required: true,
        options: [
          ...(input.refusal || !trustable(input) ? [] : [{ value: "trust", label: "Trust this folder" }]),
          { value: "later", label: "Not now", description: "Keep holding these back until Kete Code restarts" },
        ],
      },
    ],
  }
}

/** The answer: only an explicit "trust" trusts; anything else (Not now, cancelled) is "later". */
export function decision(state: Form.TerminalState): Decision {
  return state.status === "answered" && state.answer[FIELD] === "trust" ? "trust" : "later"
}
