import { expect, test } from "bun:test"
import { agent, model, renderLocal } from "../fixture/local"
import { json } from "../fixture/tui-client"

// An agent without a model of its own (Build, Plan) starts on the runtime's default model, the
// one a signed-in CLI takes from the platform, not on whichever model the catalog lists first.
test("an agent without a model starts on the server's default model", async () => {
  await using rendered = await renderLocal({
    models: [model("first"), model("preferred")],
    agents: [agent("build")],
    fetch: (url) => {
      if (url.pathname === "/api/model/default")
        return json({ location: { directory: url.searchParams.get("location[directory]") }, data: model("preferred") })
    },
  })
  await waitFor(() => rendered.local.model.current()?.modelID === "preferred")
  expect(rendered.local.model.current()).toEqual({ providerID: "provider", modelID: "preferred" })
})

test("the first listed model stays the fallback when the server names no default", async () => {
  await using rendered = await renderLocal({
    models: [model("first"), model("second")],
    agents: [agent("build")],
    fetch: (url) => {
      if (url.pathname === "/api/model/default")
        return json({ location: { directory: url.searchParams.get("location[directory]") } })
    },
  })
  expect(rendered.local.model.current()).toEqual({ providerID: "provider", modelID: "first" })
})

test("a recent model still wins over the server's default", async () => {
  await using rendered = await renderLocal({
    models: [model("first"), model("preferred"), model("recent")],
    agents: [agent("build")],
    preferences: { recent: [{ providerID: "provider", modelID: "recent" }] },
    fetch: (url) => {
      if (url.pathname === "/api/model/default")
        return json({ location: { directory: url.searchParams.get("location[directory]") }, data: model("preferred") })
    },
  })
  expect(rendered.local.model.current()).toEqual({ providerID: "provider", modelID: "recent" })
})

async function waitFor(ready: () => boolean) {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for the default model")
    await Bun.sleep(10)
  }
}
