import { expect, test } from "bun:test"
import { Brand } from "@opencode/util/kete/brand" // kete_change
import { epilogue } from "../../src/util/presentation"

const rows = (text: string | undefined) =>
  Bun.stripANSI(text ?? "")
    .split("\n")
    .filter((line) => line.trim() && !/[▀▄█]/.test(line))

test("prints nothing without a session or update", () => {
  expect(epilogue({})).toBeUndefined()
})

test("formats session continuation summary", () => {
  expect(rows(epilogue({ session: { title: "A session", sessionID: "ses_123" } }))).toEqual([
    "  Session   A session",
    `  Continue  ${Brand.cliName} -s ses_123`, // kete_change
  ])
})

test("tells the user to start OpenCode again after an update", () => {
  expect(rows(epilogue({ updatedVersion: "2.0.0" }))).toEqual([`  Run ${Brand.cliName} to use 2.0.0`] /* kete_change */)
})

test("keeps the session continuation after an update", () => {
  expect(rows(epilogue({ session: { title: "A session", sessionID: "ses_123" }, updatedVersion: "2.0.0" }))).toEqual([
    `  Run ${Brand.cliName} to use 2.0.0`, // kete_change
    "  Session   A session",
    `  Continue  ${Brand.cliName} -s ses_123`, // kete_change
  ])
})
