import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KeteWebRedirect } from "@opencode/core/kete/web-redirect"

const response = (status: number, location?: string) => ({ status, headers: location ? { location } : {} })

function run(routes: Record<string, ReturnType<typeof response>>, deny?: string) {
  const fetched: string[] = []
  const approved: string[] = []
  const result = Effect.runSync(
    KeteWebRedirect.follow({
      url: "https://a.example/start",
      fetch: (url) => Effect.sync(() => (fetched.push(url), routes[url] ?? response(200))),
      approve: (url) => (url.startsWith(deny ?? "\0") ? Effect.fail(new Error("denied")) : Effect.sync(() => void approved.push(url))),
    }).pipe(Effect.result),
  )
  return { result, fetched, approved }
}

describe("KeteWebRedirect.follow", () => {
  test("same-origin redirects don't ask", () => {
    const { fetched, approved } = run({ "https://a.example/start": response(302, "/next") })
    expect(fetched).toEqual(["https://a.example/start", "https://a.example/next"])
    expect(approved).toEqual([])
  })
  test("a redirect to another origin asks before it's requested", () => {
    const { fetched, approved } = run({ "https://a.example/start": response(301, "https://b.example/x") })
    expect(approved).toEqual(["https://b.example/x"])
    expect(fetched).toEqual(["https://a.example/start", "https://b.example/x"])
  })
  test("a refused redirect isn't requested", () => {
    const { result, fetched } = run({ "https://a.example/start": response(302, "https://evil.example/x") }, "https://evil.example")
    expect(result._tag).toBe("Failure")
    expect(fetched).toEqual(["https://a.example/start"])
  })
  test("non-HTTP redirects and loops fail", () => {
    expect(run({ "https://a.example/start": response(302, "file:///etc/passwd") }).result._tag).toBe("Failure")
    expect(run({ "https://a.example/start": response(302, "/start") }).result._tag).toBe("Failure")
  })
})
