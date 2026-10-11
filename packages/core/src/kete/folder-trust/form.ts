// The folder-trust question (kete/folder-trust.ts): a session-less form (`"global"` owner, kind
// `kete.folder.trust`) listing exactly what is held back. The description is plain text: every value
// in it was JSON-escaped by util/src/kete/folder-trust.ts `describe`/`describeRule`, so nothing can
// hide or reorder text, and it is bounded in length. A folder that can't be trusted (home, the
// filesystem root, too many files to check) gets "Not now" only, with the reason.

export * as KeteFolderTrustForm from "./form.js"

import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import type { Form } from "../../form.js"

export const SESSION = "global"
export const FIELD = "decision"
export const MAX_ITEMS = 40
export const MAX_DESCRIPTION = 8_000

export type Decision = "trust" | "later"

export interface Input {
  readonly root: string
  readonly items: ReadonlyArray<string>
  /** Why this folder can't be trusted, when it can't. */
  readonly refusal?: string
}

export function description(input: Input): string {
  const shown = input.items.slice(0, MAX_ITEMS).map((item) => `- ${item}`)
  const more = input.items.length > MAX_ITEMS ? [`- …and ${input.items.length - MAX_ITEMS} more`] : []
  const head = `The project configuration in ${JSON.stringify(input.root)} can run code on this machine or send data elsewhere. Until you trust this folder, Kete Code holds back:`
  const tail = input.refusal
    ? `This folder can't be trusted: ${input.refusal}.`
    : "Trust it only if you trust whoever wrote this repository. You'll be asked again if these settings change. Its other settings (instructions, agents, commands, skills) load either way."
  const text = `${head}\n\n${[...shown, ...more].join("\n")}\n\n${tail}`
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION)}…` : text
}

export function create(input: Input): Form.CreateInput {
  return {
    sessionID: SESSION,
    title: input.refusal ? "This folder's settings are held back" : "Trust this folder?",
    metadata: { kind: KeteFolderTrustRules.FORM_KIND, root: input.root },
    fields: [
      {
        key: FIELD,
        type: "string",
        title: "Project configuration",
        description: description(input),
        required: true,
        options: [
          ...(input.refusal ? [] : [{ value: "trust", label: "Trust this folder" }]),
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
