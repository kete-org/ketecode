// Kete account commands, spread into the upstream command tree (src/commands/commands.ts). They sign in
// to a Kete Code account; `kete auth` stays upstream's command for model-provider keys.

import { Schema } from "effect"
import { Argument, Flag, GlobalFlag } from "effect/unstable/cli"
import { Brand } from "@opencode/util/kete/brand"
import { Spec } from "../framework/spec"
import { KeteCompletion } from "./completion"

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

/** `--trust-project-config` on upstream's `kete run` (commands/commands.ts): trusts the folder's project
 * config for that run only (./folder-trust.ts). Same text as `kete job run`'s flag below. */
export const trustParams = {
  trustProjectConfig: Flag.boolean("trust-project-config").pipe(
    Flag.withDescription(
      "Let the repository's own config set providers, MCP servers, plugins and Kete integration settings (also KETE_TRUST_PROJECT_CONFIG=1)",
    ),
    Flag.withDefault(false),
  ),
}

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
  Spec.make("sandbox", {
    description: `Show whether the shell commands the agent runs go through ${Brand.displayName}'s OS sandbox (docs/sandbox.md)`,
    params: {
      ...ServerParams,
      format: Flag.choice("format", ["default", "json"]).pipe(
        Flag.withDescription("Output format"),
        Flag.withDefault("default"),
      ),
    },
  }),
  Spec.make("trust", {
    description: `List the folders whose project config you trust (docs/folder-trust.md)`,
    params: {
      format: Flag.choice("format", ["default", "json"]).pipe(Flag.withDescription("Output format"), Flag.withDefault("default")),
    },
    commands: [
      Spec.make("list", {
        description: "List the folders whose project config you trust",
        params: {
          format: Flag.choice("format", ["default", "json"]).pipe(Flag.withDescription("Output format"), Flag.withDefault("default")),
        },
      }),
      Spec.make("add", {
        description: "Trust a folder's project config: MCP servers, plugins, providers and the other settings held back until you do",
        params: {
          path: Argument.string("path").pipe(Argument.withDescription("Folder to trust (default: the current directory)"), Argument.optional),
        },
      }),
      Spec.make("remove", {
        description: "Stop trusting a folder's project config (and its project hooks)",
        params: {
          path: Argument.string("path").pipe(Argument.withDescription("Folder to stop trusting (default: the current directory)"), Argument.optional),
        },
      }),
    ],
  }),
  Spec.make("skill", {
    description: "Install, list, update and remove skills from a git repository or a local folder",
    commands: [
      Spec.make("add", {
        description: `Install a skill after showing what it contains; pinned to the commit in skills.lock.json. Nothing in it runs at install`,
        params: {
          source: Argument.string("source").pipe(Argument.withDescription("A git URL (https://, ssh://, git@host:path), owner/repo on GitHub, or a local folder")),
          path: Flag.string("path").pipe(Flag.withDescription("Folder inside the source that holds SKILL.md"), Flag.optional),
          ref: Flag.string("ref").pipe(Flag.withDescription("Branch, tag or commit of a git source (default: its default branch)"), Flag.optional),
          name: Flag.string("name").pipe(Flag.withDescription("Name to install it as (default: the name in SKILL.md, else the folder name)"), Flag.optional),
          global: Flag.boolean("global").pipe(Flag.withDescription("Install for every project (the global config folder)"), Flag.withDefault(false)),
          yes: Flag.boolean("yes").pipe(Flag.withDescription("Install without asking (an organization policy can still require it)"), Flag.withDefault(false)),
        },
      }),
      Spec.make("list", {
        description: "List installed skills, other local skills, and skills your organization manages",
        params: { global: Flag.boolean("global").pipe(Flag.withDescription("List the global skills"), Flag.withDefault(false)) },
      }),
      Spec.make("update", {
        description: "Update installed skills to the latest commit of their ref, showing what changed first",
        params: {
          name: Argument.string("name").pipe(Argument.withDescription("Skill to update (default: all)"), Argument.optional),
          global: Flag.boolean("global").pipe(Flag.withDescription("Update the global skills"), Flag.withDefault(false)),
          yes: Flag.boolean("yes").pipe(Flag.withDescription("Update without asking (edited files and organization policy still ask)"), Flag.withDefault(false)),
        },
      }),
      Spec.make("remove", {
        description: "Remove a skill installed with `kete skill add`",
        params: {
          name: Argument.string("name").pipe(Argument.withDescription("Skill to remove")),
          global: Flag.boolean("global").pipe(Flag.withDescription("Remove a global skill"), Flag.withDefault(false)),
          yes: Flag.boolean("yes").pipe(Flag.withDescription("Remove without asking"), Flag.withDefault(false)),
        },
      }),
    ],
  }),
  Spec.make("completion", {
    description: `Print a shell completion script for ${Brand.cliName} (run without a shell for install lines)`,
    params: {
      shell: Argument.choice("shell", KeteCompletion.shells).pipe(
        Argument.withDescription("Shell to print the script for: bash, zsh, fish or powershell"),
        Argument.optional,
      ),
    },
  }),
  Spec.make("bug", {
    description: `Report a problem: shows a privacy-safe report to review, saves it to a file, and offers to open a GitHub issue with it`,
    params: {
      description: Argument.string("description").pipe(
        Argument.withDescription("What went wrong (optional; it becomes the issue title)"),
        Argument.variadic({ min: 0 }),
      ),
      print: Flag.boolean("print").pipe(
        Flag.withDescription("Only print the report and save it to a file: never ask, never open a browser"),
        Flag.withDefault(false),
      ),
      ...ServerParams,
    },
  }),
  Spec.make("terminal-setup", {
    description: `Make Shift+Enter insert a newline in the prompt: says what this terminal needs, and adds the keybinding for VS Code, Cursor, Windsurf or VSCodium after asking`,
    params: {
      editor: Flag.choice("editor", ["code", "insiders", "cursor", "windsurf", "vscodium"]).pipe(
        Flag.withDescription("The editor whose terminal to set up, when it can't be told from the environment"),
        Flag.optional,
      ),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Add the keybinding without asking"), Flag.withDefault(false)),
      print: Flag.boolean("print").pipe(Flag.withDescription("Only print what to do; change nothing"), Flag.withDefault(false)),
    },
  }),
  Spec.make("doctor", {
    description: `Check this install: config files, folder trust, models, MCP servers, the OS sandbox and the terminal (makes no network request beyond the local runtime)`,
    params: {
      ...ServerParams,
      format: Flag.choice("format", ["default", "json"]).pipe(Flag.withDescription("Output format"), Flag.withDefault("default")),
    },
  }),
  Spec.make("share", {
    description: `Share a session's redacted transcript with your organization on the ${Brand.displayName} portal, after showing what is sent (docs/sharing.md)`,
    params: {
      sessionID: Argument.string("session-id").pipe(
        Argument.withDescription("Session to share (default: the newest session in this folder)"),
        Argument.optional,
      ),
      link: Flag.boolean("link").pipe(
        Flag.withDescription("Let anyone with the link read it (only if your organization allows it)"),
        Flag.withDefault(false),
      ),
      yes: Flag.boolean("yes").pipe(Flag.withDescription("Upload without asking"), Flag.withDefault(false)),
      ...ServerParams,
    },
  }),
  Spec.make("unshare", {
    description: "Delete a session's shared copy from the portal",
    params: {
      sessionID: Argument.string("session-id").pipe(
        Argument.withDescription("Session to unshare (default: the newest session in this folder)"),
        Argument.optional,
      ),
      ...ServerParams,
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
