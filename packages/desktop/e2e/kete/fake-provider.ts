// Kete-owned. A fake OpenAI-compatible model for the desktop e2e (electron.ts): every POST /v1/chat/completions
// streams the same short answer, so the test needs no network or key.

import path from "node:path"

export const FAKE_ANSWER = "Hello from the fake model."

const chunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: 0, model: "fake", choices: [choice], ...extra })}\n\n`

const stream = [
  chunk({ index: 0, delta: { role: "assistant", content: FAKE_ANSWER }, finish_reason: null }),
  chunk(
    { index: 0, delta: {}, finish_reason: "stop" },
    { usage: { prompt_tokens: 1, completion_tokens: 6, total_tokens: 7 } },
  ),
  "data: [DONE]\n\n",
].join("")

export function fakeProvider() {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      requests.push(`${request.method} ${pathname}`)
      if (request.method !== "POST" || pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

/** The runtime reads `<XDG_CONFIG_HOME>/kete/kete.json`; the test root's config dir is that XDG dir. */
export async function writeProviderConfig(testRoot: string, baseURL: string) {
  await Bun.write(
    path.join(testRoot, "config", "kete", "kete.json"),
    JSON.stringify({
      model: "kete-e2e/fake",
      provider: {
        "kete-e2e": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL, apiKey: "unused" },
          models: { fake: { name: "Fake" } },
        },
      },
    }),
  )
}
