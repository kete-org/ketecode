/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import {
  dialogFields,
  firstRunOffer,
  hasLocalModels,
  KeteLocalPicker,
  noToolsTracker,
  offlineFrom,
  unreachableOptions,
  type OfferDeps,
} from "../../src/kete/local-models"
import { OfflineIndicator } from "../../src/kete/local-status"

const ollama = (patch: Partial<KeteLocalPicker.ProviderStatus> = {}): KeteLocalPicker.ProviderStatus => ({
  id: "ollama",
  state: "reachable",
  url: "http://127.0.0.1:11434/v1",
  models: 3,
  hint: "Start it with `ollama serve`.",
  insecure: false,
  ...patch,
})

const status = (...providers: KeteLocalPicker.ProviderStatus[]): KeteLocalPicker.Status => ({
  offline: false,
  providers,
})

const model = (providerID: string, tools: boolean, context: number) => ({
  providerID,
  capabilities: { tools },
  limit: { context },
})

describe("status lines and badges", () => {
  test("context sizes read as k or M tokens", () => {
    expect(KeteLocalPicker.contextLabel(32_768)).toBe("32k ctx")
    expect(KeteLocalPicker.contextLabel(131_072)).toBe("128k ctx")
    expect(KeteLocalPicker.contextLabel(200_000)).toBe("200k ctx")
    expect(KeteLocalPicker.contextLabel(1_048_576)).toBe("1M ctx")
    expect(KeteLocalPicker.contextLabel(512)).toBe("512 ctx")
    expect(KeteLocalPicker.contextLabel(0)).toBeUndefined()
  })

  test("local models go in the Local group with no-tools and context badges", () => {
    const upstream = { category: "Ollama", providerName: "Ollama", footer: undefined, description: undefined }
    expect(dialogFields(model("ollama", false, 32_768), upstream)).toEqual({
      category: "Local",
      providerName: "Local",
      footer: "no tools · 32k ctx",
      description: "Ollama",
    })
    expect(dialogFields(model("vllm", true, 0), upstream).footer).toBeUndefined()
    // Not connected: the dialog shows no categories, and neither does the Local group.
    expect(dialogFields(model("lmstudio", true, 8192), { ...upstream, category: undefined }).category).toBeUndefined()
    // Cloud models keep the dialog's own values.
    const cloud = { category: "Anthropic", providerName: "Anthropic", footer: "Free", description: "(Favorite)" }
    expect(dialogFields(model("anthropic", false, 200_000), cloud)).toBe(cloud)
  })

  test("only unreachable servers get a line, with the URL, the error and how to start it", () => {
    const lines: KeteLocalPicker.Unreachable[] = []
    const options = unreachableOptions(
      status(
        ollama({ state: "unreachable", url: "http://192.168.1.20:11434/v1", models: undefined, error: "connection refused" }),
        { ...ollama({ state: "not_configured", models: undefined }), id: "lmstudio" },
        { ...ollama(), id: "vllm" },
      ),
      (line) => lines.push(line),
    )
    expect(options).toHaveLength(1)
    expect(options[0].title).toBe("Ollama isn't reachable at http://192.168.1.20:11434/v1 (connection refused).")
    expect(options[0].category).toBe("Local")
    expect(options[0].details).toEqual(["Start it with ollama serve."])
    options[0].onSelect()
    expect(lines[0].hint).toBe("Start it with `ollama serve`.")
    expect(unreachableOptions(undefined, () => {})).toEqual([])
  })

  test("a server offline mode won't contact gets a line saying why, with the offline hint", () => {
    const options = unreachableOptions(
      status(
        ollama({
          state: "blocked",
          url: "http://203.0.113.9:11434/v1",
          models: undefined,
          error: "offline mode: http://203.0.113.9:11434/v1 isn't on this machine or a private network",
          hint: "Point it at a host on this machine or a private network, or turn offline mode off.",
        }),
      ),
      () => {},
    )
    expect(options).toHaveLength(1)
    expect(options[0].title).toBe(
      "Ollama isn't used: offline mode: http://203.0.113.9:11434/v1 isn't on this machine or a private network.",
    )
    expect(options[0].details).toEqual(["Point it at a host on this machine or a private network, or turn offline mode off."])
  })
})

describe("first-run offer", () => {
  const deps = (patch: Partial<OfferDeps> = {}) => {
    const calls = { marked: 0, confirmed: [] as string[], selected: [] as unknown[] }
    const value: OfferDeps = {
      hasModel: false,
      offered: false,
      status: async () => status(ollama()),
      markOffered: () => {
        calls.marked++
      },
      confirm: async (offer) => {
        calls.confirmed.push(offer.title)
        return true
      },
      models: () => [
        { providerID: "anthropic", id: "claude", tools: true },
        { providerID: "ollama", id: "llama3", tools: false },
        { providerID: "ollama", id: "qwen2.5-coder", tools: true },
      ],
      select: (model) => calls.selected.push(model),
      ...patch,
    }
    return { value, calls }
  }

  test("offer appears once when no model is set and a local server is reachable; accepting selects a model", async () => {
    const { value, calls } = deps()
    expect(await firstRunOffer(value)).toEqual({ kind: "selected", providerID: "ollama", modelID: "qwen2.5-coder" })
    expect(calls.confirmed).toEqual(["Use local models (Ollama, 3 models)"])
    expect(calls.marked).toBe(1)
    expect(calls.selected).toEqual([{ providerID: "ollama", modelID: "qwen2.5-coder" }])
  })

  test("offer is skipped when already offered, a model is set, or no server has models", async () => {
    for (const patch of [
      { offered: true },
      { hasModel: true },
      { status: async () => status(ollama({ models: 0 })) },
      { status: async () => status(ollama({ state: "unreachable", models: undefined })) },
    ] satisfies Partial<OfferDeps>[]) {
      const { value, calls } = deps(patch)
      expect(await firstRunOffer(value)).toEqual({ kind: "skipped" })
      expect(calls.marked).toBe(0)
      expect(calls.confirmed).toEqual([])
    }
  })

  test("offer declined is still recorded and selects nothing", async () => {
    const { value, calls } = deps({ confirm: async () => false })
    expect(await firstRunOffer(value)).toEqual({ kind: "declined" })
    expect(calls.marked).toBe(1)
    expect(calls.selected).toEqual([])
  })

  test("offer prefers Ollama, then LM Studio, and reports a server whose models aren't listed yet", async () => {
    const { value } = deps({
      status: async () => status({ ...ollama({ models: 1 }), id: "lmstudio" }),
      models: () => [],
    })
    expect(await firstRunOffer(value)).toEqual({ kind: "no_model", providerID: "lmstudio" })
    expect(
      KeteLocalPicker.offer({ status: status(ollama({ models: 1 })), hasModel: false, offered: false })?.title,
    ).toBe("Use local models (Ollama, 1 model)")
  })
})

describe("no-tools notice", () => {
  test("notice shows once per session for a model that can't call tools", () => {
    const tracker = noToolsTracker()
    expect(tracker.check("s1", { tools: false })).toBe(KeteLocalPicker.noToolsMessage)
    expect(tracker.check("s1", { tools: false })).toBeUndefined()
    expect(tracker.check("s2", { tools: true })).toBeUndefined()
    expect(tracker.check("s2", undefined)).toBeUndefined()
    expect(tracker.check("s2", { tools: false })).toBe(KeteLocalPicker.noToolsMessage)
    expect(KeteLocalPicker.noToolsMessage).toContain("can only answer")
  })
})

describe("offline indicator", () => {
  test("offline follows the process flag, then the highest-priority config document with a kete block", () => {
    const doc = (kete?: { offline?: boolean }) => ({ type: "document", info: kete ? { kete } : {} })
    expect(offlineFrom(true, undefined)).toBe(true)
    expect(offlineFrom(false, undefined)).toBe(false)
    expect(offlineFrom(false, [doc({ offline: true }), doc()])).toBe(true)
    expect(offlineFrom(false, [doc({ offline: true }), doc({ offline: false })])).toBe(false)
    expect(offlineFrom(false, [{ type: "source" }, doc({})])).toBe(false)
  })

  test("the offer only asks for status when the catalog lists a local model", () => {
    expect(hasLocalModels([{ providerID: "anthropic" }, { providerID: "ollama" }])).toBe(true)
    expect(hasLocalModels([{ providerID: "anthropic" }])).toBe(false)
    expect(hasLocalModels(undefined)).toBe(false)
  })

  function context() {
    const color = RGBA.fromInts(200, 200, 200)
    return {
      theme: { text: { base: color, feedback: { warning: { base: color } } } },
    } as unknown as Context
  }

  async function frame(offline: boolean) {
    const app = await testRender(
      () => (
        <box width={20}>
          <OfflineIndicator context={context()} offline={() => offline} />
        </box>
      ),
      { width: 20, height: 2 },
    )
    await app.renderOnce()
    try {
      return app.captureCharFrame()
    } finally {
      app.renderer.destroy()
    }
  }

  test("shows Offline only while offline mode is on", async () => {
    expect(await frame(true)).toContain("Offline")
    expect((await frame(false)).trim()).toBe("")
  })
})
