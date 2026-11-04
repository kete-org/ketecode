import { expect, test } from "bun:test"
import { createSidecarStatus } from "./sidecar-status-state"

function setup(current = "http://127.0.0.1:4100") {
  const calls: string[] = []
  const status = createSidecarStatus({
    notice: { show: () => calls.push("show"), hide: () => calls.push("hide") },
    toast: () => calls.push("toast"),
    current: () => ({ url: current }),
    update: (data) => calls.push(`update ${data.url}`),
  })

  return { calls, status }
}

test("a repeated restarting event shows the notice once", () => {
  const { calls, status } = setup()
  status.restarting()
  status.restarting()

  expect(calls).toEqual(["show"])
})

test("ready on the same origin hides the notice and toasts without updating", () => {
  const { calls, status } = setup()
  status.restarting()
  status.ready({ url: "http://127.0.0.1:4100" })

  expect(calls).toEqual(["show", "hide", "toast"])
})

test("ready on a new origin also updates the sidecar", () => {
  const { calls, status } = setup()
  status.restarting()
  status.ready({ url: "http://127.0.0.1:4200" })

  expect(calls).toEqual(["show", "hide", "toast", "update http://127.0.0.1:4200"])
})

test("ready without a prior restarting still toasts and hides nothing", () => {
  const { calls, status } = setup()
  status.ready({ url: "http://127.0.0.1:4100" })

  expect(calls).toEqual(["toast"])
})

test("the notice can show again after a recovery", () => {
  const { calls, status } = setup()
  status.restarting()
  status.ready({ url: "http://127.0.0.1:4100" })
  status.restarting()

  expect(calls).toEqual(["show", "hide", "toast", "show"])
})
