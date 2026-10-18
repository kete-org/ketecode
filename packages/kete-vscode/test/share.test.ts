import { describe, expect, test } from "bun:test"
import { parsePreview, parseShare, parseUnshare, previewRequest, previewText, refusalText, rpcUrl, shareRequest, unshareRequest } from "../src/share"

const output = {
  counts: { messages: 4, tools: 3, diffs: 2 },
  bytes: 2048,
  redactions: 2,
  truncated: false,
  visibility: "org",
  linkAllowed: true,
  maxDays: 30,
}

describe("session share requests", () => {
  test("the RPC url carries the directory, the bodies carry only what is needed", () => {
    expect(rpcUrl("http://127.0.0.1:4096", "preview", "/work/my app")).toBe("http://127.0.0.1:4096/api/rpc/kete.share/preview?directory=%2Fwork%2Fmy%20app")
    expect(previewRequest("ses_1")).toEqual({ input: { sessionID: "ses_1" } })
    expect(shareRequest("ses_1", "link")).toEqual({ input: { sessionID: "ses_1", visibility: "link" } })
    expect(shareRequest("ses_1", "org", "abc")).toEqual({ input: { sessionID: "ses_1", visibility: "org", digest: "abc" } })
    expect(unshareRequest("ses_1")).toEqual({ input: { sessionID: "ses_1" } })
  })
})

describe("session share answers", () => {
  test("a preview becomes the modal text: what is sent, what is not, who reads it, expiry", () => {
    const parsed = parsePreview({ output })
    expect(parsed && "ok" in parsed).toBe(true)
    if (!parsed || !("ok" in parsed)) return
    const text = previewText(parsed.ok)
    expect(text).toContain("Members of your organization can read this session.")
    expect(text).toContain("4 messages, 3 tool calls, 2 changed files (2 KB).")
    expect(text).toContain("Secrets removed: 2.")
    expect(text).toContain("Not sent: reasoning")
    expect(text).toContain("expires in 30 days")
    expect(text).not.toContain("left out")
    expect(previewText(parsed.ok, "link")).toContain("Anyone with the link")
    expect(previewText({ ...parsed.ok, truncated: true, existing: true })).toContain("updates the same share")
  })

  test("a refusal carries its message; the text names it", () => {
    const parsed = parsePreview({ output: { ...output, refusal: { kind: "org_disabled", message: "Your organization has turned session sharing off." } } })
    expect(parsed).toEqual({ refusal: "Your organization has turned session sharing off." })
    expect(refusalText("Offline.")).toBe("Kete Code can't share this session: Offline.")
    expect(parseShare({ output: { refusal: { kind: "failed", message: "later (request r1)" } } })).toEqual({ refusal: "later (request r1)" })
    expect(parseUnshare({ output: { refusal: { kind: "signed_out", message: "Sign in" } } })).toEqual({ refusal: "Sign in" })
  })

  test("share and unshare answers", () => {
    expect(parseShare({ output: { record: { url: "https://portal.example/s/T", expires_at: "2026-11-17T00:00:00Z" } } })).toEqual({
      ok: { url: "https://portal.example/s/T", expiresAt: "2026-11-17T00:00:00Z" },
    })
    expect(parseUnshare({ output: { removed: true } })).toEqual({ ok: { removed: true } })
    expect(parseUnshare({ output: { removed: false } })).toEqual({ ok: { removed: false } })
  })

  test("anything else is not an answer", () => {
    for (const bad of [undefined, null, "x", {}, { output: "x" }, { output: { counts: {} } }, { output: { ...output, visibility: "everyone" } }, { output: { ...output, bytes: -1 } }])
      expect(parsePreview(bad)).toBeUndefined()
    expect(parseShare({ output: { record: { url: 5 } } })).toBeUndefined()
    expect(parseUnshare({ output: {} })).toBeUndefined()
  })
})
