import { describe, expect, test } from "bun:test"
import { KeteAccountRpc } from "@opencode/schema/kete/account"
import { changedType, create, failedMessage, type Api } from "./controller"

const signedOut = { signedIn: false, offline: false, signingIn: false }
const signedIn = { signedIn: true, organization: "Acme", platform: "platform.example", offline: false, signingIn: false }

function fake(handlers: Partial<Record<Parameters<Api["call"]>[0], () => unknown>>) {
  const opened: string[] = []
  const calls: string[] = []
  const queue: Array<{ type: string; data?: unknown }> = []
  let wake: (() => void) | undefined
  const api: Api = {
    call: async (method) => {
      calls.push(method)
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected ${method}`)
      return handler()
    },
    open: (url) => void opened.push(url),
    events: async function* (signal) {
      while (!signal.aborted) {
        const next = queue.shift()
        if (next) yield next
        else await new Promise<void>((resolve) => ((wake = resolve), signal.addEventListener("abort", () => resolve())))
      }
    },
  }
  return { api, opened, calls, emit: (event: { type: string; data?: unknown }) => (queue.push(event), wake?.()) }
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("account controller", () => {
  test("loads the status", async () => {
    const { api } = fake({ status: () => signedIn })
    const controller = create(api)
    await controller.start()
    expect(controller.state().status?.organization).toBe("Acme")
    controller.dispose()
  })

  test("sign-in opens the URL and waits; the signed-in event refreshes the status", async () => {
    let status: unknown = signedOut
    const { api, opened, emit } = fake({
      status: () => status,
      login: () => ({ kind: "started", url: "https://p.example/cli/authorize?state=s" }),
    })
    const controller = create(api)
    await controller.start()
    await controller.signIn()
    expect(opened).toEqual(["https://p.example/cli/authorize?state=s"])
    expect(controller.state().phase).toBe("waiting")
    status = signedIn
    emit({ type: changedType, data: { state: "signed-in" } })
    await until(() => controller.state().status?.signedIn === true)
    expect(controller.state().phase).toBe("idle")
    controller.dispose()
  })

  test("cancel returns to idle without an error", async () => {
    const { api, calls } = fake({
      status: () => signedOut,
      login: () => ({ kind: "started", url: "https://p.example/cli/authorize" }),
      cancel: () => ({ cancelled: true }),
    })
    const controller = create(api)
    await controller.start()
    await controller.signIn()
    await controller.cancel()
    expect(calls).toContain("cancel")
    expect(controller.state()).toMatchObject({ phase: "idle", error: undefined })
    controller.dispose()
  })

  test("a failed sign-in event shows its message", async () => {
    const { api, emit } = fake({
      status: () => signedOut,
      login: () => ({ kind: "started", url: "https://p.example/cli/authorize" }),
    })
    const controller = create(api)
    await controller.start()
    await controller.signIn()
    emit({ type: changedType, data: { state: "failed", message: "Approval was denied." } })
    await until(() => controller.state().error !== undefined)
    expect(controller.state()).toMatchObject({ phase: "idle", error: "Approval was denied." })
    controller.dispose()
  })

  test("a refused sign-in shows the runtime's message and opens nothing", async () => {
    const { api, opened } = fake({
      status: () => ({ ...signedOut, offline: true }),
      login: () => ({ kind: "refused", reason: "offline", message: "Offline mode is on." }),
    })
    const controller = create(api)
    await controller.start()
    await controller.signIn()
    expect(opened).toEqual([])
    expect(controller.state()).toMatchObject({ phase: "idle", error: "Offline mode is on." })
    controller.dispose()
  })

  test("a 403 from the server gate shows the local-only text; other failures are generic", async () => {
    const gate = fake({
      status: () => signedOut,
      login: () => {
        throw Object.assign(new Error("forbidden"), { status: 403 })
      },
    })
    const controller = create(gate.api)
    await controller.start()
    await controller.signIn()
    expect(controller.state().error).toBe(KeteAccountRpc.localOnlyMessage)

    const broken = fake({ status: () => signedOut, login: () => { throw new Error("boom") } })
    const other = create(broken.api)
    await other.start()
    await other.signIn()
    expect(other.state().error).toBe(failedMessage)
    controller.dispose()
    other.dispose()
  })

  test("sign-out refreshes the status", async () => {
    let status: unknown = signedIn
    const { api } = fake({
      status: () => status,
      logout: () => {
        status = signedOut
        return { kind: "done" }
      },
    })
    const controller = create(api)
    await controller.start()
    await controller.signOut()
    expect(controller.state().status?.signedIn).toBe(false)
    expect(controller.state().notice).toBeUndefined()
    controller.dispose()
  })

  test("sign-out keeps the runtime's caveat as a notice, not an error", async () => {
    const { api } = fake({
      status: () => signedOut,
      logout: () => ({ kind: "done", message: "The platform could not revoke the key." }),
    })
    const controller = create(api)
    await controller.start()
    await controller.signOut()
    expect(controller.state()).toMatchObject({ error: undefined, notice: "The platform could not revoke the key." })
    controller.dispose()
  })
})
