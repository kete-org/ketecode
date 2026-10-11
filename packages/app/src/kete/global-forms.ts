// Session-less questions in the web UI (and so the VS Code and JetBrains panels, which host this app):
// forms owned by the `"global"` sentinel instead of a session — the folder-trust question
// (`kete.folder.trust`, core/src/kete/folder-trust.ts) and MCP elicitations that can't be attributed
// to a session. Upstream's SessionQuestionDock answers through the session routes without a location,
// which for a `"global"` form would reach the server's default location, so global-form-dock.tsx renders
// them itself and replies through the data store with the location (`x-opencode-directory`).
//
// Only a single-choice question (a string field with options) is answerable here; any other form is
// shown with its title and can be dismissed. Text is rendered as text, never as markup.

import type { FormInfo, LocationRef, SessionFormCancelInput, SessionFormReplyInput } from "@opencode/client/promise"

export const OWNER = "global"
export const TRUST_KIND = "kete.folder.trust"

export interface Choice {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export interface View {
  readonly id: string
  readonly title: string
  readonly description?: string
  /** The field the choice answers; undefined when this form can only be dismissed here. */
  readonly field?: string
  readonly choices: ReadonlyArray<Choice>
  readonly trust: boolean
}

export interface Actions {
  readonly reply: (input: SessionFormReplyInput, ref?: LocationRef) => Promise<void>
  readonly cancel: (input: SessionFormCancelInput, ref?: LocationRef) => Promise<void>
}

/** How a global form is shown. */
export function view(form: FormInfo): View {
  const trust = form.metadata?.kind === TRUST_KIND
  const [first, ...rest] = form.fields
  const single =
    first !== undefined && rest.length === 0 && first.type === "string" && first.options !== undefined && first.options.length > 0
      ? first
      : undefined
  return {
    id: form.id,
    title: form.title,
    ...(first?.description ? { description: first.description } : {}),
    ...(single ? { field: single.key } : {}),
    choices: single?.type === "string" ? (single.options ?? []).map((option) => ({ ...option })) : [],
    trust,
  }
}

/** The form to show: the folder-trust question first, then the oldest. */
export function pick(forms: ReadonlyArray<FormInfo> | undefined): FormInfo | undefined {
  if (!forms || forms.length === 0) return undefined
  return forms.find((form) => form.metadata?.kind === TRUST_KIND) ?? forms[0]
}

/** Answers a global form with one choice, for this location. */
export function choose(actions: Actions, form: FormInfo, value: string, location: LocationRef): Promise<void> {
  const shown = view(form)
  if (shown.field === undefined || !shown.choices.some((choice) => choice.value === value))
    return Promise.reject(new Error("This question can't be answered here."))
  return actions.reply({ sessionID: OWNER, formID: form.id, answer: { [shown.field]: value } }, location)
}

/** Dismisses a global form for this location (for the trust question: "Not now"). */
export function dismiss(actions: Actions, form: FormInfo, location: LocationRef): Promise<void> {
  return actions.cancel({ sessionID: OWNER, formID: form.id }, location)
}
