// Kete Code settings, under the `kete` key of the configuration. Kete-owned, so upstream
// config sections never conflict with it on sync.
export * as ConfigKete from "./kete.js"

import { Schema } from "effect"
import { PositiveInt, optional } from "../schema.js"

export class Budget extends Schema.Class<Budget>("ConfigKete.Budget")({
  session: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(optional).annotate({
    description:
      "Spend in USD after which a session pauses and asks before its next model request. Each approval allows another amount of the same size. It uses the `budget` permission action: a rule with effect `allow` never asks, `deny` stops the session.",
  }),
}) {}

export class Platform extends Schema.Class<Platform>("ConfigKete.Platform")({
  url: Schema.String.pipe(optional).annotate({
    description:
      "Kete platform URL (e.g. https://kete.example). Gateway models then use the platform's prices. Falls back to KETE_PLATFORM_URL.",
  }),
}) {}

export class Runtime extends Schema.Class<Runtime>("ConfigKete.Runtime")({
  type: Schema.Literals(["local", "kete_cloud", "enterprise_private"]).pipe(optional).annotate({
    description:
      'Where this runtime runs: "local" (a developer\'s machine, the default), "kete_cloud" (a Kete-managed sandbox) or "enterprise_private" (an enterprise-managed runtime). Falls back to KETE_RUNTIME_TYPE when unset here; a value set here always wins over the variable. `kete whoami` reads only the global config, so a project-level value here changes what the platform sees but not what `kete whoami` prints. The `kete` object doesn\'t merge across config files field by field: a project config that sets `runtime` needs its other `kete` settings repeated in the same file.',
  }),
}) {}

export class Subagents extends Schema.Class<Subagents>("ConfigKete.Subagents")({
  timeout: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(optional).annotate({
    description:
      "Minutes a subagent may run before it is stopped and reported to its parent as failed. Defaults to 60; 0 means no limit.",
  }),
  max_concurrent: PositiveInt.pipe(optional).annotate({
    description: "Subagents one session may have running at the same time. Defaults to 4.",
  }),
  worktree: Schema.Literals(["never", "background"]).pipe(optional).annotate({
    description:
      'When a new subagent runs in its own git worktree without being asked to: "background" for background subagents whose agent may edit files, so parallel agents never share a checkout (they start from the last commit, without your uncommitted changes). Defaults to "never". The subagent tool\'s `worktree` input always wins.',
  }),
}) {}

const StepID = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/)).annotate({
  description: "Lowercase letters, digits, - and _",
})

export class WorkflowStep extends Schema.Class<WorkflowStep>("ConfigKete.WorkflowStep")({
  id: StepID.annotate({ description: "The step's name, unique in the workflow; others refer to it" }),
  agent: Schema.String.annotate({ description: "The agent that does the step, run as a subagent" }),
  prompt: Schema.String.annotate({
    description:
      "The step's task. {{input}} is the workflow's input; {{steps.<id>}} is the final answer of an earlier step this one comes after.",
  }),
  after: StepID.pipe(Schema.Array, optional).annotate({ description: "Steps that must finish first" }),
  worktree: Schema.Boolean.pipe(optional).annotate({
    description: "Run the step in its own git worktree on a new branch (as the subagent tool's `worktree`)",
  }),
  continue: StepID.pipe(optional).annotate({
    description:
      "Continue that earlier step's subagent session (and so its worktree) instead of starting a new one; implies `after` it",
  }),
}) {}

export class Workflow extends Schema.Class<Workflow>("ConfigKete.Workflow")({
  description: Schema.String.pipe(optional).annotate({ description: "What the workflow is for" }),
  steps: WorkflowStep.pipe(Schema.Array).annotate({
    description: "The steps. Steps whose earlier steps have finished run at the same time.",
  }),
}) {}

export class SlackIntegration extends Schema.Class<SlackIntegration>("ConfigKete.SlackIntegration")({
  clientId: Schema.String.pipe(optional).annotate({
    description:
      "Client ID of the Slack app `kete mcp add slack` signs in with (a Slack Marketplace or internal app that a workspace admin has approved). `--client-id` wins; without either, the organization's synced Slack app is used when the platform provides one.",
  }),
}) {}

export class Integrations extends Schema.Class<Integrations>("ConfigKete.Integrations")({
  slack: SlackIntegration.pipe(optional).annotate({ description: "The Slack MCP preset" }),
}) {}

export class Unattended extends Schema.Class<Unattended>("ConfigKete.Unattended")({
  passEnv: Schema.String.pipe(Schema.Array, optional).annotate({
    description:
      "Environment variables an unattended run's shell commands keep although they look like credentials (e.g. NPM_TOKEN for a private registry). Kete's own credentials are never passed. kete job run refuses a repository config that sets it unless the run trusts that config (--trust-project-config).",
  }),
}) {}

const SandboxPaths = Schema.String.pipe(Schema.Array, optional)

export class Sandbox extends Schema.Class<Sandbox>("ConfigKete.Sandbox")({
  mode: Schema.Literals(["auto", "required", "off"]).pipe(optional).annotate({
    description:
      'The OS sandbox for shell commands the agent runs (docs/sandbox.md). "auto" (the default): sandboxed where the platform supports it (macOS, Linux with bubblewrap), otherwise run unsandboxed and shown as such. "required": refuse commands when no sandbox is available. "off": no sandbox. Only the global config (or KETE_SANDBOX) can turn it off; a project config can only make it stricter.',
  }),
  network: Schema.Literals(["approved", "none", "all"]).pipe(optional).annotate({
    description:
      'Network access inside the sandbox. "approved" (the default): only commands a person approved (a prompt, a saved "Always allow" or an unattended policy) can use the network; the rest reach only this machine. "none": never. "all": always. Only the global config can loosen it.',
  }),
  caches: Schema.Boolean.pipe(optional).annotate({
    description:
      "Whether sandboxed commands may write the package managers' and build tools' caches (npm, bun, pnpm, yarn, pip, uv, cargo, Go, Gradle, Maven). Defaults to true. A project config can only turn it off.",
  }),
  loopback: Schema.Boolean.pipe(optional).annotate({
    description:
      "macOS: whether sandboxed commands without network may still reach services on this machine (127.0.0.1 and its own addresses: databases, dev servers, a TCP-exposed Docker). Defaults to true (test suites connect to local servers). false blocks them; a project config can set false but not true. Linux sandboxes have their own loopback either way.",
  }),
  allowWrite: SandboxPaths.annotate({
    description:
      "More paths sandboxed commands may write (absolute, or starting with ~/). Protected paths (.git internals, Kete Code configuration) stay read-only. Read only from the global config.",
  }),
  allowRead: SandboxPaths.annotate({
    description:
      "Credential paths sandboxed commands may read after all (e.g. ~/.npmrc for a private registry). Read only from the global config.",
  }),
  denyRead: SandboxPaths.annotate({
    description: "More paths sandboxed commands can't read (absolute, ~/, or relative to the workspace).",
  }),
  denyWrite: SandboxPaths.annotate({
    description: "More paths sandboxed commands can't write (absolute, ~/, or relative to the workspace).",
  }),
}) {}


export const HookEvents = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart", "Notification"] as const
export type HookEvent = (typeof HookEvents)[number]

export class Hook extends Schema.Class<Hook>("ConfigKete.Hook")({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)).annotate({
    description:
      "Shell command to run (sh -c on macOS/Linux, cmd.exe on Windows) in the project directory. It gets the event as JSON on stdin; see docs/hooks.md for exit codes and output.",
  }),
  match: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(optional).annotate({
    description:
      'PreToolUse/PostToolUse only: the tool names this hook runs for, as a wildcard pattern (`shell`, `edit|write|patch`, `mcp_*`). Every tool when unset.',
  }),
  timeout: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(600)).pipe(optional).annotate({
    description: "Seconds before the command is stopped (1-600, default 60).",
  }),
}) {}

const hookList = (description: string) => Schema.Array(Hook).pipe(optional).annotate({ description })

export class Hooks extends Schema.Class<Hooks>("ConfigKete.Hooks")({
  PreToolUse: hookList("Before a tool runs; can block it (exit code 2, or {\"decision\":\"deny\"})."),
  PostToolUse: hookList("After a tool ran; can add context for the agent."),
  UserPromptSubmit: hookList("When a prompt is sent; can add context for the agent."),
  Stop: hookList("When the agent finishes its turn."),
  SessionStart: hookList("When a session is created; can add context for the agent."),
  Notification: hookList("When Kete Code needs you (a permission prompt or a question)."),
}) {}

export class Lsp extends Schema.Class<Lsp>("ConfigKete.Lsp")({
  unsandboxed: Schema.Boolean.pipe(optional).annotate({
    description:
      "Start language servers even when the OS sandbox isn't active (turned off, unavailable, Windows). Off by default: servers then run the project's code with your full access. Read only from the global config; a policy denying sandbox_off always wins.",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigKete.Info")({
  offline: Schema.Boolean.pipe(optional).annotate({
    description:
      "Offline mode: only local models (Ollama, LM Studio, vLLM, and providers on this machine or a private network) are used, and platform sync, gateway calls, update checks, remote MCP servers and web fetch/search are off. Cached organization policy still applies. The --offline flag and KETE_OFFLINE do the same. Only the global config can turn off the model catalog fetch and update checks; a project config turns off everything else.",
  }),
  budget: Budget.pipe(optional).annotate({ description: "Spending limits" }),
  platform: Platform.pipe(optional).annotate({ description: "Kete platform connection" }),
  runtime: Runtime.pipe(optional).annotate({ description: "Where this runtime runs" }),
  subagents: Subagents.pipe(optional).annotate({ description: "Limits for subagents" }),
  workflows: Schema.Record(Schema.String, Workflow).pipe(optional).annotate({
    description: "Reusable workflows that run agents in order, by name; run them with the workflow tool or /<name>",
  }),
  integrations: Integrations.pipe(optional).annotate({
    description: "Settings for the built-in MCP presets (`kete mcp presets`)",
  }),
  unattended: Unattended.pipe(optional).annotate({
    description: "Settings for unattended runs (kete job run)",
  }),
  sandbox: Sandbox.pipe(optional).annotate({
    description: "The OS sandbox for shell commands the agent runs (docs/sandbox.md)",
  }),
  hooks: Hooks.pipe(optional).annotate({
    description:
      "Shell commands run at points of the agent loop (docs/hooks.md). Hooks in a project's config run only after you trust them.",
  }),
  lsp: Lsp.pipe(optional).annotate({
    description: "Kete Code's language server settings; the servers themselves are configured under the top-level `lsp` key (docs/lsp.md)",
  }),
}) {}
