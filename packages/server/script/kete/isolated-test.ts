// Runs the server's tests with a throwaway HOME and XDG directories, as core/script/test.ts does for
// core: the tests start the real runtime, whose Kete plugins read the developer's account
// (~/.config/kete) and would sync with, and register at, their Kete platform, and pick up their
// hand-written configuration. Credentials in the environment are dropped for the same reason.
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Brand } from "@opencode/util/kete/brand"

const home = await mkdtemp(path.join(os.tmpdir(), `${Brand.cliName}-server-test-`))
const temporary = path.join(home, "tmp")
await mkdir(temporary)

const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      if (/^(?:AWS|AZURE|GOOGLE|GCP|GCLOUD|VERTEX|OPENAI|ANTHROPIC|GEMINI|XAI|CLOUDFLARE|CF_AIG|SNOWFLAKE|AICORE|GITLAB|NPM_CONFIG)_/i.test(name))
        return false
      if (name.startsWith(Brand.envPrefix)) return false
      return !/(?:^|_)(?:API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name)
    }),
  ),
  HOME: home,
  OPENCODE_TEST_HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  OPENCODE_CONFIG_DIR: path.join(home, ".config", Brand.appDirectory),
  TMPDIR: temporary,
  ...(process.platform === "win32" ? { USERPROFILE: home, TMP: temporary, TEMP: temporary } : {}),
}

const child = Bun.spawn({
  cmd: [process.execPath, "test", "--only-failures", ...process.argv.slice(2)],
  env: environment,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const interrupt = () => child.kill("SIGINT")
process.on("SIGINT", interrupt)
const code = await child.exited
process.off("SIGINT", interrupt)
await rm(home, { recursive: true, force: true }).catch(() => undefined)
process.exit(code)
