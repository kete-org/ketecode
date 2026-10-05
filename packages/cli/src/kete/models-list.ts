// `kete models` on a terminal: local models (Ollama, LM Studio, vLLM) get their capabilities after the
// name, because those come from the server itself and often differ from what a user expects (many
// local models can't call tools, which Kete Code needs to read or edit files). Piped output stays
// one `provider/model` per line, so scripts are unaffected.
export * as KeteModelsList from "./models-list"

export const localProviders: ReadonlySet<string> = new Set(["ollama", "lmstudio", "vllm"])

export type Model = {
  readonly providerID: string
  readonly id: string
  readonly capabilities: { readonly tools: boolean; readonly input: readonly string[] }
  readonly limit: { readonly context: number }
}

const yesNo = (value: boolean) => (value ? "yes" : "no")

/** `tools:yes vision:no ctx:32768` for a local model; undefined for any other provider. */
export function details(model: Model): string | undefined {
  if (!localProviders.has(model.providerID)) return undefined
  const context = model.limit.context > 0 ? ` ctx:${model.limit.context}` : ""
  return `tools:${yesNo(model.capabilities.tools)} vision:${yesNo(model.capabilities.input.includes("image"))}${context}`
}

/** The lines `kete models` prints: details (on a terminal only) separated from the name by two spaces. */
export function lines(models: readonly Model[], terminal: boolean): string[] {
  return models
    .map((model) => {
      const name = `${model.providerID}/${model.id}`
      const extra = terminal ? details(model) : undefined
      return { name, line: extra === undefined ? name : `${name}  ${extra}` }
    })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((item) => item.line)
}
