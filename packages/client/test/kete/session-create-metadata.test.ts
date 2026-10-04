// data.session.create()'s reactive wrapper (src/solid/data.ts) forwards an optional `metadata`
// field straight through to the generated `POST /api/session` call. The Kete chat panel uses this
// to set a new session's `kete.permissionMode` atomically at creation (packages/app/src/new-session/
// composer-adapter.ts), so nothing else needs a second request or a race window. Setup copied from
// ../solid-data.test.ts:780-825 ("reports optimistic sessions as creating until the request settles").

import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../../src/solid"
import { OpenCode, type SessionInfo } from "../../src/promise"

const session: SessionInfo = {
  id: "ses_meta",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created: 0, updated: 0 },
  location: { directory: "/project" },
}

function setup(onCreateBody: (body: Record<string, unknown>) => void) {
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session")) throw new Error(`Unexpected request: ${request.url}`)
      onCreateBody((await request.clone().json()) as Record<string, unknown>)
      return Response.json({ data: session })
    },
  })
  const event: CreateDataInput["event"] = { on: () => () => {}, listen: () => () => {} }
  return createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))
}

test("sends the given metadata in the create request", async () => {
  const bodies: Record<string, unknown>[] = []
  const root = setup((body) => bodies.push(body))
  try {
    await root.data.session.create({
      id: "ses_meta",
      location: { directory: "/project" },
      metadata: { "kete.permissionMode": "ask" },
    }).request
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!["metadata"]).toEqual({ "kete.permissionMode": "ask" })
  } finally {
    root.dispose()
  }
})

test("sends no metadata key when none is given", async () => {
  const bodies: Record<string, unknown>[] = []
  const root = setup((body) => bodies.push(body))
  try {
    await root.data.session.create({ id: "ses_meta", location: { directory: "/project" } }).request
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toHaveProperty("metadata")
  } finally {
    root.dispose()
  }
})
