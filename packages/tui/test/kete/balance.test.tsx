/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { account, KeteBalance } from "../../src/kete/balance"

function context(metadata?: Record<string, unknown>) {
  const color = RGBA.fromInts(200, 200, 200)
  const location = { directory: "/workspace" }
  return {
    location,
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: { error: { base: color }, warning: { base: color } },
      },
    },
    data: {
      session: { get: () => ({ location }) },
      location: {
        integration: { list: () => (metadata ? [{ id: "kete", name: "Kete Code Gateway", metadata }] : []) },
      },
    },
  } as unknown as Context
}

async function frame(input: Context) {
  const app = await testRender(
    () => (
      <box width={38}>
        <KeteBalance context={input} sessionID="session" />
      </box>
    ),
    { width: 38, height: 8 },
  )
  await app.renderOnce()
  try {
    return app.captureCharFrame()
  } finally {
    app.renderer.destroy()
  }
}

test("shows the balance and organization from the kete integration", async () => {
  const text = await frame(context({ balance_micros: 12_500_000, currency: "USD", organization: "Acme" }))
  expect(text).toContain("Kete Code")
  expect(text).toContain("$12.50 balance")
  expect(text).toContain("Acme")
  expect(text).not.toContain("running low")
})

test("warns when credit is low or used up", async () => {
  expect(await frame(context({ balance_micros: 400_000, currency: "USD" }))).toContain("Credit is running low.")
  const empty = await frame(context({ balance_micros: -20_000, currency: "USD" }))
  expect(empty).toContain("-$0.02 balance")
  expect(empty).toContain("Out of credit. Top up to continue.")
})

test("shows nothing without a platform account", async () => {
  expect((await frame(context())).trim()).toBe("")
  expect(account({ balance_micros: "12", currency: "USD" })).toBeUndefined()
  expect(account(undefined)).toBeUndefined()
})
