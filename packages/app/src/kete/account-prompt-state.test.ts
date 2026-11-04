import { describe, expect, test } from "bun:test"
import { eventType, fromEvent, shouldShow } from "./account-prompt-state"

const base = { signedIn: false, offline: false, signingIn: false }

describe("account prompt rules", () => {
  test("shows only when the runtime answered, nobody is signed in and offline mode is off", () => {
    expect(shouldShow(undefined)).toBe(false)
    expect(shouldShow(base)).toBe(true)
    expect(shouldShow({ ...base, signedIn: true, organization: "Acme" })).toBe(false)
    expect(shouldShow({ ...base, offline: true })).toBe(false)
  })

  test("reads account change events and ignores everything else", () => {
    expect(fromEvent({ type: eventType, data: { state: "signed-in" } })).toEqual({ state: "signed-in" })
    expect(fromEvent({ type: eventType, data: { state: "nonsense" } })).toBeUndefined()
    expect(fromEvent({ type: eventType })).toBeUndefined()
    expect(fromEvent({ type: "rpc.kete.todo.updated", data: { state: "signed-in" } })).toBeUndefined()
  })
})
