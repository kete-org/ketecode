// Variables the desktop sets for the runtime it starts. `kete` drops every OPENCODE_* variable a top-level
// process inherits, so values meant for an OpenCode install are never honoured (util/src/kete/env.ts), and
// reads its KETE_* names instead. The desktop therefore sets both names for exactly the values it sets
// itself, never by copying every inherited OPENCODE_* variable.

import { KeteEnv } from "@opencode/util/kete/env"

export function forRuntime(values: Record<string, string>): Record<string, string> {
  return { ...values, ...Object.fromEntries(Object.entries(values).map(([name, value]) => [KeteEnv.publicName(name), value])) }
}

/**
 * `--cors` for the dev renderer's origin. In development the renderer comes from electron-vite's dev
 * server (`http://localhost:<port>`), an origin the runtime's local guard doesn't trust
 * (server/src/kete/local-guard.ts); a packaged app loads it from `oc://renderer`, which is trusted, so it
 * gets nothing.
 */
export function devCors(packaged: boolean, rendererURL: string | undefined): string[] {
  if (packaged || !rendererURL || !URL.canParse(rendererURL)) return []
  return ["--cors", new URL(rendererURL).origin]
}
