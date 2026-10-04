// Which `kete` binary the extension runs. Each platform-specific .vsix carries its own binary in
// bin/ (see packages/kete-tools/src/release.ts); `kete.cliPath` overrides it for development. The
// PATH is never searched: the extension must run the binary it was tested with.
// Kept free of the `vscode` module so it can be unit-tested with Bun.

import { access, chmod, constants, stat } from "node:fs/promises"
import path from "node:path"

/** VS Code's --target names → the CLI build target bundled for it (packages/cli/script/build.ts). */
export const targets = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64-baseline",
  "linux-x64": "linux-x64-baseline",
  "linux-arm64": "linux-arm64",
  "alpine-x64": "linux-x64-baseline-musl",
  "alpine-arm64": "linux-arm64-musl",
  "win32-x64": "windows-x64-baseline",
  "win32-arm64": "windows-arm64",
} as const

export type Resolved =
  | { readonly ok: true; readonly path: string; readonly source: "setting" | "bundled" }
  | { readonly ok: false; readonly error: string }

export function executableName(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? "kete.exe" : "kete"
}

/** The binary to run: the `kete.cliPath` setting when set, else the one bundled in the extension. */
export async function resolve(input: {
  extensionPath: string
  setting?: string
  platform?: NodeJS.Platform
}): Promise<Resolved> {
  const platform = input.platform ?? process.platform
  const setting = input.setting?.trim()
  if (setting) {
    if (!path.isAbsolute(setting))
      return { ok: false, error: `kete.cliPath must be an absolute path to the kete binary (got "${setting}").` }
    const problem = await usable(setting, platform)
    return problem ? { ok: false, error: `kete.cliPath: ${problem}` } : { ok: true, path: setting, source: "setting" }
  }
  const bundled = path.join(input.extensionPath, "bin", executableName(platform))
  const problem = await usable(bundled, platform)
  if (!problem) return { ok: true, path: bundled, source: "bundled" }
  return {
    ok: false,
    error:
      "This build of the Kete Code extension has no kete binary for this platform. Install the extension for your platform from the Marketplace or Open VSX, or set kete.cliPath to a kete binary (for development).",
  }
}

/** Why the file can't be run, or undefined. Restores a missing executable bit (unzip tools can drop it). */
async function usable(file: string, platform: NodeJS.Platform) {
  const info = await stat(file).catch(() => undefined)
  if (!info) return `${file} does not exist`
  if (!info.isFile()) return `${file} is not a file`
  if (platform === "win32") return undefined
  const executable = await access(file, constants.X_OK).then(
    () => true,
    () => false,
  )
  if (executable) return undefined
  return chmod(file, info.mode | 0o755).then(
    () => undefined,
    () => `${file} is not executable`,
  )
}
