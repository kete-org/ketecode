// Kete-owned test fixture: an OpenAI-compatible chat-completions endpoint on 127.0.0.1 that
// scripts a two-turn run: the first request (with tools) gets a `write` tool call, every later one
// a final answer that contains a fake secret (the step must redact it). Records every request.

export type FakeModel = {
  readonly url: string
  readonly requests: { path: string; authorization: string | null; tools: string[] }[]
  stop(): void
}

export const fakeSecret = "sk-fakeharnesssecret0123456789"
export const finalAnswer = `Fixed the build: the missing file is restored. (debug token ${fakeSecret})`

export function startFakeModel(options: { file?: string; content?: string } = {}): FakeModel {
  const requests: FakeModel["requests"] = []
  let n = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname.endsWith("/models"))
        return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "test" }] })
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 })
      const body = (await req.json()) as { tools?: { function?: { name?: string } }[]; messages?: { role: string }[] }
      const tools = (body.tools ?? []).map((t) => t.function?.name ?? "")
      requests.push({ path: url.pathname, authorization: req.headers.get("authorization"), tools })
      n++
      const base = { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: "fake-model" }
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      const answered = (body.messages ?? []).some((m) => m.role === "tool")
      const chunks =
        !answered && tools.includes("write")
          ? [
              {
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${n}`,
                          type: "function",
                          function: {
                            name: "write",
                            arguments: JSON.stringify({
                              path: options.file ?? "FIXED.md",
                              content: options.content ?? "fixed\n",
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
            ]
          : [
              {
                ...base,
                choices: [{ index: 0, delta: { role: "assistant", content: finalAnswer }, finish_reason: null }],
              },
              { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
            ]
      const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(text, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}
