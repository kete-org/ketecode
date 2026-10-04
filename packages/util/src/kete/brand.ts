// Kete Code product identity: the single source of truth for names, directory
// names, config filenames, the environment-variable prefix, and product URLs.
//
// Upstream OpenCode code reads these values at the few places where the product
// identity is defined (each such edit carries a `kete_change` marker). Keep this
// module dependency-free: it is imported from every engine package, including
// code that runs before the CLI has finished starting.

/** Human-readable product name for user-facing text. */
export const displayName = "Kete Code"

/** Binary / command name, e.g. `kete run`. */
export const cliName = "kete"

/** Directory name under the XDG base directories (~/.config/kete, ~/.local/share/kete, ...). */
export const appDirectory = "kete"

/** Project-level config directory, discovered in the working directory and its ancestors. */
export const projectDirectory = ".kete"

/** Config filenames, in load order (later wins). */
export const configFiles = ["kete.json", "kete.jsonc"] as const

/** Prefix for user-facing environment variables. There is deliberately no OPENCODE_ fallback. */
export const envPrefix = "KETE_"

/** Prefix for files the runtime creates inside its own directories (database, logs). */
export const filePrefix = "kete"

/** Short product mark used where space is tight, e.g. terminal titles (`KC | <session>`). */
export const shortName = "KC"

/**
 * Self-update is available: `kete upgrade` (packages/cli/src/kete/updater.ts) downloads releases
 * from `urls.releases` only, and installs one only after verifying the Ed25519 signature on its
 * SHA256SUMS against a key pinned in the binary and the archive's checksum (ADR 0009). It never
 * downloads upstream OpenCode binaries. A build without a pinned key reports updates as
 * unavailable (updatesUnavailableMessage) instead of installing anything unverified.
 */
export const updatesAvailable = true

/** Why a build can't update itself: it has no pinned update signing key, so nothing it downloads could be verified. */
export const updatesUnavailableMessage = "Updates are not available for this build of Kete Code: it has no pinned update signing key."

// Product URLs. Kete Code has no public domain yet, so these are deliberately
// undefined rather than guessed: callers omit the link (or the `$schema` key)
// instead of pointing users at an address nobody controls.
export const urls: {
  readonly configSchema: string | undefined
  readonly docs: string | undefined
  readonly issues: string | undefined
  readonly platform: string | undefined
  readonly releases: string
  readonly upstream: string
  readonly website: string | undefined
} = {
  // TODO(kete): publish the Kete Code config JSON schema and set its URL here.
  configSchema: undefined,
  // TODO(kete): set the Kete Code documentation URL once it exists.
  docs: undefined,
  // TODO(kete): set the Kete Code issue tracker URL once it is public.
  issues: undefined,
  // TODO(kete): set the production Kete Code platform URL, the default for `kete login`. Until then
  // `kete login` needs --platform-url, KETE_PLATFORM_URL or `kete.platform.url`.
  platform: undefined,
  // Public downloads (ADR 0009): every release's CLI archives, SHA256SUMS, SHA256SUMS.sig (Ed25519,
  // what `kete upgrade` verifies) and SHA256SUMS.sigstore.json (cosign keyless, what the install
  // scripts verify). The source repository stays private; this one holds only release files.
  releases: "https://github.com/kete-org/kete-releases",
  upstream: "https://github.com/anomalyco/opencode",
  // TODO(kete): set the Kete Code website once it exists. It is also the `HTTP-Referer` that
  // credits Kete Code to model providers (see `attribution`); until then no referer is sent.
  website: undefined,
}

/**
 * How Kete Code identifies itself to model providers that credit the calling app
 * (core/src/kete/attribution.ts). These are display values, not registrations: see
 * docs/upstream-patches.md ("Provider attribution") for each provider's documentation.
 */
export const attribution = {
  /** `X-Title` / `X-OpenRouter-Title` (OpenRouter, Vercel, Kilo, LLM Gateway, ZenMux, NVIDIA). */
  title: displayName,
  /** NVIDIA `X-BILLING-INVOKE-ORIGIN`. */
  nvidiaOrigin: "KeteCode",
  /** Cerebras `X-Cerebras-3rd-Party-Integration`. */
  cerebrasIntegration: "kete-code",
} as const

/** The package-manager names of the CLI (ADR 0009), for the messages that point users at them. */
export const distribution = {
  /** npm: a launcher plus one optional dependency per platform (`@ketecode/cli-darwin-arm64`, …). */
  npmPackage: "@ketecode/cli",
  /** Homebrew: the formula in the kete-org/homebrew-tap repository. */
  homebrewFormula: "kete-org/tap/kete",
} as const

export * as Brand from "./brand.js"
