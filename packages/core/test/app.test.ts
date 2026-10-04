import { expect, test } from "bun:test"
import { Brand } from "@opencode/util/kete/brand" // kete_change
import { App } from "@opencode/core/app"

test("formats app metadata as a user agent", () => {
  expect(App.useragent(App.make({ name: "sdk", version: "1.2.3", channel: "beta" }))).toBe(`${Brand.cliName}/beta/1.2.3/sdk`) // kete_change
})
