import { afterEach, describe, expect, test } from "bun:test"
import { empty, EventStream, parseFrames, reduce, type Event } from "../src/events"

const asked = (id: string, sessionID = "ses_1"): Event => ({
  type: "permission.asked",
  data: { id, sessionID, action: "shell", resources: ["npm install"] },
})
const status = (sessionID: string, type: string): Event => ({ type: "session.status", data: { sessionID, status: { type } } })

describe("attention", () => {
  test("counts waiting permission prompts until they are answered", () => {
    let state = empty
    const first = reduce(state, asked("per_1"))
    expect(first.change).toEqual({ kind: "asked", sessionID: "ses_1", action: "shell" })
    state = reduce(first.state, asked("per_2")).state
    expect(state.pending.size).toBe(2)
    state = reduce(state, { type: "permission.replied", data: { sessionID: "ses_1", requestID: "per_1", reply: "once" } }).state
    expect([...state.pending.keys()]).toEqual(["per_2"])
    // An unknown reply changes nothing.
    expect(reduce(state, { type: "permission.replied", data: { requestID: "nope" } }).state).toBe(state)
  })

  test("a session going busy then idle has finished; an idle session never busy has not", () => {
    let state = reduce(empty, status("ses_1", "busy")).state
    state = reduce(state, asked("per_1", "ses_1")).state
    const done = reduce(state, status("ses_1", "idle"))
    expect(done.change).toEqual({ kind: "finished", sessionID: "ses_1" })
    // Its prompts are gone with it.
    expect(done.state.pending.size).toBe(0)
    expect(reduce(empty, status("ses_2", "idle")).change).toBeUndefined()
    expect(reduce(empty, status("ses_3", "retry")).state.busy.has("ses_3")).toBe(true)
  })

  test("ignores other and malformed events", () => {
    for (const event of [{ type: "session.text.delta", data: {} }, { type: "permission.asked" }, { type: "session.status", data: { sessionID: 1 } }])
      expect(reduce(empty, event).state).toBe(empty)
  })
})

describe("parseFrames", () => {
  test("splits complete events and keeps the remainder", () => {
    const { events, rest } = parseFrames(
      `data: {"type":"a","data":1}\n\ndata: {"type":"b"}\r\n\r\n: comment\n\ndata: not json\n\ndata: {"type":"c"`,
    )
    expect(events).toEqual([{ type: "a", data: 1 }, { type: "b", data: undefined }])
    expect(rest).toBe(`data: {"type":"c"`)
  })
})

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

describe("EventStream", () => {
  test("authenticates, delivers events, re-reads state on every (re)connection, and stops", async () => {
    const seen = { connects: 0, authorization: [] as Array<string | null> }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seen.authorization.push(request.headers.get("authorization"))
        const attempt = seen.authorization.length
        // The first connection sends one event and closes; the second stays open.
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: {"type":"permission.asked","data":{"id":"per_${attempt}","sessionID":"s"}}\n\n`))
            if (attempt === 1) controller.close()
          },
        })
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      },
    })
    cleanup.push(() => server.stop(true))
    const events: Event[] = []
    const stream = new EventStream({
      connection: async () => ({ url: `http://127.0.0.1:${server.port}`, password: "pw" }),
      onEvent: (event) => events.push(event),
      onConnect: () => void seen.connects++,
    })
    stream.start()
    cleanup.push(() => stream.stop())
    for (let wait = 0; wait < 300 && events.length < 2; wait++) await Bun.sleep(10)
    expect(events.map((event) => (event.data as { id: string }).id)).toEqual(["per_1", "per_2"])
    expect(seen.connects).toBe(2)
    expect(seen.authorization[0]).toBe(`Basic ${btoa("opencode:pw")}`)
    stream.stop()
    await Bun.sleep(50)
    const count = seen.authorization.length
    await Bun.sleep(1_200)
    expect(seen.authorization.length).toBe(count)
  })

  test("waits without a server, and never connects while it has none", async () => {
    const calls = { count: 0 }
    const stream = new EventStream({ connection: async () => (calls.count++, undefined), onEvent: () => undefined })
    stream.start()
    await Bun.sleep(50)
    stream.stop()
    expect(calls.count).toBe(1)
  })
})
