// First-run setup rules shared by the TUI setup screen (tui/src/kete/setup.tsx) and the `kete run`
// no-model hint (cli/src/run/noninteractive.ts). Pure functions over plain data.

export * as KeteSetup from "./setup.js"

import { cliName } from "./brand.js"
import type { Status } from "./local-picker.js"

/** Shown with the "no model" error of `kete run`. */
export const HINT = `Run \`${cliName}\` to set up, or \`${cliName} login\`, \`${cliName} auth login\`, or start a local model server.`

/** The setup screen shows once, only when nothing is set up: no provider, no signed-in account, no model. */
export function shouldShow(input: { done: boolean; connected: boolean; hasModel: boolean }): boolean {
  return !input.done && !input.connected && !input.hasModel
}

export type RowID = "signin" | "key" | "local" | "skip"

export type Row = { readonly id: RowID; readonly title: string; readonly description: string }

/** The screen's rows. Sign-in is hidden offline; the local row says what was found. */
export function rows(input: { offline: boolean; status: Status | undefined }): Row[] {
  const found = (input.status?.providers ?? []).filter((item) => item.state === "reachable" && (item.models ?? 0) > 0)
  return [
    ...(input.offline
      ? []
      : [{ id: "signin" as const, title: "Sign in to Kete Code", description: "Use models through your account" }]),
    { id: "key", title: "Use my own API key", description: "Connect a provider such as Anthropic or OpenAI" },
    {
      id: "local",
      title: "Use a local model",
      description: found.length > 0 ? `${found.length} local server${found.length === 1 ? "" : "s"} found` : "Ollama, LM Studio or vLLM",
    },
    { id: "skip", title: "Skip for now", description: "Run /setup any time" },
  ]
}

/** The sign-in URL from a `kete login` output line that is only a URL (not "Signing in … at <platform>"); undefined otherwise. */
export function parseLoginURL(line: string): string | undefined {
  const match = /^\s*(https?:\/\/\S+)\s*$/.exec(line)
  if (!match?.[1]) return undefined
  try {
    const url = new URL(match[1])
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

type SessionError = { readonly type: string; readonly message: string }

// Pinned by core/test/kete/setup-hint.test.ts against ModelNotSelectedError.
export function isNoModel(error: SessionError): boolean {
  return error.type === "provider.no-route" && error.message.startsWith("No model is available for session")
}

export function withHint(error: SessionError): string {
  return isNoModel(error) ? `${error.message}\n${HINT}` : error.message
}
