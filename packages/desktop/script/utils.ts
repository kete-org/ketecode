import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Option, Schema } from "effect"

const CLI_VERSION = "latest" // kete_change: Kete Code publishes stable CLIs under npm's "latest" tag, prereleases under "next"

const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString }))

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = process.env.OPENCODE_CHANNEL

  if (raw === "dev" || raw === "beta" || raw === "prod") return raw

  if (raw === "latest") return "prod"

  return "dev"
}

// kete_change start: Kete Code's npm platform packages (kete-tools/src/distribute.ts `npmPlatforms`), named on use,
// and the directory `cli/script/build.ts` writes each target to. Brand loads lazily: electron.vite.config.ts
// imports this file under Node, whose loader can't follow util's `.js` specifiers to its `.ts` sources.
const ketePackage = (suffix: string) => suffix
const brand = () => import("@opencode/util/kete/brand").then((module) => module.Brand)
const npmName = async (suffix: string) => `${(await brand()).distribution.npmPackage}-${suffix}`
// kete_change end

export const CLI_BINARIES: Array<{ target: string; package: string; directory: string; os: string; cpu: string }> = [ // kete_change: directory
  {
    target: "darwin-arm64",
    package: ketePackage("darwin-arm64"), // kete_change
    directory: "cli-darwin-arm64", // kete_change
    os: "darwin",
    cpu: "arm64",
  },
  {
    target: "darwin-x64",
    package: ketePackage("darwin-x64"), // kete_change
    directory: "cli-darwin-x64-baseline", // kete_change
    os: "darwin",
    cpu: "x64",
  },
  {
    target: "windows-arm64",
    package: ketePackage("windows-arm64"), // kete_change
    directory: "cli-windows-arm64", // kete_change
    os: "win32",
    cpu: "arm64",
  },
  {
    target: "windows-x64",
    package: ketePackage("windows-x64"), // kete_change
    directory: "cli-windows-x64-baseline", // kete_change
    os: "win32",
    cpu: "x64",
  },
  {
    target: "linux-x64",
    package: ketePackage("linux-x64"), // kete_change
    directory: "cli-linux-x64-baseline", // kete_change
    os: "linux",
    cpu: "x64",
  },
  {
    target: "linux-arm64",
    package: ketePackage("linux-arm64"), // kete_change
    directory: "cli-linux-arm64", // kete_change
    os: "linux",
    cpu: "arm64",
  },
]

function nativeTarget() {
  const { platform, arch } = process

  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64"

  if (platform === "win32") return arch === "arm64" ? "windows-arm64" : "windows-x64"

  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = process.env.OPENCODE_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_BINARIES.find((item) => item.target === target)

  if (!binaryConfig) throw new Error(`CLI configuration not available for target '${target}'`)

  return binaryConfig
}

export function nodePtyPackage(target?: string) {
  const cli = getCurrentCli(target)

  return `@lydell/node-pty-${cli.os}-${cli.cpu}`
}

export async function downloadCliToResources(version = CLI_VERSION, dest = windowsify("resources/opencode-cli")) {
  const { $ } = await import("bun")
  const cli = getCurrentCli()
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-"))

  try {
    const name = await npmName(cli.package) // kete_change
    await $`bun install --no-save --cwd ${directory} ${`${name}@${version}`} ${`--os=${cli.os}`} ${`--cpu=${cli.cpu}`}` // kete_change: name
    await copyCliToResources(join(directory, "node_modules", name), dest) // kete_change: name
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  console.log(`Copied ${await npmName(cli.package)}@${version} to ${dest}`) // kete_change
}

export async function copyBuiltCliToResources(root: string, dest = windowsify("resources/opencode-cli")) {
  const cli = getCurrentCli()
  await copyCliToResources(join(root, cli.directory), dest) // kete_change
}

// The package directory is an npm package: its package.json version is the string the executable
// prints for --version. Writing it next to the executable spares the desktop a ~400 ms spawn of the
// 200 MB binary on first launch.
async function copyCliToResources(pkg: string, dest: string) {
  const cli = getCurrentCli()
  const { cliName } = await brand() // kete_change
  await copyFile(join(pkg, "bin", cli.os === "win32" ? `${cliName}.exe` : cliName), dest) // kete_change
  await prepareCli(dest)

  const manifest = Option.getOrUndefined(
    Schema.decodeUnknownOption(Manifest)(await Bun.file(join(pkg, "package.json")).text()),
  )

  if (!manifest) throw new Error(`Bundled CLI package has no version: ${pkg}`)
  await Bun.write(versionFile(dest), manifest.version)
}

export function versionFile(cli: string) {
  return join(dirname(cli), "opencode-cli.version")
}

async function prepareCli(dest: string) {
  const { $ } = await import("bun")

  if (process.platform !== "win32") await chmod(dest, 0o755)

  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path

  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
