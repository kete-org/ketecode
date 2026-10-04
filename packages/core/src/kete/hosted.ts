// Defaults for OpenCode's hosted services that Kete Code inherits from upstream.
//
// Kete Code must not send code to a third-party hosted service unless the user
// explicitly chose it (CLAUDE.md §9, Privacy). Upstream enables some of these
// services out of the box; the switches below turn those defaults off while
// leaving the explicit opt-in paths intact.

/**
 * Anonymous access to OpenCode Zen (provider `opencode`).
 *
 * Upstream force-enables the `opencode` provider with the shared key "public"
 * when the user has no OpenCode credentials, so its free models are usable
 * out of the box and prompts are sent to opencode.ai. Kete Code keeps the
 * provider available only through an explicit opt-in:
 *
 * - `kete auth login` with an OpenCode Console account or API key,
 * - the provider's API key in the environment, or
 * - a `providers.opencode` entry in the config file. For anonymous access to
 *   the free models only: `{ "providers": { "opencode": { "settings": { "apiKey": "public" } } } }`
 *   (v1 syntax: `{ "provider": { "opencode": { "options": { "apiKey": "public" } } } }`).
 */
export const anonymousOpencodeZen = false

export * as KeteHosted from "./hosted.js"
