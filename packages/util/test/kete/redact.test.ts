import { describe, expect, test } from "bun:test"
import { KeteRedact } from "../../src/kete/redact.js"

describe("KeteRedact.text", () => {
  test("masks an OpenAI/Anthropic-style API key", () => {
    expect(KeteRedact.text("key: sk-ant-abcdefghijklmnopqrstuvwx0123")).toBe("key: [REDACTED]")
  })

  test("masks a bearer token", () => {
    expect(KeteRedact.text("Authorization header sent Bearer abc123.def456")).toBe(
      "Authorization header sent Bearer [REDACTED]",
    )
  })

  test("masks an Authorization: value even without the word Bearer", () => {
    expect(KeteRedact.text("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [REDACTED]")
  })

  test("masks a PEM private-key block with an END line", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----"
    expect(KeteRedact.text(`before ${pem} after`)).toBe("before [REDACTED PRIVATE KEY] after")
  })

  test("masks a PEM private-key block with no END line, to the end of the string", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJ..."
    expect(KeteRedact.text(`prefix ${pem}`)).toBe("prefix [REDACTED PRIVATE KEY]")
  })

  test("masks NAME=value for a secret-looking name", () => {
    expect(KeteRedact.text("PASSWORD=hunter2 NEXT=ok")).toBe("PASSWORD=[REDACTED] NEXT=ok")
  })

  test("masks NAME: value for a secret-looking name", () => {
    expect(KeteRedact.text("api_key: abcdef123456")).toBe("api_key: [REDACTED]")
  })

  test("masks common pass abbreviations delimited by an underscore", () => {
    expect(KeteRedact.text("DB_PASS=hunter2")).toBe("DB_PASS=[REDACTED]")
    expect(KeteRedact.text("APP_PASS=hunter2")).toBe("APP_PASS=[REDACTED]")
    expect(KeteRedact.text("MYSQL_PASS=hunter2")).toBe("MYSQL_PASS=[REDACTED]")
    expect(KeteRedact.text('"db_pass": "hunter2"')).toBe('"db_pass": "[REDACTED]"')
  })

  test("does not treat pass as a substring of an ordinary word", () => {
    const text = "the passage described a clever bypass of the gate"
    expect(KeteRedact.text(text)).toBe(text)
  })

  test("masks credentials in a URL, keeping scheme and host", () => {
    expect(KeteRedact.text("clone https://user:hunter2@example.com/repo.git")).toBe(
      "clone https://[REDACTED]@example.com/repo.git",
    )
  })

  test("leaves ordinary text unchanged", () => {
    const text = "ran `bun test` in packages/core and it passed"
    expect(KeteRedact.text(text)).toBe(text)
  })
})

describe("KeteRedact.deep", () => {
  test("redacts every string, including nested ones", () => {
    const input = { message: "token sk-ant-abcdefghijklmnopqrstuvwx0123 in body", nested: { note: "PASSWORD=hunter2" } }
    expect(KeteRedact.deep(input)).toEqual({
      message: "token [REDACTED] in body",
      nested: { note: "PASSWORD=[REDACTED]" },
    })
  })

  test("replaces the whole value under a secret-looking key, whatever its type", () => {
    expect(KeteRedact.deep({ apiKey: { nested: "value" }, count: 3 })).toEqual({ apiKey: "[REDACTED]", count: 3 })
  })

  test("walks arrays", () => {
    expect(KeteRedact.deep(["ok", "PASSWORD=hunter2"])).toEqual(["ok", "PASSWORD=[REDACTED]"])
  })

  test("replaces the whole value under a DB_PASS-style key, but not a plain 'passage' key", () => {
    expect(KeteRedact.deep({ DB_PASS: "hunter2", passage: "a corridor" })).toEqual({
      DB_PASS: "[REDACTED]",
      passage: "a corridor",
    })
  })
})

describe("KeteRedact.isSecretKey", () => {
  test("matches delimited pass abbreviations", () => {
    expect(KeteRedact.isSecretKey("DB_PASS")).toBe(true)
    expect(KeteRedact.isSecretKey("app_pass")).toBe(true)
    expect(KeteRedact.isSecretKey("mysql_pass")).toBe(true)
  })

  test("does not match pass as a substring of an ordinary word", () => {
    expect(KeteRedact.isSecretKey("passage")).toBe(false)
    expect(KeteRedact.isSecretKey("bypass")).toBe(false)
  })
})

describe("KeteRedact.truncate", () => {
  test("returns the input unchanged when already within bounds", () => {
    expect(KeteRedact.truncate("hello", 10)).toBe("hello")
  })

  test("cuts on a UTF-8 boundary rather than splitting a multi-byte character", () => {
    const text = "a".repeat(9) + "é" // 9 ascii bytes + a 2-byte character
    const cut = KeteRedact.truncate(text, 10)
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(10)
    // The 2-byte character must not be split: the result is valid UTF-8 with no replacement character.
    expect(cut).not.toContain("�")
  })

  test("redacting before truncating never exposes half a secret", () => {
    const input = "prefix sk-ant-abcdefghijklmnopqrstuvwx0123 suffix"
    const redacted = KeteRedact.text(input)
    const truncated = KeteRedact.truncate(redacted, 20)
    expect(truncated).not.toMatch(/sk-ant-[a-z]/)
  })
})
