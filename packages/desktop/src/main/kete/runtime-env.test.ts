import { expect, test } from "bun:test"
import { forRuntime } from "./runtime-env"

test("each value the desktop sets for the runtime also gets its KETE_* name", () => {
  expect(forRuntime({ OPENCODE_CLIENT: "desktop", OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true" })).toEqual({
    OPENCODE_CLIENT: "desktop",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    KETE_CLIENT: "desktop",
    KETE_DISABLE_EMBEDDED_WEB_UI: "true",
  })
})

test("only an unpackaged app with a dev renderer trusts the renderer's origin", async () => {
  const { devCors } = await import("./runtime-env")
  expect(devCors(false, "http://localhost:5173/index.html")).toEqual(["--cors", "http://localhost:5173"])
  expect(devCors(true, "http://localhost:5173/index.html")).toEqual([])
  expect(devCors(false, undefined)).toEqual([])
  expect(devCors(false, "not a url")).toEqual([])
})
