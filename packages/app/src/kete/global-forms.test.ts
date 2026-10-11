// Session-less forms in the web UI (global-forms.ts, AC9): the folder-trust question is shown first,
// its choices come from the form, and Trust / Not now reply for the current location.
import { describe, expect, test } from "bun:test"
import type { FormInfo, LocationRef, SessionFormCancelInput, SessionFormReplyInput } from "@opencode/client/promise"
import { choose, dismiss, pick, view, type Actions } from "./global-forms"

const trustForm = {
  id: "frm_trust",
  sessionID: "global",
  title: "Trust this folder?",
  metadata: { kind: "kete.folder.trust", root: "/repo" },
  fields: [
    {
      key: "decision",
      type: "string",
      title: "Project configuration",
      description: 'Until you trust this folder, Kete Code holds back:\n\n- MCP server "tools": runs ["node","./mcp.js"]\n- <b>not markup</b>',
      required: true,
      options: [
        { value: "trust", label: "Trust this folder" },
        { value: "later", label: "Not now" },
      ],
    },
  ],
} as unknown as FormInfo

const elicitation = {
  id: "frm_mcp",
  sessionID: "global",
  title: "Server asks for a token",
  fields: [{ key: "token", type: "string", title: "Token" }],
} as unknown as FormInfo

function recorder() {
  const calls: Array<{ kind: "reply" | "cancel"; input: SessionFormReplyInput | SessionFormCancelInput; ref?: LocationRef }> = []
  const actions: Actions = {
    reply: async (input, ref) => void calls.push({ kind: "reply", input, ref }),
    cancel: async (input, ref) => void calls.push({ kind: "cancel", input, ref }),
  }
  return { calls, actions }
}

describe("global forms", () => {
  test("the folder-trust question is shown first", () => {
    expect(pick([elicitation, trustForm])?.id).toBe("frm_trust")
    expect(pick([elicitation])?.id).toBe("frm_mcp")
    expect(pick([])).toBeUndefined()
    expect(pick(undefined)).toBeUndefined()
  })

  test("a session-less trust form renders as a choice, its text kept as text", () => {
    const shown = view(trustForm)
    expect(shown.trust).toBe(true)
    expect(shown.field).toBe("decision")
    expect(shown.choices.map((choice) => choice.value)).toEqual(["trust", "later"])
    expect(shown.description).toContain("<b>not markup</b>")
  })

  test("Trust replies with the location", async () => {
    const { calls, actions } = recorder()
    await choose(actions, trustForm, "trust", { directory: "/repo" })
    expect(calls).toEqual([
      { kind: "reply", input: { sessionID: "global", formID: "frm_trust", answer: { decision: "trust" } }, ref: { directory: "/repo" } },
    ])
  })

  test("a choice the form doesn't offer is refused", async () => {
    const { calls, actions } = recorder()
    await expect(choose(actions, trustForm, "everything", { directory: "/repo" })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test("a form that can't be answered here can be dismissed, for the location", async () => {
    expect(view(elicitation).field).toBeUndefined()
    expect(view(elicitation).choices).toEqual([])
    const { calls, actions } = recorder()
    await expect(choose(actions, elicitation, "x", { directory: "/repo" })).rejects.toThrow()
    await dismiss(actions, elicitation, { directory: "/repo" })
    expect(calls).toEqual([{ kind: "cancel", input: { sessionID: "global", formID: "frm_mcp" }, ref: { directory: "/repo" } }])
  })
})
