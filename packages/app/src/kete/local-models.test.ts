import { describe, expect, test } from "bun:test"
import type { KeteLocalModelsRpc } from "@opencode/schema/kete/local-models"
import {
  canCallTools,
  fetchStatus,
  firstRunOffer,
  groupTitle,
  hasLocalModels,
  itemBadges,
  KeteLocalPicker,
  noToolsTracker,
  offerModels,
  offlineFrom,
  type OfferDeps,
  type PickerItem,
} from "./local-models"

const reachable: KeteLocalModelsRpc.ProviderStatus = {
  id: "ollama",
  state: "reachable",
  url: "http://127.0.0.1:11434/v1",
  source: "default",
  models: 2,
  hint: "Start it with `ollama serve`.",
  insecure: false,
}

const item = (providerID: string, id: string, toolcall: boolean | undefined, context?: number): PickerItem => ({
  id,
  provider: { id: providerID, name: KeteLocalPicker.isLocal(providerID) ? KeteLocalPicker.providers[providerID] : providerID },
  capabilities: toolcall === undefined ? undefined : { toolcall },
  limit: context === undefined ? undefined : { context },
})

describe("picker", () => {
  test("local models get no-tools and context badges; others none", () => {
    expect(itemBadges(item("ollama", "llama3", false, 8192))).toEqual(["no tools", "8k ctx"])
    expect(itemBadges(item("vllm", "qwen", true, 32_768))).toEqual(["32k ctx"])
    expect(itemBadges(item("lmstudio", "phi", undefined))).toEqual([])
    expect(itemBadges(item("anthropic", "claude", false, 200_000))).toEqual([])
  })

  test("local provider groups read Local · <server>", () => {
    expect(groupTitle({ id: "ollama" }, "Ollama")).toBe("Local · Ollama")
    expect(groupTitle({ id: "openai" }, "OpenAI")).toBe("OpenAI")
  })

  test("status: unreachable servers get a line with the URL and how to start them", () => {
    const status = {
      offline: false,
      providers: [
        { ...reachable, state: "unreachable" as const, url: "http://10.0.0.5:11434/v1", error: "timed out" },
        { ...reachable, id: "vllm" as const, state: "not_configured" as const },
      ],
    }
    expect(KeteLocalPicker.unreachable(status)).toEqual([
      {
        providerID: "ollama",
        text: "Ollama isn't reachable at http://10.0.0.5:11434/v1 (timed out).",
        hint: "Start it with `ollama serve`.",
      },
    ])
  })

  test("status is fetched over the plugin RPC and validated", async () => {
    const calls: unknown[] = []
    const client = (output: unknown) => ({
      rpc: {
        call: async (input: unknown) => {
          calls.push(input)
          return { output }
        },
      },
    })
    const status = { offline: true, providers: [reachable] }
    // SAFETY: a fake client exposing only the raw RPC call fetchStatus uses.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const ok = client(status) as unknown as Parameters<typeof fetchStatus>[0]
    expect(await fetchStatus(ok, { directory: "/repo" })).toEqual(status)
    expect(calls[0]).toMatchObject({ rpcID: "kete.local-models", method: "status", location: { directory: "/repo" } })
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const bad = client({ offline: "no" }) as unknown as Parameters<typeof fetchStatus>[0]
    await expect(fetchStatus(bad, undefined)).rejects.toBeDefined()
  })

  test("offline follows the runtime's config rule", () => {
    expect(offlineFrom(false, [{ type: "document", info: { kete: { offline: true } } }])).toBe(true)
    expect(offlineFrom(false, [])).toBe(false)
  })
})

describe("first-run offer", () => {
  const models = [item("openai", "gpt", true), item("ollama", "llama3", false), item("ollama", "qwen2.5-coder", true)]
  const deps = (patch: Partial<OfferDeps> = {}) => {
    const calls = { marked: 0, selected: [] as unknown[] }
    const value: OfferDeps = {
      hasModel: false,
      offered: false,
      status: async () => ({ offline: false, providers: [reachable] }),
      markOffered: () => {
        calls.marked++
      },
      confirm: async () => true,
      models: () => offerModels(models),
      select: (model) => calls.selected.push(model),
      ...patch,
    }
    return { value, calls }
  }

  test("offer is made once and accepting selects a local model that can call tools", async () => {
    expect(hasLocalModels(offerModels(models))).toBe(true)
    const { value, calls } = deps()
    expect(await firstRunOffer(value)).toEqual({ kind: "selected", providerID: "ollama", modelID: "qwen2.5-coder" })
    expect(calls.marked).toBe(1)
    expect(calls.selected).toEqual([{ providerID: "ollama", modelID: "qwen2.5-coder" }])
  })

  test("offer is skipped with a model set or after an earlier offer", async () => {
    for (const patch of [{ hasModel: true }, { offered: true }]) {
      const { value, calls } = deps(patch)
      expect(await firstRunOffer(value)).toEqual({ kind: "skipped" })
      expect(calls.marked).toBe(0)
    }
  })

  test("offer declined selects nothing", async () => {
    const { value, calls } = deps({ confirm: async () => false })
    expect(await firstRunOffer(value)).toEqual({ kind: "declined" })
    expect(calls.selected).toEqual([])
  })
})

describe("no-tools notice", () => {
  test("notice shows once per session for a model that can't call tools", () => {
    const tracker = noToolsTracker()
    const llama = item("ollama", "llama3", false)
    expect(tracker.check("s1", { tools: canCallTools(llama) })).toBe(KeteLocalPicker.noToolsMessage)
    expect(tracker.check("s1", { tools: canCallTools(llama) })).toBeUndefined()
    expect(tracker.check("s2", { tools: canCallTools(item("ollama", "qwen", true)) })).toBeUndefined()
    // Unknown capabilities keep upstream behaviour: no notice.
    expect(canCallTools(item("ollama", "x", undefined))).toBe(true)
  })
})
