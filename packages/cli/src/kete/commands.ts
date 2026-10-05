// Kete account commands, spread into the upstream command tree (src/commands/commands.ts). They sign in
// to a Kete Code account; `kete auth` stays upstream's command for model-provider keys.

import { Schema } from "effect"
import { Argument, Flag, GlobalFlag } from "effect/unstable/cli"
import { Brand } from "@opencode/util/kete/brand"
import { Spec } from "../framework/spec"

// Same text as upstream `ServerParams` (`commands/commands.ts:17-26`), which isn't exported.
const ServerParams = {
  standalone: Flag.boolean("standalone").pipe(
    Flag.withDescription("Run with a private server instead of the background service"),
    Flag.withDefault(false),
  ),
  server: Flag.string("server").pipe(
    Flag.withDescription("Connect to a server URL instead of the background service"),
    Flag.optional,
  ),
}

/** `--offline` on every command (framework/runtime.ts). The value is acted on before parsing, by
 * ./offline-startup.ts, so the environment is set before any module reads it; this definition makes
 * the parser accept the flag and shows it in help. */
export const Offline = GlobalFlag.setting("offline")({
  flag: Flag.boolean("offline").pipe(
    Flag.withDescription(
      "Offline mode: use only local models (Ollama, LM Studio, vLLM, or a provider on this machine or a private network) and make no other network calls (same as KETE_OFFLINE=1)",
    ),
    Flag.withDefault(false),
  ),
})

/** `kete models pull <name>`: a subcommand of upstream's `models` command (commands/commands.ts). */
export const modelsPull = Spec.make("pull", {
  description: "Download a model into Ollama (the Ollama server Kete Code uses: config, KETE_OLLAMA_HOST, OLLAMA_HOST or localhost)",
  params: {
    name: Argument.string("name").pipe(Argument.withDescription("Ollama model name, e.g. llama3.2 or qwen2.5-coder:7b")),
    ...ServerParams,
  },
})

/** Flags for the built-in presets on upstream's `kete mcp add` (commands/commands.ts); see ./mcp-preset.ts. */
export const mcpPresetParams = {
  write: Flag.boolean("write").pipe(
    Flag.withDescription("Preset harness: turn read-only mode off (write and execute tools still ask first)"),
    Flag.withDefault(false),
  ),
  org: Flag.string("org").pipe(Flag.withDescription("Preset harness: default Harness organization"), Flag.optional),
  project: Flag.string("project").pipe(Flag.withDescription("Preset harness: default Harness project"), Flag.optional),
  baseUrl: Flag.string("base-url").pipe(
    Flag.withDescription("Preset harness: Harness URL for self-managed Harness (default https://app.harness.io)"),
    Flag.optional,
  ),
  clientId: Flag.string("client-id").pipe(
    Flag.withDescription("Preset slack: client ID of the approved Slack app to sign in with"),
    Flag.optional,
  ),
  newKey: Flag.boolean("new-key").pipe(
    Flag.withDescription("Preset harness: ask for a new API key instead of reusing the stored one"),
    Flag.withDefault(false),
  ),
}

/** `kete mcp presets`: a subcommand of upstream's `mcp` command. */
export const mcpPresets = Spec.make("presets", {
  description: "List the built-in MCP server presets (add one with `kete mcp add <preset>`)",
})

export const specs = [
  Spec.make("login", {
    description: `Sign in to your ${Brand.displayName} account in the browser (for model provider keys, use \`${Brand.cliName} auth login\`)`,
    params: {
      platformUrl: Flag.string("platform-url").pipe(
        Flag.withDescription(`${Brand.displayName} platform URL (default: KETE_PLATFORM_URL, then kete.platform.url in your config)`),
        Flag.optional,
      ),
      port: Flag.integer("port").pipe(
        Flag.withDescription("Fixed local port for the browser callback, e.g. to forward it with ssh -L (default: a random free port)"),
        Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024), Schema.isLessThanOrEqualTo(65_535))),
        Flag.optional,
      ),
      noBrowser: Flag.boolean("no-browser").pipe(
        Flag.withDescription("Print the sign-in URL without opening a browser"),
        Flag.withDefault(false),
      ),
    },
  }),
  Spec.make("logout", {
    description: `Sign out of your ${Brand.displayName} account and revoke this device's key`,
  }),
  Spec.make("sync", {
    description: `Sync the agents, skills and MCP servers your organization manages on the ${Brand.displayName} platform (also runs at startup and every 5 minutes)`,
    params: {
      approve: Flag.string("approve").pipe(
        Flag.withDescription("Let a synced MCP server run its command on this machine (shown by kete sync); needed again if the command changes"),
        Flag.optional,
      ),
      command: Flag.string("command").pipe(
        Flag.withDescription("With --approve: the exact command you reviewed; refuses if the synced command is different"),
        Flag.optional,
      ),
      status: Flag.boolean("status").pipe(
        Flag.withDescription("Show the synced MCP servers and what each needs, from the last sync, without a network request"),
        Flag.withDefault(false),
      ),
      format: Flag.choice("format", ["default", "json"]).pipe(
        Flag.withDescription("Output format for --status"),
        Flag.withDefault("default"),
      ),
    },
  }),
  Spec.make("whoami", {
    description: `Show the signed-in ${Brand.displayName} account (never the key)`,
    params: {
      format: Flag.choice("format", ["default", "json"]).pipe(
        Flag.withDescription("Output format; json reads only local state and makes no network request"),
        Flag.withDefault("default"),
      ),
    },
  }),
  Spec.make("job", {
    description: "Run unattended jobs (ADR 0005/0008)",
    commands: [
      Spec.make("run", {
        description: `Run ${Brand.displayName} unattended from a job spec file, in its own git worktree and branch`,
        params: {
          spec: Argument.string("spec").pipe(Argument.withDescription("Path to the job spec JSON file")),
          ...ServerParams,
          json: Flag.boolean("json").pipe(
            Flag.withDescription("Print exactly one JSON result object to stdout instead of the run's own output"),
            Flag.withDefault(false),
          ),
          trustProjectConfig: Flag.boolean("trust-project-config").pipe(
            Flag.withDescription(
              "Let the repository's own config set providers, MCP servers, plugins and Kete integration settings (also KETE_TRUST_PROJECT_CONFIG=1)",
            ),
            Flag.withDefault(false),
          ),
        },
      }),
    ],
  }),
] as const
export * as KeteCommands from "./commands"
