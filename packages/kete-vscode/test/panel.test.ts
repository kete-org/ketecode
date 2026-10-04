import { describe, expect, test } from "bun:test"
import { dismiss, dismissCliHint, dismissNotice, loadPanelState, NOTICES, type Store } from "../src/panel"

function fakeStore(): Store {
  const data = new Map<string, unknown>()
  return {
    get<T>(key: string, defaultValue: T): T {
      return data.has(key) ? (data.get(key) as T) : defaultValue
    },
    update(key: string, value: unknown) {
      data.set(key, value)
      return Promise.resolve()
    },
  }
}

describe("dismiss", () => {
  test("adds a known id, deduped", () => {
    const first = NOTICES[0]!.id
    expect(dismiss([], first)).toEqual([first])
    expect(dismiss([first], first)).toEqual([first])
  })
  test("ignores an unknown id", () => {
    expect(dismiss([], "not-a-real-notice")).toEqual([])
  })
  test("caps the list rather than growing it forever", () => {
    const long = Array.from({ length: 60 }, (_, i) => `x${i}`)
    expect(dismiss(long, NOTICES[0]!.id).length).toBeLessThanOrEqual(50)
  })
})

describe("loadPanelState", () => {
  test("everything visible by default", () => {
    const state = loadPanelState(fakeStore(), { platform: "mac", defaultMode: "default" })
    expect(state.platform).toBe("mac")
    expect(state.defaultMode).toBe("default")
    expect(state.cliHint).toBe(true)
    expect(state.notices.map((n) => n.id)).toEqual(NOTICES.map((n) => n.id))
  })

  test("platform and default mode pass straight through", () => {
    const state = loadPanelState(fakeStore(), { platform: "other", defaultMode: "ask" })
    expect(state.platform).toBe("other")
    expect(state.defaultMode).toBe("ask")
  })
})

describe("dismissals persist across a reload", () => {
  test("a dismissed notice stays dismissed when the state is loaded again from the same store", async () => {
    const store = fakeStore()
    const id = NOTICES[0]!.id
    await dismissNotice(store, id)
    // "Reload": a fresh loadPanelState call, as a new webview session would make.
    const state = loadPanelState(store, { platform: "mac", defaultMode: "default" })
    expect(state.notices.map((n) => n.id)).not.toContain(id)
    expect(state.notices).toHaveLength(NOTICES.length - 1)
  })

  test("dismissing an unknown id changes nothing", async () => {
    const store = fakeStore()
    await dismissNotice(store, "bogus")
    const state = loadPanelState(store, { platform: "mac", defaultMode: "default" })
    expect(state.notices).toHaveLength(NOTICES.length)
  })

  test("the CLI hint stays dismissed too", async () => {
    const store = fakeStore()
    await dismissCliHint(store)
    const state = loadPanelState(store, { platform: "mac", defaultMode: "default" })
    expect(state.cliHint).toBe(false)
  })
})
