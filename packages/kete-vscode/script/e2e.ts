#!/usr/bin/env bun
// End-to-end check of a packaged extension in a real VS Code window, isolated from your own VS Code
// (separate user-data and extensions directories) and from your Kete Code state (temporary XDG
// directories, with a signed-in test account whose key sits in the fallback file store).
//
//   bun script/e2e.ts <path/to/kete-code-…-<target>.vsix> [--code <path to the code CLI>]
//
// Local only (it opens a window); not run in CI.

import { execFileSync, spawn, spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { KeteAccount } from "@opencode/util/kete/account"

const vsix = process.argv[2]
if (!vsix || !existsSync(vsix)) throw new Error("usage: bun script/e2e.ts <vsix> [--code <code CLI>]")
const codeFlag = process.argv.indexOf("--code")
const code =
  codeFlag > 0
    ? process.argv[codeFlag + 1]!
    : process.platform === "darwin"
      ? "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
      : "code"
// The `code` launcher returns at once; the test run needs the app's own executable, which waits.
const electron =
  process.platform === "darwin" ? path.resolve(path.dirname(code), "../../../MacOS/Code") : code

const root = mkdtempSync(path.join(os.tmpdir(), "kete-e2e-"))
const dirs = {
  user: path.join(root, "user-data"),
  extensions: path.join(root, "extensions"),
  workspace: path.join(root, "workspace"),
  xdg: path.join(root, "xdg"),
  out: path.join(root, "results.json"),
}
const xdg = {
  XDG_CONFIG_HOME: path.join(dirs.xdg, "config"),
  XDG_DATA_HOME: path.join(dirs.xdg, "data"),
  XDG_STATE_HOME: path.join(dirs.xdg, "state"),
  XDG_CACHE_HOME: path.join(dirs.xdg, "cache"),
}

// A small git workspace with one committed and then modified file.
mkdirSync(path.join(dirs.workspace, "src"), { recursive: true })
writeFileSync(path.join(dirs.workspace, "src/app.ts"), "export const a = 1\nexport const b = 2\nexport const c = 3\n")
for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "init"]])
  execFileSync("git", args, { cwd: dirs.workspace })
writeFileSync(path.join(dirs.workspace, "src/app.ts"), "export const a = 1\nexport const b = 20\nexport const c = 3\n")

// A signed-in test account, as `kete login` would leave it (file store, so no keychain is touched).
await KeteAccount.save(
  { config: path.join(xdg.XDG_CONFIG_HOME, "kete"), data: path.join(xdg.XDG_DATA_HOME, "kete"), native: undefined },
  {
    platform_url: "http://127.0.0.1:9",
    gateway_url: "http://127.0.0.1:9",
    organization: { id: "00000000-0000-4000-8000-000000000001", name: "E2E Org" },
    key_id: "00000000-0000-4000-8000-000000000002",
    device_name: "e2e",
  },
  "kete_test_e2e_not_a_real_key",
)

// A synced organization whose one MCP server runs a command: it must wait for the developer's approval.
const managed = path.join(xdg.XDG_CONFIG_HOME, "kete", "managed", "00000000-0000-4000-8000-000000000001")
mkdirSync(managed, { recursive: true })
writeFileSync(
  path.join(managed, "agents.json"),
  JSON.stringify({
    version: 1,
    etag: '"e2e"',
    synced_at: new Date().toISOString(),
    response: {
      organization: { id: "00000000-0000-4000-8000-000000000001", name: "E2E Org" },
      generated_at: new Date().toISOString(),
      agents: [],
      mcp_servers: [
        {
          key: "jira",
          name: "Jira",
          description: "",
          transport: "stdio",
          url: null,
          command: "npx -y @acme/mcp-jira",
          version: "1",
          credential: { type: "none", ref: null, expires_at: null },
          tools: [],
        },
      ],
      skills: [],
    },
  }),
)

const isolated = [`--user-data-dir=${dirs.user}`, `--extensions-dir=${dirs.extensions}`]
execFileSync(code, [...isolated, "--install-extension", path.resolve(vsix)], { stdio: "inherit" })
const installed = readdirSync(dirs.extensions).find((name) => name.startsWith("ketecode.kete-code-"))
if (!installed) throw new Error("the extension did not install")
const extension = path.join(dirs.extensions, installed)
const binary = path.join(extension, "bin", process.platform === "win32" ? "kete.exe" : "kete")
const executable = (() => {
  try {
    accessSync(binary, constants.X_OK)
    return true
  } catch {
    return false
  }
})()
console.log(`installed ${installed}; bundled binary executable: ${executable}`)

// One existing session in the workspace, for the Sessions view and session links (no model needed).
const sessionFile = path.join(root, "session.json")
const now = Date.now()
writeFileSync(
  sessionFile,
  JSON.stringify({
    info: {
      id: "ses_e2e_existing",
      projectID: "global",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now },
      title: "E2E existing session",
      location: { directory: dirs.workspace },
    },
    messages: [],
  }),
)
execFileSync(binary, ["session", "import", sessionFile, "--standalone", "--directory", dirs.workspace], {
  cwd: dirs.workspace,
  env: { ...process.env, ...xdg },
  stdio: "inherit",
})

execFileSync("bun", ["build", path.join(import.meta.dir, "../test/e2e/suite.ts"), "--target=node", "--format=cjs", "--external=vscode", `--outfile=${path.join(root, "suite.js")}`], { stdio: "ignore" })

console.log(`running VS Code (${root})`)
const child = spawn(
  electron,
  [
    ...isolated,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    `--extensionDevelopmentPath=${extension}`,
    `--extensionTestsPath=${path.join(root, "suite.js")}`,
    "--new-window",
    dirs.workspace,
  ],
  { env: { ...process.env, ...xdg, KETE_E2E_OUT: dirs.out }, stdio: "inherit" },
)
const exit = await new Promise<number | null>((resolve) => child.on("exit", resolve))
await Bun.sleep(2_000)
// pgrep exits 1 when nothing matches: no server outlived the window.
const leftovers = spawnSync("pgrep", ["-f", binary], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length
console.log(JSON.stringify({ exit, results: JSON.parse(readFileSync(dirs.out, "utf8")), leftoverServers: leftovers }, null, 2))
