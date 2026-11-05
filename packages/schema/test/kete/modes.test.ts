import { expect, test } from "bun:test"
import { Schema } from "effect"
import { KeteModesRpc } from "../../src/kete/modes.js"

const decode = Schema.decodeUnknownSync(KeteModesRpc.Profile, { errors: "all", onExcessProperty: "error" })
const valid = {
  id: "code",
  name: "Code",
  description: "d",
  agent: "build",
  available: true,
  files: "workspace",
  shell: { run: "any", allow: [], windows: "same" },
  network: "default",
  git: true,
  web: true,
  mcp: true,
  approvals: "default",
  outputs: "in-place",
}

test("decodes a valid profile", () => {
  expect(decode(valid)).toEqual(valid as typeof KeteModesRpc.Profile.Type)
})

test("rejects an unknown top-level key", () => {
  expect(() => decode({ ...valid, placeholder: true })).toThrow(/placeholder/)
})

test("rejects an unknown key inside shell", () => {
  expect(() => decode({ ...valid, shell: { ...valid.shell, extra: 1 } })).toThrow(/extra/)
})

test("rejects an unknown id", () => {
  expect(() => decode({ ...valid, id: "chat" })).toThrow(/\["id"\]/)
})

test("rejects a missing field", () => {
  const { network: _, ...rest } = valid
  expect(() => decode(rest)).toThrow(/network/)
})
