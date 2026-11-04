// Where `kete serve --service` registers itself, for the desktop to find and adopt it. The shared client
// (@opencode/client/service) defaults to OpenCode's state directory; Kete Code's runtime writes under its
// own (Brand.appDirectory), so the desktop passes the file explicitly. `service.json` is the name a release
// CLI uses (cli/src/services/service-config.ts `filename`); a locally built one uses its channel's name.

import path from "node:path"
import { Brand } from "@opencode/util/kete/brand"

export function serviceFile(home: string, name = "service.json", env: Record<string, string | undefined> = process.env) {
  return path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), Brand.appDirectory, name)
}
