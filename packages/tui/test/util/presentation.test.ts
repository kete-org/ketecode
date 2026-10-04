import { expect, test } from "bun:test"
import { Brand } from "@opencode/util/kete/brand" // kete_change
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain(`${Brand.cliName} -s ses_123`) // kete_change
})
