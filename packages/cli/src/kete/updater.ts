// Kete Code's updater (ADR 0009). Implements upstream's Updater interface, so `kete upgrade`, the
// background check and the TUI's update dialog all use it, but it never downloads upstream OpenCode
// binaries and never runs a package manager or an installer script:
//
// - Releases come from Brand.urls.releases (kete-org/kete-releases) only. The latest version is read
//   from the latest release's signed SHA256SUMS, not from an API, so it is authenticated too.
// - Nothing is installed unless SHA256SUMS's Ed25519 signature verifies against a key pinned in this
//   binary (update-keys.json) and the downloaded archive matches its checksum. No pinned key, no
//   update: check() reports "unavailable" and install refuses.
// - Only a binary installed directly (the install scripts, or an unpacked archive) replaces itself.
//   Homebrew and npm installs are told to update with their package manager; the copy bundled in the
//   editor extension updates with the extension; a source build doesn't update.
// - Never a downgrade, never the same version again.
// - The new binary is staged next to the old one (same filesystem), checked with `--version`, and
//   swapped in with one rename (Windows: rename the running exe aside, then rename the new one in,
//   rolling back if that fails). An interrupted upgrade leaves the old binary in place.
import { Brand } from "@opencode/util/kete/brand"
import { Global } from "@opencode/util/global"
import { execFile } from "node:child_process"
import crypto from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Updater, decodePolicy, type Policy } from "../services/updater"
import { OPENCODE_CHANNEL, OPENCODE_VERSION } from "../version"
import { ReleaseVerify, type PinnedKey } from "./release-verify"

declare const KETE_TARGET: string | undefined

export type UpdateErrorCode =
  | "unavailable" // no pinned key, a source build, or an unknown target
  | "managed" // a package manager or the editor extension owns this binary
  | "current" // that version is already installed
  | "downgrade" // older than the installed version
  | "invalid" // not a release version
  | "verify" // signature, checksum, archive or new-binary check failed
  | "network"
  | "permission" // can't write the binary's directory
  | "platform" // the release has no build for this target

export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "UpdateError"
  }
}

export type Install =
  | { readonly kind: "direct"; readonly executable: string }
  | { readonly kind: "homebrew" }
  | { readonly kind: "npm" }
  | { readonly kind: "extension" }
  | { readonly kind: "source" }

export interface Deps {
  /** The public releases repository, e.g. https://github.com/kete-org/kete-releases. */
  readonly releases: string
  readonly keys: readonly PinnedKey[]
  /** The running binary's version and channel ("local" for a source checkout or local build). */
  readonly version: string
  readonly channel: string
  /** The running binary's build target (KETE_TARGET, set by packages/cli/script/build.ts). */
  readonly target: string | undefined
  readonly execPath: string
  readonly platform: NodeJS.Platform
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>
  /** Extracts one member of an archive into `directory`. */
  readonly extract: (archive: string, member: string, directory: string, signal: AbortSignal) => Promise<void>
  /** Runs `<binary> --version` and returns its output. */
  readonly probe: (binary: string, signal: AbortSignal) => Promise<string>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly maxArchiveBytes?: number
}

const metadataTimeout = 15_000
const downloadTimeout = 10 * 60_000
const defaultMaxArchiveBytes = 1024 * 1024 * 1024

const managedMessages: Record<Exclude<Install["kind"], "direct">, string> = {
  homebrew: `${Brand.displayName} was installed with Homebrew. Update it with: brew upgrade ${Brand.cliName}`,
  npm: `${Brand.displayName} was installed with npm or another Node package manager. Update it with: npm install -g ${Brand.distribution.npmPackage}@latest (or your package manager's equivalent)`,
  extension: `This ${Brand.cliName} is bundled with the ${Brand.displayName} editor extension and updates with the extension.`,
  source: `This ${Brand.cliName} is a source checkout or a local build, which doesn't update itself. Install a release from ${Brand.urls.releases}.`,
}

/** How this binary was installed, from where it actually lives. */
export async function detect(deps: Pick<Deps, "channel" | "version" | "execPath">): Promise<Install> {
  if (deps.channel === "local" || !ReleaseVerify.isVersion(deps.version)) return { kind: "source" }
  const executable = await fs.realpath(deps.execPath).catch(() => deps.execPath)
  const segments = executable.split(/[\\/]+/)
  const cellar = segments.indexOf("Cellar")
  if (cellar !== -1 && segments[cellar + 1] === Brand.cliName) return { kind: "homebrew" }
  if (segments.includes("node_modules")) return { kind: "npm" }
  if (segments.some((segment) => segment.toLowerCase().startsWith("ketecode.kete-code"))) return { kind: "extension" }
  return { kind: "direct", executable }
}

async function fetchBytes(deps: Deps, url: string, limit: number, signal: AbortSignal) {
  const response = await deps.fetch(url, { signal }).catch((cause: unknown) => {
    throw new UpdateError(
      "network",
      `Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    )
  })
  if (!response.ok) throw new UpdateError("network", `${url} returned HTTP ${response.status}.`)
  // Read with a cap, so a hostile host can't make the updater buffer an unbounded response.
  if (!response.body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.length
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw new UpdateError("verify", `${url} is larger than expected.`)
    }
    chunks.push(chunk.value)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** The verified release `ref` names: "latest" or an exact version. */
export async function signedRelease(deps: Deps, ref: "latest" | string, signal: AbortSignal) {
  if (deps.keys.length === 0) throw new UpdateError("unavailable", Brand.updatesUnavailableMessage)
  if (ref !== "latest" && !ReleaseVerify.isVersion(ref))
    throw new UpdateError("invalid", `Not a release version: ${ref}`)
  const base =
    ref === "latest" ? `${deps.releases}/releases/latest/download` : `${deps.releases}/releases/download/kete-v${ref}`
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(metadataTimeout)])
  const [checksums, signature] = await Promise.all([
    fetchBytes(deps, `${base}/SHA256SUMS`, 64 * 1024, timeout),
    fetchBytes(deps, `${base}/SHA256SUMS.sig`, 1024, timeout),
  ])
  const release = (() => {
    try {
      return ReleaseVerify.verifyRelease({ checksums, signature, keys: deps.keys })
    } catch (cause) {
      throw new UpdateError("verify", cause instanceof Error ? cause.message : String(cause), { cause })
    }
  })()
  if (ref !== "latest" && release.version !== ref)
    throw new UpdateError("verify", `The signed SHA256SUMS for ${ref} describes version ${release.version}.`)
  return release
}

/** The archive, hashed while it streams to `file`; throws on a checksum mismatch. */
async function download(deps: Deps, url: string, file: string, sha256: string, signal: AbortSignal) {
  const response = await deps.fetch(url, { signal }).catch((cause: unknown) => {
    throw new UpdateError(
      "network",
      `Could not download ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    )
  })
  if (!response.ok || !response.body) throw new UpdateError("network", `${url} returned HTTP ${response.status}.`)
  const limit = deps.maxArchiveBytes ?? defaultMaxArchiveBytes
  const hash = crypto.createHash("sha256")
  const handle = await fs.open(file, "wx", 0o600)
  let size = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > limit) throw new UpdateError("verify", `${url} is larger than ${limit} bytes.`)
      hash.update(chunk.value)
      await handle.write(chunk.value)
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  const actual = hash.digest("hex")
  if (actual !== sha256)
    throw new UpdateError(
      "verify",
      `The downloaded archive's SHA-256 (${actual}) doesn't match the signed SHA256SUMS (${sha256}).`,
    )
}

/** Swaps `staged` in for `executable`. On failure the old binary stays (or is put back). */
async function replace(deps: Deps, staged: string, executable: string) {
  if (deps.platform !== "win32") return deps.rename(staged, executable)
  // A running .exe can't be overwritten or deleted on Windows, but it can be renamed.
  const aside = `${executable}.${crypto.randomBytes(4).toString("hex")}.old`
  await deps.rename(executable, aside)
  try {
    await deps.rename(staged, executable)
  } catch (cause) {
    try {
      await deps.rename(aside, executable)
    } catch (rollback) {
      throw new UpdateError(
        "verify",
        `The upgrade failed and the previous ${Brand.cliName} couldn't be put back: it is at ${aside}. Rename it to ${executable}.`,
        { cause: new AggregateError([cause, rollback]) },
      )
    }
    throw cause
  }
  // Fails while the old binary is still running; a later upgrade removes it.
  await fs.rm(aside, { force: true }).catch(() => undefined)
}

/** Removes `<exe>.*.old` left by earlier Windows upgrades (best effort: a running one stays). */
async function removeStale(executable: string) {
  const directory = path.dirname(executable)
  const prefix = `${path.basename(executable)}.`
  const names = await fs.readdir(directory).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".old"))
      .map((name) => fs.rm(path.join(directory, name), { force: true }).catch(() => undefined)),
  )
}

/** Installs exactly `version` over this binary, verified end to end. */
export async function install(deps: Deps, version: string, signal: AbortSignal = new AbortController().signal) {
  if (deps.keys.length === 0) throw new UpdateError("unavailable", Brand.updatesUnavailableMessage)
  const installed = await detect(deps)
  if (installed.kind !== "direct") throw new UpdateError("managed", managedMessages[installed.kind])
  const target = deps.target
  if (!ReleaseVerify.isTarget(target))
    throw new UpdateError("unavailable", `This build doesn't know its release target (${target ?? "none"}).`)
  if (!ReleaseVerify.isVersion(version)) throw new UpdateError("invalid", `Not a release version: ${version}`)
  const order = ReleaseVerify.compareVersions(version, deps.version)
  if (order === 0) throw new UpdateError("current", `${Brand.displayName} ${version} is already installed.`)
  if (order < 0)
    throw new UpdateError(
      "downgrade",
      `Refusing to downgrade from ${deps.version} to ${version}. To install an older version, use the install script with --version.`,
    )

  const release = await signedRelease(deps, version, signal)
  const archive = release.archives.get(target)
  if (!archive) throw new UpdateError("platform", `Release ${version} has no build for ${target}.`)

  const executable = installed.executable
  const directory = path.dirname(executable)
  try {
    await fs.access(directory, fsConstants.W_OK)
    await fs.access(executable, fsConstants.W_OK)
  } catch (cause) {
    throw new UpdateError(
      "permission",
      `Can't replace ${executable}: no write permission there. Reinstall with the install script into a directory you own, or update it the way it was installed.`,
      { cause },
    )
  }

  const member = deps.platform === "win32" ? `${Brand.cliName}.exe` : Brand.cliName
  // Inside the binary's own directory, so the final rename never crosses filesystems.
  const staging = await fs.mkdtemp(path.join(directory, `.${Brand.cliName}-upgrade-`))
  try {
    const file = path.join(staging, archive.name)
    await download(
      deps,
      `${deps.releases}/releases/download/kete-v${version}/${archive.name}`,
      file,
      archive.sha256,
      AbortSignal.any([signal, AbortSignal.timeout(downloadTimeout)]),
    )
    const out = path.join(staging, "out")
    await fs.mkdir(out)
    try {
      await deps.extract(file, member, out, signal)
    } catch (cause) {
      throw new UpdateError(
        "verify",
        `Could not unpack ${archive.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause,
        },
      )
    }
    const staged = path.join(out, member)
    const stat = await fs.lstat(staged).catch(() => undefined)
    if (!stat?.isFile() || stat.size === 0) throw new UpdateError("verify", `${archive.name} has no ${member}.`)
    if (deps.platform !== "win32") await fs.chmod(staged, 0o755)
    const reported = await deps.probe(staged, signal).catch((cause: unknown) => {
      throw new UpdateError(
        "verify",
        `The new ${Brand.cliName} doesn't run on this machine: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause,
        },
      )
    })
    if (!reported.split(/\s+/).some((word) => word === version || word === `v${version}`))
      throw new UpdateError(
        "verify",
        `The new ${Brand.cliName} reports ${JSON.stringify(reported.trim().slice(0, 80))}, not ${version}.`,
      )
    if (deps.platform === "win32") await removeStale(executable)
    await replace(deps, staged, executable)
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

const isDisabled = () => ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")

async function readPolicy(configDirectory: string): Promise<Policy> {
  const values = await Promise.all(
    ["config.json", ...Brand.configFiles].map((name) =>
      fs.readFile(path.join(configDirectory, name), "utf8").then(decodePolicy, () => undefined),
    ),
  )
  return values.findLast((value) => value !== undefined) ?? "notify"
}

const run = (file: string, args: readonly string[], signal: AbortSignal, timeout: number) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      file,
      [...args],
      { signal, timeout, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message, { cause: error }))
        else resolve(stdout)
      },
    )
  })

/** The real environment: this binary, the public releases repository, the pinned keys. */
export function defaultDeps(): Deps {
  return {
    releases: Brand.urls.releases,
    keys: ReleaseVerify.pinnedKeys(),
    version: OPENCODE_VERSION,
    channel: OPENCODE_CHANNEL,
    target: typeof KETE_TARGET === "string" ? KETE_TARGET : undefined,
    execPath: process.execPath,
    platform: process.platform,
    fetch: (url, init) => fetch(url, { signal: init.signal, redirect: "follow" }),
    // bsdtar (macOS, Windows 10+) reads .zip and .tar.gz; Linux releases are .tar.gz for GNU tar. On
    // Windows, System32's bsdtar by full path: a GNU tar earlier on the PATH (Git Bash) can't read zip.
    extract: async (archive, member, directory, signal) => {
      const tar =
        process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"
      await run(tar, ["-xf", archive, "-C", directory, member], signal, 120_000)
    },
    probe: (binary, signal) => run(binary, ["--version"], signal, 60_000),
    rename: (from, to) => fs.rename(from, to),
  }
}

const describe = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

export function make(deps: Deps, configDirectory: string) {
  const latest = () =>
    Effect.tryPromise({ try: (signal) => signedRelease(deps, "latest", signal), catch: describe }).pipe(
      Effect.map((release) => release.version),
    )
  const newer = (version: string) => ReleaseVerify.compareVersions(version, deps.version) > 0
  const installVersion = (version: string) =>
    Effect.tryPromise({ try: (signal) => install(deps, version, signal), catch: describe })

  return Updater.Service.of({
    run: Effect.fn("cli.kete-updater.run")(
      function* (onInstall: (version: string) => void = () => {}) {
        if (deps.keys.length === 0 || isDisabled()) return undefined
        const installed = yield* Effect.promise(() => detect(deps))
        // The extension's copy updates with the extension; a source build never does.
        if (installed.kind === "extension" || installed.kind === "source") return undefined
        const policy = yield* Effect.promise(() => readPolicy(configDirectory))
        if (policy === "disable") return undefined
        const version = yield* latest()
        if (!newer(version)) return undefined
        yield* Effect.logInfo("Kete Code update available", { current: deps.version, latest: version, policy })
        // Package-manager installs only ever get the notice: their manager does the update.
        if (policy === "notify" || installed.kind !== "direct") return { type: "available" as const, version }
        onInstall(version)
        yield* installVersion(version)
        return { type: "installed" as const, version }
      },
      Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
    ),
    check: Effect.fn("cli.kete-updater.check")(function* () {
      const installed = yield* Effect.promise(() => detect(deps))
      if (installed.kind === "extension" || installed.kind === "source")
        return { type: "unavailable" as const, message: managedMessages[installed.kind] }
      if (deps.keys.length === 0) return { type: "unavailable" as const, message: Brand.updatesUnavailableMessage }
      const version = yield* latest()
      return newer(version) ? { type: "available" as const, version } : undefined
    }),
    apply: (version: string) => installVersion(version),
    method: () =>
      Effect.promise(() => detect(deps)).pipe(
        Effect.map((installed) =>
          installed.kind === "direct"
            ? ("curl" as const)
            : installed.kind === "homebrew"
              ? ("brew" as const)
              : installed.kind === "npm"
                ? ("npm" as const)
                : undefined,
        ),
      ),
    latest,
    // Only the direct install ("curl", the install scripts) is replaced here; install() refuses the rest.
    upgrade: (method, version) =>
      method === "curl"
        ? installVersion(version.trim().replace(/^v/, ""))
        : Effect.fail(new UpdateError("managed", method === "brew" ? managedMessages.homebrew : managedMessages.npm)),
    removal: () => undefined,
  })
}

/** Messages for installs this updater never replaces, for `kete upgrade`. */
export const managed = managedMessages

export const layer = Layer.effect(
  Updater.Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    return make(defaultDeps(), global.config)
  }),
)

export * as KeteUpdater from "./updater"
