// The platform's sync contract, v1 (docs/platform/sync-v1.md; source of truth:
// kete-code-platform packages/shared/src/api/v1/sync.ts). Decoding ignores unknown fields: v1 only
// gains optional fields.

import { Schema } from "effect"

const Guid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i))
const Text = (max: number, min = 0) => Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max))

export const AgentSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/), Schema.isMaxLength(60))

/** Ordered; the last matching rule wins. The runtime's own permission rule shape. */
export const PermissionRule = Schema.Struct({
  action: Text(200, 1),
  resource: Text(500, 1),
  effect: Schema.Literals(["allow", "ask", "deny"]),
})

/** A shell command pattern (platform ADR 0009); informational, already compiled into `shell` rules. */
const ShellPattern = Text(200)

export const AgentTools = Schema.Struct({
  edit: Schema.Boolean,
  shell: Schema.Boolean,
  web: Schema.Boolean,
  shell_allow: Schema.optional(Schema.Array(ShellPattern)),
  shell_ask: Schema.optional(Schema.Array(ShellPattern)),
  skills: Schema.Array(AgentSlug),
  subagents: Schema.Array(AgentSlug),
  mcp: Schema.Record(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
    Schema.Union([Schema.Literal("*"), Schema.Array(Text(128, 1))]),
  ),
})

export const ProviderId = Schema.Literals(["anthropic", "openai", "gemini", "deepseek", "openrouter"])

export const SyncedAgent = Schema.Struct({
  id: Guid,
  slug: AgentSlug,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  name: Text(60, 1),
  description: Text(300),
  mode: Schema.Literals(["primary", "subagent"]),
  /** Only with mode "primary": the agent may also run as a subagent. Absent means false. */
  delegable: Schema.optional(Schema.Boolean),
  model: Schema.Struct({ provider: ProviderId, model_id: Text(200, 1) }),
  instructions: Text(20_000),
  tools: AgentTools,
  permissions: Schema.Array(PermissionRule).check(Schema.isMaxLength(1000)),
  budget: Schema.Struct({
    monthly_micros: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    spent_micros: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    period: Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/)),
  }),
})
export type SyncedAgent = typeof SyncedAgent.Type

/** An MCP server's name in tool lists and permission rules (`<key>_<tool>`). */
export const McpServerKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))

/** An MCP server an agent may use. No secret is ever synced: `credential.ref` says where it lives. */
export const SyncedMcpServer = Schema.Struct({
  key: McpServerKey,
  name: Text(60, 1),
  description: Text(300),
  transport: Schema.Literals(["http", "sse", "stdio"]),
  url: Schema.NullOr(Text(500)),
  /** For stdio: run on the developer's machine only after they approve it (and again when it changes). */
  command: Schema.NullOr(Text(500)),
  version: Text(40),
  credential: Schema.Struct({
    type: Schema.Literals(["oauth", "api_key", "service_account", "none"]),
    ref: Schema.NullOr(Text(200)),
    expires_at: Schema.NullOr(Schema.String),
  }),
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,100}$/)),
      description: Text(300),
      risk: Schema.Literals(["read", "write", "destructive"]),
      requires_approval: Schema.Boolean,
    }),
  ),
})
export type SyncedMcpServer = typeof SyncedMcpServer.Type

/** A supporting file of a skill; contents from GET /api/v1/sync/skills/{id}/files. */
export const SkillFileEntry = Schema.Struct({
  path: Text(300, 1),
  size_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  /** A script: never run without the developer's approval. */
  executable: Schema.Boolean,
})

export const SyncedSkill = Schema.Struct({
  id: Guid,
  slug: AgentSlug,
  name: Text(80, 1),
  description: Text(300),
  version: Schema.String.check(Schema.isPattern(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)),
  instructions: Text(50_000),
  requires_mcp: Schema.Array(McpServerKey),
  files: Schema.Array(SkillFileEntry).check(Schema.isMaxLength(50)),
})
export type SyncedSkill = typeof SyncedSkill.Type

/** One compiled rule of an organization policy (`require_approval` already became `ask`). */
export const PolicyRule = Schema.Struct({
  action: Text(200, 1),
  resource: Text(200, 1),
  effect: Schema.Literals(["allow", "ask", "deny"]),
  description: Text(200),
})
export type PolicyRule = typeof PolicyRule.Type

/**
 * An organization policy, enforced on top of every agent's permissions (./policy.ts). Category and
 * environment kinds are read as plain strings, so a value a newer platform adds doesn't fail the sync.
 */
export const SyncedPolicy = Schema.Struct({
  id: Guid,
  name: Text(80, 1),
  description: Text(500),
  category: Text(40),
  enforcement: Schema.Literals(["enforced", "audit_only"]),
  environment_kinds: Schema.Array(Text(40)),
  /** null: every session; otherwise only sessions running these synced agents. */
  agents: Schema.NullOr(Schema.Array(AgentSlug)),
  rules: Schema.Array(PolicyRule).check(Schema.isMaxLength(50)),
  updated_at: Schema.String,
})
export type SyncedPolicy = typeof SyncedPolicy.Type

export const SyncResponse = Schema.Struct({
  organization: Schema.Struct({ id: Guid, name: Schema.String }),
  generated_at: Schema.String,
  agents: Schema.Array(SyncedAgent),
  /** Added in v1; absent from older platforms, so optional (treat as []). */
  mcp_servers: Schema.optional(Schema.Array(SyncedMcpServer)),
  skills: Schema.optional(Schema.Array(SyncedSkill)),
  /** Added in v1 (platform runtime-registration-policies); absent means the platform serves none. */
  policies: Schema.optional(Schema.Array(SyncedPolicy)),
  /** Being added by the platform (Slack integration task): organization integration settings, e.g.
   * `integrations.slack.client_id`. Loosely typed so a shape this runtime doesn't know never fails a
   * sync; read it through ./integrations.ts. Absent means none. */
  integrations: Schema.optional(Schema.Unknown),
})

/** GET /api/v1/sync/skills/{id}/files → 200 */
export const SkillFilesResponse = Schema.Struct({
  skill: Schema.Struct({ id: Guid, slug: AgentSlug }),
  files: Schema.Array(
    Schema.Struct({
      path: Text(300, 1),
      size_bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      executable: Schema.Boolean,
      content: Text(100_000),
    }),
  ).check(Schema.isMaxLength(50)),
})
export type SyncResponse = typeof SyncResponse.Type

export const ErrorResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String, request_id: Schema.optional(Schema.String) }),
})

export * as KeteSyncContract from "./contract.js"
