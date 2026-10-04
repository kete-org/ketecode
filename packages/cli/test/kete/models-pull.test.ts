// `kete models pull` against a fake Ollama (`Bun.serve` streaming NDJSON from `/api/pull`) and a fake
// status/rediscover RPC: progress, the URL from status, Ollama errors, HTTP errors, timeouts, Ctrl-C
// and offline mode.
import { afterEach, describe, expect, test } from "bun:test"
import type { KeteLocalModelsRpc } from "@opencode/schema/kete/local-models"
import { KeteModelsPull } from "../../src/kete/models-pull"
import { KeteModelsList } from "../../src/kete/models-list"

const { pull, EXIT, ollamaRoot, parseLine, describe: describeLine, validName, refusal } = KeteModelsPull

type Script = (send: (line: unknown) => void, close: () => void) => void | Promise<void>

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

/** A fake Ollama whose `/api/pull` streams what `script` sends; records each request body. */
function ollama(script: Script, options: { status?: number; body?: string } = {}) {
  const requests: { path: string; body: unknown }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({ path: url.pathname, body: await request.json().catch(() => undefined) })
      if (url.pathname !== "/api/pull") return new Response("not found", { status: 404 })
      if (options.status !== undefined) return new Response(options.body ?? "", { status: options.status })
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await script(
            (line) => controller.enqueue(encoder.encode((typeof line === "string" ? line : JSON.stringify(line)) + "\n")),
            () => controller.close(),
          )
        },
      })
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

function status(url: string, overrides: Partial<KeteLocalModelsRpc.ProviderStatus> = {}, offline = false): KeteLocalModelsRpc.Status {
  return {
    offline,
    providers: [
      { id: "lmstudio", state: "not_configured", url: "http://127.0.0.1:1234/v1", source: "default", insecure: false, hint: "Start LM Studio's server." },
      { id: "ollama", state: "reachable", url, source: "env", models: 1, insecure: false, hint: "Run `ollama serve`.", ...overrides },
    ],
  }
}

function harness(statusValue: KeteLocalModelsRpc.Status | Error, options: { interactive?: boolean; offline?: boolean; timeouts?: { first?: number; idle?: number } } = {}) {
  const calls = { status: 0, rediscover: 0 }
  const progress: string[] = []
  const errors: string[] = []
  const info: string[] = []
  const controller = new AbortController()
  const deps: KeteModelsPull.Deps = {
    offline: options.offline ?? false,
    status: async () => {
      calls.status++
      if (statusValue instanceof Error) throw statusValue
      return statusValue
    },
    rediscover: async () => {
      calls.rediscover++
    },
    fetch: (url, init) => fetch(url, init),
    progress: {
      start: (m) => progress.push(`start ${m}`),
      update: (m) => progress.push(`update ${m}`),
      stop: (m, code) => progress.push(`stop ${m} ${code ?? 0}`),
    },
    interactive: options.interactive ?? false,
    info: (m) => info.push(m),
    error: (m) => errors.push(m),
    signal: controller.signal,
    timeouts: options.timeouts,
  }
  return { deps, calls, progress, errors, info, controller }
}

const layer = (completed: number) => ({ status: "pulling 2af3b81862c6", digest: "sha256:2af3", total: 2_000_000_000, completed })

describe("kete models pull", () => {
  test("streams progress from the Ollama URL status reports, then asks the runtime to rediscover", async () => {
    const fake = ollama((send, close) => {
      send({ status: "pulling manifest" })
      send(layer(0))
      send(layer(1_000_000_000))
      send(layer(2_000_000_000))
      send({ status: "verifying sha256 digest" })
      send({ status: "writing manifest" })
      send({ status: "success" })
      close()
    })
    const h = harness(status(`${fake.url}/v1`))
    expect(await pull("llama3.2:3b", h.deps)).toBe(EXIT.ok)
    expect(fake.requests).toEqual([{ path: "/api/pull", body: { model: "llama3.2:3b", stream: true } }])
    // Without a TTY: one line per phase, never one per percent.
    expect(h.progress).toEqual([
      `start Pulling llama3.2:3b from ${fake.url}`,
      "update pulling manifest",
      "update pulling 2af3b81862c6",
      "update verifying sha256 digest",
      "update writing manifest",
      "stop Pulled llama3.2:3b 0",
    ])
    expect(h.calls).toEqual({ status: 1, rediscover: 1 })
    expect(h.errors).toEqual([])
    expect(h.info[0]).toContain("llama3.2:3b is ready")
  })

  test("on a TTY every update shows the percentage", async () => {
    const fake = ollama((send, close) => {
      send(layer(500_000_000))
      send({ status: "success" })
      close()
    })
    const h = harness(status(`${fake.url}/v1`), { interactive: true })
    expect(await pull("qwen2.5-coder:7b", h.deps)).toBe(EXIT.ok)
    expect(h.progress).toContain("update pulling 2af3b81862c6: 25% (500.0 MB of 2.0 GB)")
  })

  test("a remote Ollama with a path prefix: /v1 is stripped, the prefix kept", async () => {
    const fake = ollama((send, close) => {
      send({ status: "success" })
      close()
    })
    const h = harness(status(`${fake.url}/v1`))
    expect(await pull("llama3.2", h.deps)).toBe(EXIT.ok)
    expect(ollamaRoot("http://192.168.1.20:11434/v1")).toBe("http://192.168.1.20:11434")
    expect(ollamaRoot("https://gpu.example.test/ollama/v1/")).toBe("https://gpu.example.test/ollama")
    expect(ollamaRoot("ftp://host/v1")).toBeUndefined()
    expect(ollamaRoot("not a url")).toBeUndefined()
  })

  test("an {error} line from Ollama exits 1 with its reason and no rediscovery", async () => {
    const fake = ollama((send, close) => {
      send({ status: "pulling manifest" })
      send({ error: "pull model manifest: file does not exist" })
      close()
    })
    const h = harness(status(`${fake.url}/v1`))
    expect(await pull("nope", h.deps)).toBe(EXIT.failed)
    expect(h.errors).toEqual(["Ollama couldn't pull nope: pull model manifest: file does not exist"])
    expect(h.progress.at(-1)).toBe("stop Pull failed 1")
    expect(h.calls.rediscover).toBe(0)
  })

  test("an HTTP error exits 1 with the status and Ollama's reason", async () => {
    const fake = ollama(() => {}, { status: 500, body: JSON.stringify({ error: "disk full" }) })
    const h = harness(status(`${fake.url}/v1`))
    expect(await pull("llama3.2", h.deps)).toBe(EXIT.failed)
    expect(h.errors).toEqual([`Ollama at ${fake.url} refused the pull (HTTP 500): disk full`])
    expect(h.calls.rediscover).toBe(0)
  })

  test("a stream that ends without success, or with something that isn't progress, exits 1", async () => {
    const short = ollama((send, close) => {
      send({ status: "pulling manifest" })
      close()
    })
    const h = harness(status(`${short.url}/v1`))
    expect(await pull("llama3.2", h.deps)).toBe(EXIT.failed)
    expect(h.errors[0]).toContain("stopped before the pull of llama3.2 finished")

    const garbage = ollama((send, close) => {
      send("<html>proxy error</html>")
      close()
    })
    const g = harness(status(`${garbage.url}/v1`))
    expect(await pull("llama3.2", g.deps)).toBe(EXIT.failed)
    expect(g.errors[0]).toContain("isn't pull progress")
    expect(h.calls.rediscover + g.calls.rediscover).toBe(0)
  })

  test("Ctrl-C mid-pull exits 130 and doesn't rediscover", async () => {
    let sent!: () => void
    const first = new Promise<void>((resolve) => (sent = resolve))
    const fake = ollama((send) => {
      send(layer(1))
      sent()
      // Never closes: only the abort ends it.
    })
    const h = harness(status(`${fake.url}/v1`))
    const running = pull("llama3.2", h.deps)
    await first
    await Bun.sleep(20)
    h.controller.abort()
    expect(await running).toBe(EXIT.cancelled)
    expect(h.errors).toEqual(["Pull of llama3.2 cancelled."])
    expect(h.progress.at(-1)).toBe("stop Pull cancelled 1")
    expect(h.calls.rediscover).toBe(0)
  })

  test("no progress for the idle timeout stops the pull with exit 1", async () => {
    const fake = ollama((send) => {
      send(layer(1))
    })
    const h = harness(status(`${fake.url}/v1`), { timeouts: { idle: 100 } })
    expect(await pull("llama3.2", h.deps)).toBe(EXIT.failed)
    expect(h.errors[0]).toContain("No progress from Ollama")
    expect(h.calls.rediscover).toBe(0)
  })

  test("an Ollama that isn't reachable, or a status that fails, exits 1 with the URL and hint", async () => {
    const h = harness(status("http://192.168.1.20:11434/v1", { state: "unreachable", error: "connection refused", models: undefined }))
    expect(await pull("llama3.2", h.deps)).toBe(EXIT.failed)
    expect(h.errors).toEqual(["Ollama isn't reachable at http://192.168.1.20:11434: connection refused. Run `ollama serve`."])

    const failing = harness(new Error("server closed"))
    expect(await pull("llama3.2", failing.deps)).toBe(EXIT.failed)
    expect(failing.errors[0]).toContain("server closed")
  })

  test("an unreachable host at fetch time exits 1", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") })
    const url = `http://127.0.0.1:${closed.port}`
    closed.stop(true)
    const h = harness(status(`${url}/v1`))
    expect(await pull("llama3.2", h.deps)).toBe(EXIT.failed)
    expect(h.errors[0]).toStartWith(`Could not reach Ollama at ${url}`)
  })

  test("offline mode refuses before anything is contacted, also when the runtime is offline", async () => {
    const h = harness(status("http://127.0.0.1:11434/v1"), { offline: true })
    expect(await pull("llama3.2", h.deps)).toBe(EXIT.refused)
    expect(h.errors[0]).toStartWith("Offline mode is on (--offline, KETE_OFFLINE or kete.offline): `kete models pull`")
    expect(h.calls.status).toBe(0)

    const fake = ollama(() => {})
    const runtime = harness(status(`${fake.url}/v1`, {}, true))
    expect(await pull("llama3.2", runtime.deps)).toBe(EXIT.refused)
    expect(fake.requests).toEqual([])
  })

  test("a malformed name is refused", async () => {
    const h = harness(status("http://127.0.0.1:11434/v1"))
    expect(await pull("bad name", h.deps)).toBe(EXIT.refused)
    expect(h.calls.status).toBe(0)
    expect(refusal("llama3.2", false)).toBeUndefined()
    for (const name of ["llama3.2", "qwen2.5-coder:7b", "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M", "library/llama3@sha256"])
      expect(validName(name)).toBe(true)
    for (const name of ["", " llama", "llama 3", "-rm", "a\nb", "x".repeat(257)]) expect(validName(name)).toBe(false)
  })
})

describe("pull progress lines", () => {
  test("parses status and error lines and rejects anything else", () => {
    expect(parseLine(JSON.stringify(layer(5)))).toEqual({ kind: "status", status: "pulling 2af3b81862c6", total: 2_000_000_000, completed: 5 })
    expect(parseLine('{"error":"bad\\u001b[31m"}')).toEqual({ kind: "error", message: "bad [31m" })
    expect(parseLine("[1]")).toBeUndefined()
    expect(parseLine("{}")).toBeUndefined()
    expect(parseLine("nope")).toBeUndefined()
    expect(parseLine('{"status":"x","total":-1,"completed":"a"}')).toEqual({ kind: "status", status: "x", total: undefined, completed: undefined })
  })

  test("describes a layer with its percentage and sizes", () => {
    expect(describeLine({ kind: "status", status: "pulling abc", total: 4_000, completed: 1_000 })).toBe("pulling abc: 25% (1.0 KB of 4.0 KB)")
    expect(describeLine({ kind: "status", status: "writing manifest" })).toBe("writing manifest")
  })
})

describe("kete models on a terminal", () => {
  const model = (providerID: string, id: string, tools: boolean, input: string[], context: number) => ({
    providerID,
    id,
    capabilities: { tools, input },
    limit: { context },
  })
  const models = [
    model("ollama", "llama3.2", true, ["text"], 131072),
    model("anthropic", "claude-sonnet", true, ["text", "image"], 200000),
    model("vllm", "qwen", false, ["text", "image"], 0),
  ]

  test("local models get tools, vision and context; others don't", () => {
    expect(KeteModelsList.lines(models, true)).toEqual([
      "anthropic/claude-sonnet",
      "ollama/llama3.2  tools:yes vision:no ctx:131072",
      "vllm/qwen  tools:no vision:yes",
    ])
  })

  test("piped output is unchanged: one provider/model per line", () => {
    expect(KeteModelsList.lines(models, false)).toEqual(["anthropic/claude-sonnet", "ollama/llama3.2", "vllm/qwen"])
  })
})
