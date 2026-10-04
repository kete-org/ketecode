// Side-effect module: imported by the CLI entry point right after ./env-bridge, so offline mode is
// decided (and OPENCODE_OFFLINE, OPENCODE_DISABLE_MODELS_FETCH and OPENCODE_DISABLE_AUTOUPDATE are set)
// before any other module reads the environment. The rules are in ./offline.ts.
import { Global } from "@opencode/util/global"
import { Brand } from "@opencode/util/kete/brand"
import { readFileSync } from "node:fs"
import path from "node:path"
import { KeteCliOffline } from "./offline"

/** The global config files, in the order updater.ts's policy read uses. A missing file is undefined. */
function readGlobalConfig(): (string | undefined)[] {
  const directory = process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config
  return ["config.json", ...Brand.configFiles].map((name) => {
    try {
      return readFileSync(path.join(directory, name), "utf8")
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      // A file that can't be read (rather than one that doesn't exist) is said out loud: it might be
      // the one that turns offline mode on. The runtime reports it again when it loads the config.
      if (code !== "ENOENT" && code !== "ENOTDIR")
        process.stderr.write(`Warning: couldn't read ${path.join(directory, name)} to check kete.offline (${String(code ?? error)}).\n`)
      return undefined
    }
  })
}

KeteCliOffline.apply(process.env, process.argv.slice(2), readGlobalConfig)
