import { describe, expect, test } from "bun:test"
import { KeteLocalPicker } from "../../src/kete/local-picker.js"

const ollama = (patch: Partial<KeteLocalPicker.ProviderStatus> = {}): KeteLocalPicker.ProviderStatus => ({
  id: "ollama",
  state: "reachable",
  url: "http://127.0.0.1:11434/v1",
  models: 2,
  hint: "Start it with `ollama serve`.",
  insecure: false,
  ...patch,
})

describe("KeteLocalPicker", () => {
  test("badges only for local providers: no tools, then context size", () => {
    expect(KeteLocalPicker.badges({ providerID: "ollama", tools: false, context: 131_072 })).toEqual([
      "no tools",
      "128k ctx",
    ])
    expect(KeteLocalPicker.badges({ providerID: "lmstudio", tools: true, context: 0 })).toEqual([])
    expect(KeteLocalPicker.badges({ providerID: "openai", tools: false, context: 128_000 })).toEqual([])
  })

  test("unreachable lines skip servers that aren't set up", () => {
    const status = { offline: false, providers: [ollama({ state: "not_configured", models: undefined })] }
    expect(KeteLocalPicker.unreachable(status)).toEqual([])
    const down = { offline: false, providers: [ollama({ state: "unreachable", error: "timed out" })] }
    expect(KeteLocalPicker.unreachable(down)[0]?.text).toBe(
      "Ollama isn't reachable at http://127.0.0.1:11434/v1 (timed out).",
    )
  })

  test("offer needs no model, no earlier offer and a reachable server with models", () => {
    const status = { offline: false, providers: [ollama()] }
    expect(KeteLocalPicker.offer({ status, hasModel: false, offered: false })?.title).toBe(
      "Use local models (Ollama, 2 models)",
    )
    expect(KeteLocalPicker.offer({ status, hasModel: true, offered: false })).toBeUndefined()
    expect(KeteLocalPicker.offer({ status, hasModel: false, offered: true })).toBeUndefined()
    expect(KeteLocalPicker.offer({ status: undefined, hasModel: false, offered: false })).toBeUndefined()
  })

  test("pick prefers a model that can call tools", () => {
    const models = [
      { providerID: "ollama", id: "a", tools: false },
      { providerID: "ollama", id: "b", tools: true },
    ]
    expect(KeteLocalPicker.pick(models, "ollama")?.id).toBe("b")
    expect(KeteLocalPicker.pick(models, "vllm")).toBeUndefined()
  })

  test("context warnings are keyed by provider and model", () => {
    const status = { offline: false, providers: [ollama({ contextWarnings: [{ model: "llama3", message: "small" }] })] }
    expect(KeteLocalPicker.contextWarnings(status)).toEqual([{ key: "ollama/llama3", message: "small" }])
  })
})
