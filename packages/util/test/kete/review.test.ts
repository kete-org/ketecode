// Pull request review (jobs-v1 "Pull request review"; review.json vector): the claim's
// `spec.review` is accepted, the result's `review` validates, every review the platform refuses is
// refused, and the record round-trips.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
import { KeteReview } from "../../src/kete/review.js"
import { KeteJobSecrets } from "../../src/kete/job-secrets.js"

const vector = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, "..", "..", "..", "kete-job-entrypoint", "internal", "fakeplatform", "testdata", "jobs-v1", "review.json"),
    "utf8",
  ),
)
const spec = vector.response.spec.review

describe("KeteReview.parseSpec", () => {
  test("accepts the vector's spec.review", () => {
    const parsed = KeteReview.parseSpec(spec)
    expect(parsed).toEqual({ ok: true, spec })
  })

  test("refuses what the contract refuses, naming the field", () => {
    const cases: Array<[unknown, string]> = [
      [null, "review"],
      [{ ...spec, extra: 1 }, "review.(unknown or missing field)"],
      [Object.fromEntries(Object.entries(spec).filter(([k]) => k !== "untrusted")), "review.(unknown or missing field)"],
      [{ ...spec, version: 2 }, "review.version"],
      [{ ...spec, pull_number: 0 }, "review.pull_number"],
      [{ ...spec, pull_number: 1.5 }, "review.pull_number"],
      [{ ...spec, head_sha: "A".repeat(40) }, "review.head_sha"],
      [{ ...spec, base_ref: "../main" }, "review.base_ref"],
      [{ ...spec, head_ref: "refs/pull/43/head" }, "review.head_ref"],
      [{ ...spec, head_ref: "refs/heads/main" }, "review.head_ref"],
      [{ ...spec, untrusted: "yes" }, "review.untrusted"],
      [{ ...spec, max_findings: 0 }, "review.max_findings"],
      [{ ...spec, max_findings: 51 }, "review.max_findings"],
    ]
    for (const [value, field] of cases) expect(KeteReview.parseSpec(value)).toEqual({ ok: false, field })
  })
})

describe("KeteReview.parseOutput", () => {
  test("the vector's result.review is valid", () => {
    const parsed = KeteReview.parseOutput(vector.result.review, spec.max_findings)
    expect(parsed.ok).toBe(true)
  })

  test("every review the platform refuses is refused", () => {
    expect(vector.invalid_reviews.length).toBeGreaterThan(0)
    for (const review of vector.invalid_reviews) {
      const parsed = KeteReview.parseOutput(review)
      expect({ review, ok: parsed.ok }).toEqual({ review, ok: false })
    }
  })

  test("missing, too large, and over the spec's max_findings", () => {
    expect(KeteReview.parseOutput(undefined)).toMatchObject({ ok: false, reason: "missing" })
    const finding = { path: "a.ts", line: 1, severity: "info", body: "x".repeat(KeteReview.bodyMaxChars) }
    const big = { version: 1, summary: "s", findings: Array.from({ length: 40 }, () => finding) }
    expect(KeteReview.parseOutput(big)).toMatchObject({ ok: false, reason: "too_large" })
    const three = { version: 1, summary: "s", findings: [finding, finding, finding].map((f) => ({ ...f, body: "b" })) }
    expect(KeteReview.parseOutput(three, 3).ok).toBe(true)
    expect(KeteReview.parseOutput(three, 2)).toMatchObject({ ok: false, reason: "invalid" })
  })

  test("path rules match the contract", () => {
    for (const bad of ["", "/abs", "a//b", "a/./b", "a/../b", "a\\b", "a\u0007b", "x".repeat(1025)])
      expect({ bad, ok: KeteReview.validPath(bad) }).toEqual({ bad, ok: false })
    for (const good of ["a.ts", "src/deep/file.go", ".github/workflows/ci.yml", "dir/..hidden"])
      expect({ good, ok: KeteReview.validPath(good) }).toEqual({ good, ok: true })
  })

  test("issues name the field and never quote a value", () => {
    const parsed = KeteReview.parseOutput({ version: 1, summary: "x", findings: [{ path: "../secret-path", line: 0, severity: "blocker", body: "" }] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const text = parsed.issues.join("\n")
    expect(text).toContain("findings[0].path")
    expect(text).toContain("findings[0].line")
    expect(text).toContain("findings[0].severity")
    expect(text).toContain("findings[0].body")
    expect(text).not.toContain("secret-path")
    expect(text).not.toContain("blocker")
  })
})

describe("KeteReview record", () => {
  test("round-trips, is private, and is checked again on read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kete-review-"))
    try {
      expect(await KeteReview.readRecord(dir)).toEqual({ kind: "none" })
      await KeteReview.writeRecord(dir, vector.result.review)
      expect(await KeteReview.readRecord(dir, 50)).toEqual({ kind: "ok", review: vector.result.review })
      expect((await KeteReview.readRecord(dir, 1)).kind).toBe("invalid")
      await writeFile(KeteReview.recordPath(dir), "{not json")
      expect(await KeteReview.readRecord(dir)).toEqual({ kind: "invalid", reason: "the review record is not JSON" })
      await KeteReview.removeRecord(dir)
      expect(await KeteReview.readRecord(dir)).toEqual({ kind: "none" })
      await writeFile(path.join(dir, "big"), "x".repeat(3 * KeteReview.maxBytes))
      await symlink(path.join(dir, "big"), KeteReview.recordPath(dir))
      expect(await KeteReview.readRecord(dir)).toEqual({ kind: "invalid", reason: "the review record is too large" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("KeteJobSecrets review overlay", () => {
  test("validates, then is write-once", () => {
    expect(KeteJobSecrets.review()).toBeUndefined()
    expect(() => KeteJobSecrets.setReview({ ...spec, max_findings: 99 })).toThrow("review.max_findings")
    expect(KeteJobSecrets.review()).toBeUndefined()
    KeteJobSecrets.setReview(spec)
    expect(KeteJobSecrets.review()).toEqual(spec)
    expect(() => KeteJobSecrets.setReview(spec)).toThrow("already set")
  })
})
