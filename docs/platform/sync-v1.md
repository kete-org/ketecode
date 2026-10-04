<!-- Copied from kete-code-platform docs/contracts/sync-v1.md at commit 474a9f7 (kete-org/ketecode-portal#37, 2026-09-28). The platform copy is the source of truth; update both together. -->

# Sync API contract — v1

Standalone copy of the `GET /api/v1/sync` contract for the `kete-code` repository. The
source of truth is `packages/shared/src/api/v1/sync.ts` in `kete-code-platform`; the
schema block below is kept identical to it, and a test there fails if they differ. Design: `docs/agents.md`; decisions: ADR 0008 and ADR 0009.

## Request

```http
GET /api/v1/sync HTTP/1.1
Host: portal.<domain>
Authorization: Bearer kete_live_…
If-None-Match: "k7Hq2y1ZfV0mYc8Q3xRtVb6sPpLwN9aE4uJ5dGhT0oI"
```

- `Authorization`: a Kete API key (the one `kete login` stores). Same rules as
  `/api/v1/me`: missing, malformed, unknown, revoked or expired keys get
  `401 invalid_key`.
- `If-None-Match` (optional): the `ETag` from the last `200`.

## Responses

| Status | When | Body |
|---|---|---|
| `200` | the agents changed, or no `If-None-Match` | `SyncResponse`; headers `ETag`, `Cache-Control: no-store`, `x-kete-request-id` |
| `304` | `If-None-Match` equals the current ETag | none; headers `ETag`, `x-kete-request-id` |
| `401 invalid_key` | bad key | error body |
| `500 internal` | the platform couldn't build the response | error body |

Every response carries `x-kete-request-id`. Errors use the platform error shape.

- **ETag:** strong; covers the whole body except `generated_at`. It changes when any
  agent, tier mapping, tool flag or this month's spend changes.
- **Agents:** only enabled agents whose model resolves. Paused agents, and agents whose
  tier is unmapped or whose model is disabled, are left out. An agent missing from a
  new response has been removed or paused: drop it from the cache. `mode` is only
  `primary` or `subagent`; a platform agent that's both (mode `all`) is sent as
  `mode: "primary", delegable: true`. `delegable` is present only when true, so an
  agent's body — and the organization's ETag — never change for agents this doesn't
  touch. A runtime that doesn't know `delegable` ignores it and keeps treating the
  agent as primary only (ADR 0017).
- **Permissions:** ordered; the **last** matching rule wins; nothing matching means
  `ask`. Apply them after local global rules so they override those. Wildcards are
  `*` and `?`; MCP tools are `<server>_<tool>`.
- **Budget:** informational (`spent_micros` as of `generated_at`). The gateway enforces
  it. Send `x-kete-agent-id: <id>` and `x-kete-agent-version: <version>` with every
  model call the agent makes.
- **MCP servers and skills:** `mcp_servers` holds every server a synced agent names in
  `tools.mcp`, and `skills` every skill one names in `tools.skills`; tool lists name only
  what the response contains. Kete never connects to MCP servers and never syncs a
  secret: `credential.ref` says where the runtime finds the credential. For a `stdio`
  server, `command` runs on the developer's machine: show it and ask before running it
  the first time and whenever it changes. When `tools_discovered` is true, the server's
  tools come from the server itself when the runtime connects; a `<key>_*` rule (never
  looser than `ask`) covers the ones `tools` doesn't list. Skill files marked `executable` are scripts:
  ask before running them.
- **Skill files:** `skills[].files` is a manifest. Download contents from
  `GET /api/v1/sync/skills/{id}/files` (below), and again only for files whose `sha256`
  changed.
- **Tools:** informational; the permissions already enforce the tool list, including
  `shell_allow` (commands allowed without asking) and `shell_ask` (commands that always
  ask), which are compiled into `shell` rules (ADR 0009).
- **Policies:** `policies` holds the organization's `enforced` and `audit_only` policies
  that apply to every session (`agents: null`) or to sessions running the listed synced
  agents. Enforce them on top of every agent's permissions and local configuration.
  Within one policy, read the rules in order: `deny` and `ask` accumulate (`deny` beats
  `ask` whatever the order) and a matching `allow` clears the rules before it, an explicit
  exception. Across policies the most restrictive result wins (`deny` over `ask` over no
  effect). A policy never loosens an agent's own rules. `audit_only` blocks
  nothing (report what it would block). A local runtime is `development`: skip a policy
  whose `environment_kinds` is non-empty and doesn't include it. **Fail closed:** a
  runtime that is signed in but has never loaded its organization's policies asks before
  every edit, command and web request until it has.
- **Compatibility:** v1 only gains optional fields. Ignore unknown fields; anything
  breaking ships as `/api/v2`.

## Schemas (Zod)

```ts
import { z } from 'zod'
import { ProviderId } from '../../providers'

/**
 * GET /api/v1/sync — platform-managed agents for the runtime (ADR 0008, docs/agents.md).
 *
 * Authenticated with a Kete API key. Returns the organization's enabled agents as plain,
 * concrete definitions: tiers are already resolved to a model and autonomy levels to
 * permission rules, so the runtime never sees either. Supports ETag / If-None-Match.
 * Standalone copy for the kete-code repo: docs/contracts/sync-v1.md.
 */

/** The response's `ETag`; send it back as `If-None-Match` to get 304 when nothing changed. */
export const SYNC_ETAG_HEADER = 'etag'
export const SYNC_IF_NONE_MATCH_HEADER = 'if-none-match'

/** Lowercase words joined by hyphens, as agent slugs are stored. */
export const AgentSlug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60)

/**
 * One permission rule, in the runtime's native form. Rules are ordered and the LAST
 * matching rule wins; `action` and `resource` are wildcard patterns (`*`, `?`).
 * Actions include `read`, `glob`, `grep`, `edit`, `shell`, `webfetch`, `websearch`,
 * `question`, `skill`, `subagent`, `external_directory` and MCP tools as
 * `<server>_<tool>`.
 */
export const PermissionRule = z.object({
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(500),
  effect: z.enum(['allow', 'ask', 'deny']),
})
export type PermissionRule = z.infer<typeof PermissionRule>

/**
 * What the agent may use at all, as configured on the platform. Informational: the
 * `permissions` rules are what the runtime enforces, and they already deny anything
 * outside this list. `skills`, `subagents` and `mcp` name only what this response
 * contains (synced skills, agents and servers).
 */
/**
 * A shell command pattern (ADR 0009): starts like a command, never with a wildcard, and
 * has no shell control characters. Matched as a prefix pattern, like the other rules.
 */
export const ShellPattern = z
  .string()
  .max(200, 'A command pattern can be at most 200 characters.')
  .regex(/^[A-Za-z0-9._/-][^;&|<>`$\p{Cc}]*$/u, 'A command pattern starts with the command (not *) and can’t contain ; & | < > ` or $.')
export type ShellPattern = z.infer<typeof ShellPattern>

export const AgentTools = z.object({
  edit: z.boolean(),
  shell: z.boolean(),
  web: z.boolean(),
  /** Commands that run without asking at every level, while `shell` is on (added in v1; defaults to []). */
  shell_allow: z.array(ShellPattern).max(50).default([]),
  /** Commands that always ask, even when `shell_allow` or the level would allow them (defaults to []). */
  shell_ask: z.array(ShellPattern).max(50).default([]),
  skills: z.array(AgentSlug),
  subagents: z.array(AgentSlug),
  /** MCP server name → every tool (`"*"`) or the listed tool names. */
  mcp: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.union([z.literal('*'), z.array(z.string().min(1).max(128))])),
})
export type AgentTools = z.infer<typeof AgentTools>

export const SyncedAgent = z.object({
  id: z.guid(),
  slug: AgentSlug,
  /** Increments on every saved change (agent_versions); send it with gateway requests. */
  version: z.number().int().positive(),
  name: z.string().min(1).max(60),
  description: z.string().max(300),
  mode: z.enum(['primary', 'subagent']),
  /**
   * Only with mode `primary`: the agent may also run as a subagent (platform mode
   * `all`). Absent means false. A released runtime that doesn't know this field
   * ignores it and keeps treating the agent as primary only — safe, it just can't be
   * delegated to yet (ADR 0017).
   */
  delegable: z.boolean().optional(),
  /** The concrete model, resolved from the agent's tier or override. */
  model: z.object({ provider: ProviderId, model_id: z.string().min(1).max(200) }),
  /** Markdown; the agent's system prompt. */
  instructions: z.string().max(20000),
  tools: AgentTools,
  /** Resolved from the agent's autonomy level and tool list; ordered, last match wins. */
  permissions: z.array(PermissionRule).max(1000),
  budget: z.object({
    /** USD micros per calendar month (UTC); null when the agent has no budget of its own. */
    monthly_micros: z.number().int().positive().nullable(),
    /** Spent this month, as of `generated_at`. The gateway enforces the budget. */
    spent_micros: z.number().int().nonnegative(),
    /** The calendar month, UTC, as YYYY-MM. */
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  }),
})
export type SyncedAgent = z.infer<typeof SyncedAgent>

/** An MCP server's name in tool lists and permission rules (`<key>_<tool>`). */
export const McpServerKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/**
 * An MCP server an agent may use. Kete never connects to it: the runtime does, with a
 * credential it finds from `credential.ref` on the developer's machine. No secret is
 * ever synced.
 */
export const SyncedMcpServer = z.object({
  key: McpServerKey,
  name: z.string().min(1).max(60),
  description: z.string().max(300),
  transport: z.enum(['http', 'sse', 'stdio']),
  /** For `http` and `sse`. */
  url: z.string().max(500).nullable(),
  /**
   * For `stdio`: the command the runtime starts on the developer's machine. The runtime
   * must show it and ask before running it the first time, and again when it changes.
   */
  command: z.string().max(500).nullable(),
  version: z.string().max(40),
  credential: z.object({
    type: z.enum(['oauth', 'api_key', 'service_account', 'none']),
    /** Where the credential lives (a vault path, an app name); never the secret. */
    ref: z.string().max(200).nullable(),
    expires_at: z.iso.datetime({ offset: true }).nullable(),
  }),
  /**
   * The server's tools are discovered when it connects: `permissions` then carry a
   * `<key>_*` rule (ask at most) for tools not listed here. Added in v1; defaults to false.
   */
  tools_discovered: z.boolean().default(false),
  /** Enabled tools only; `permissions` decide which each agent may call. */
  tools: z.array(
    z.object({
      name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
      description: z.string().max(300),
      risk: z.enum(['read', 'write', 'destructive']),
      requires_approval: z.boolean(),
    }),
  ),
})
export type SyncedMcpServer = z.infer<typeof SyncedMcpServer>

/** A supporting file of a skill: fetch contents from GET /api/v1/sync/skills/{id}/files. */
export const SkillFileEntry = z.object({
  /** Relative to the skill's folder. */
  path: z.string().min(1).max(300),
  size_bytes: z.number().int().nonnegative(),
  /** Hex SHA-256 of the UTF-8 content: download again only when it changes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** A script that can run on the developer's machine: ask before running it. */
  executable: z.boolean(),
})
export type SkillFileEntry = z.infer<typeof SkillFileEntry>

/** A skill an agent may load (named in its `tools.skills`). */
export const SyncedSkill = z.object({
  /** For the files endpoint. */
  id: z.guid(),
  slug: AgentSlug,
  name: z.string().min(1).max(80),
  description: z.string().max(300),
  version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  /** Markdown; loaded into the agent's context when the skill is used. */
  instructions: z.string().max(50000),
  /** Keys of the MCP servers the skill expects (informational). */
  requires_mcp: z.array(McpServerKey),
  files: z.array(SkillFileEntry).max(50),
})
export type SyncedSkill = z.infer<typeof SyncedSkill>

/**
 * One rule of an organization policy (docs/security.md §1.3), compiled for the runtime:
 * `require_approval` becomes `ask`, and a rule whose portal `conditions` the runtime can't
 * evaluate is kept only when it restricts (`deny`, `ask`). Actions and resources are the
 * permission rules' own (`shell` + `git push*`, `edit` + `.github/workflows/*`); actions the
 * runtime doesn't have (`deploy`, `marketplace.install`) never match anything there.
 */
export const PolicyRule = z.object({
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(200),
  effect: z.enum(['allow', 'ask', 'deny']),
  description: z.string().max(200),
})
export type PolicyRule = z.infer<typeof PolicyRule>

/**
 * An organization policy the runtime enforces on top of every agent's permissions. Within a
 * policy, rules are read in order: `deny` and `ask` accumulate (deny beats ask whatever the
 * order, so a broader `ask` never weakens an earlier `deny`), and a matching `allow` clears
 * the rules before it (an explicit exception). Across policies the most restrictive result
 * wins, and a policy never loosens an agent's own rules. `audit_only` policies are sent so the runtime can report what they would block;
 * they block nothing. Project-assigned policies aren't sent (the runtime has no projects).
 */
export const SyncedPolicy = z.object({
  id: z.guid(),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  category: z.enum(['governance', 'security', 'production', 'cost', 'data']),
  enforcement: z.enum(['enforced', 'audit_only']),
  /** Where it applies: a local runtime is `development`. Empty means everywhere. */
  environment_kinds: z.array(z.enum(['development', 'staging', 'production'])),
  /** `null`: every session. Otherwise only sessions running these synced agents. */
  agents: z.array(AgentSlug).nullable(),
  rules: z.array(PolicyRule).max(50),
  /** ISO 8601; changes whenever the policy or its rules change. */
  updated_at: z.iso.datetime({ offset: true }),
})
export type SyncedPolicy = z.infer<typeof SyncedPolicy>

/** GET /api/v1/sync → 200 */
export const SyncResponse = z.object({
  organization: z.object({ id: z.guid(), name: z.string() }),
  /** ISO 8601 UTC. Not part of the ETag. */
  generated_at: z.iso.datetime(),
  /** Enabled agents only; paused agents and agents whose model can't be resolved are left out. */
  agents: z.array(SyncedAgent),
  /** The MCP servers synced agents name in `tools.mcp` (added in v1; defaults to []). */
  mcp_servers: z.array(SyncedMcpServer).default([]),
  /** The skills synced agents name in `tools.skills` (added in v1; defaults to []). */
  skills: z.array(SyncedSkill).default([]),
  /**
   * The organization's enforced and audit-only policies (added in v1; defaults to []).
   * A runtime that is signed in but has never loaded them must fail closed: ask before
   * every edit, command and web request until it has.
   */
  policies: z.array(SyncedPolicy).default([]),
})
export type SyncResponse = z.infer<typeof SyncResponse>

/** GET /api/v1/sync/skills/{id}/files → 200: every supporting file of one skill. */
export const SkillFilesResponse = z.object({
  skill: z.object({ id: z.guid(), slug: AgentSlug }),
  files: z.array(SkillFileEntry.extend({ content: z.string().max(100000) })).max(50),
})
export type SkillFilesResponse = z.infer<typeof SkillFilesResponse>
```

`ProviderId` is `z.enum(['anthropic', 'openai', 'gemini', 'deepseek', 'openrouter'])`.
The error body:

```ts
export const ErrorResponse = z.object({
  error: z.object({
    code: z.enum(['invalid_request', 'invalid_key', 'forbidden', 'not_found', 'expired', 'rate_limited', 'internal']),
    message: z.string(),
    request_id: z.string(),
  }),
})
```

## Example: 200

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
ETag: "k7Hq2y1ZfV0mYc8Q3xRtVb6sPpLwN9aE4uJ5dGhT0oI"
x-kete-request-id: 5d0b1f7e-2c4a-4e8b-9f3d-7a6c5b4e3d2f
```

```json
{
  "organization": {
    "id": "573b7e15-80c5-4db4-9e43-a8841b97f055",
    "name": "Kete Labs"
  },
  "generated_at": "2026-09-25T20:15:00Z",
  "agents": [
    {
      "id": "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01",
      "slug": "developer",
      "version": 4,
      "name": "Developer",
      "description": "Implements features and fixes in small, tested, reviewable changes.",
      "mode": "primary",
      "delegable": true,
      "model": {
        "provider": "anthropic",
        "model_id": "claude-sonnet-4-5"
      },
      "instructions": "You are the Developer agent.\n\n- Understand the task and the surrounding code before editing.\n- Make the smallest clean change that solves it, matching the existing style.\n- Add or update tests, and run them before saying the work is done.",
      "tools": {
        "edit": true,
        "shell": true,
        "web": true,
        "shell_allow": [],
        "shell_ask": [],
        "skills": [
          "release-notes"
        ],
        "subagents": [
          "code-reviewer",
          "qa"
        ],
        "mcp": {
          "github": [
            "list_prs",
            "create_pr"
          ]
        }
      },
      "permissions": [
        {
          "action": "*",
          "resource": "*",
          "effect": "deny"
        },
        {
          "action": "read",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "glob",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "grep",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "question",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "read",
          "resource": "*.env",
          "effect": "ask"
        },
        {
          "action": "read",
          "resource": "*.env.*",
          "effect": "ask"
        },
        {
          "action": "edit",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "git status*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "git diff*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "git log*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "git show*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "ls*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "pwd",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "cat *",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "rg *",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "npm install*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "npm i *",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "pnpm add*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "pnpm install*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "yarn add*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "bun add*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "pip install*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "brew install*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "apt *",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "apt-get *",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "cargo install*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "go install*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git reset --hard*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git clean *",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git branch -D*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git checkout -- *",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git push*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git push --force*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git push -f*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git push --force-with-lease*",
          "effect": "ask"
        },
        {
          "action": "webfetch",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "websearch",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "external_directory",
          "resource": "*",
          "effect": "ask"
        },
        {
          "action": "github_list_prs",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "github_create_pr",
          "resource": "*",
          "effect": "ask"
        },
        {
          "action": "skill",
          "resource": "release-notes",
          "effect": "allow"
        },
        {
          "action": "subagent",
          "resource": "code-reviewer",
          "effect": "allow"
        },
        {
          "action": "subagent",
          "resource": "qa",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "sudo *",
          "effect": "deny"
        },
        {
          "action": "shell",
          "resource": "rm -rf /*",
          "effect": "deny"
        },
        {
          "action": "shell",
          "resource": "rm -rf ~*",
          "effect": "deny"
        }
      ],
      "budget": {
        "monthly_micros": 100000000,
        "spent_micros": 12450000,
        "period": "2026-09"
      }
    },
    {
      "id": "7b2d9e4a-1c3f-4a5b-8d6e-0f1a2b3c4d5e",
      "slug": "code-reviewer",
      "version": 1,
      "name": "Code Reviewer",
      "description": "A second opinion on changes: correctness, security and maintainability.",
      "mode": "subagent",
      "model": {
        "provider": "gemini",
        "model_id": "gemini-2.5-pro"
      },
      "instructions": "You are the Code Reviewer agent.\n\n- Review the diff you are given for correctness, security and maintainability, in that order.\n- Do not edit files.",
      "tools": {
        "edit": false,
        "shell": true,
        "web": false,
        "shell_allow": [],
        "shell_ask": [],
        "skills": [],
        "subagents": [],
        "mcp": {}
      },
      "permissions": [
        {
          "action": "*",
          "resource": "*",
          "effect": "deny"
        },
        {
          "action": "read",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "glob",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "grep",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "question",
          "resource": "*",
          "effect": "allow"
        },
        {
          "action": "read",
          "resource": "*.env",
          "effect": "ask"
        },
        {
          "action": "read",
          "resource": "*.env.*",
          "effect": "ask"
        },
        {
          "action": "shell",
          "resource": "git status*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "git diff*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "git log*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "git show*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "ls*",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "pwd",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "cat *",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "rg *",
          "effect": "allow"
        },
        {
          "action": "shell",
          "resource": "sudo *",
          "effect": "deny"
        },
        {
          "action": "shell",
          "resource": "rm -rf /*",
          "effect": "deny"
        },
        {
          "action": "shell",
          "resource": "rm -rf ~*",
          "effect": "deny"
        }
      ],
      "budget": {
        "monthly_micros": null,
        "spent_micros": 0,
        "period": "2026-09"
      }
    }
  ],
  "mcp_servers": [
    {
      "key": "github",
      "name": "github",
      "description": "Pull requests and issues for ketelabs repositories.",
      "transport": "http",
      "url": "https://mcp.ketelabs.example/github",
      "command": null,
      "version": "1.4.0",
      "credential": {
        "type": "oauth",
        "ref": "vault:kete/github-app",
        "expires_at": null
      },
      "tools_discovered": false,
      "tools": [
        {
          "name": "create_pr",
          "description": "Open a pull request.",
          "risk": "write",
          "requires_approval": true
        },
        {
          "name": "list_prs",
          "description": "List open pull requests.",
          "risk": "read",
          "requires_approval": false
        }
      ]
    }
  ],
  "skills": [
    {
      "id": "0b6f3c2e-6d1a-4f6e-9a55-3c2d9e8f7a10",
      "slug": "release-notes",
      "name": "Release notes",
      "description": "Draft release notes from merged pull requests.",
      "version": "1.2.0",
      "instructions": "# Release notes\n\nGroup merged pull requests by area and write one line each.",
      "requires_mcp": [
        "github"
      ],
      "files": [
        {
          "path": "template.md",
          "size_bytes": 412,
          "sha256": "3f1c5a0e8d2b7c4f9e6a1b0d3c5e7f9a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e",
          "executable": false
        }
      ]
    }
  ],
  "policies": [
    {
      "id": "5d0c7e2a-3b1f-4c8e-9a6d-2f4b1c3e5a70",
      "name": "No force pushes",
      "description": "Agents can't force-push, so shared history is never rewritten.",
      "category": "governance",
      "enforcement": "enforced",
      "environment_kinds": [],
      "agents": null,
      "rules": [
        {
          "action": "shell",
          "resource": "git push --force*",
          "effect": "deny",
          "description": "No force push"
        },
        {
          "action": "shell",
          "resource": "git push -f*",
          "effect": "deny",
          "description": "No force push (short flag)"
        }
      ],
      "updated_at": "2026-09-27T09:00:00.000Z"
    },
    {
      "id": "8e2a4c6b-1d3f-4a5b-8c7d-9e0f1a2b3c4d",
      "name": "Review CI changes",
      "description": "Edits to CI and deployment pipelines need a person's approval.",
      "category": "security",
      "enforcement": "audit_only",
      "environment_kinds": [],
      "agents": [
        "developer"
      ],
      "rules": [
        {
          "action": "edit",
          "resource": ".github/workflows/*",
          "effect": "ask",
          "description": "CI changes need approval"
        }
      ],
      "updated_at": "2026-09-26T15:30:00.000Z"
    }
  ]
}
```

The Developer agent is at `approve_risky` with `edit`, `shell` and `web`. It has two
GitHub MCP tools, one of which the platform marks "requires approval". The Code
Reviewer is at `suggest`, with no `edit` or `web`, so only reading and read-only shell
are allowed.

`No force pushes` applies to every session and blocks force pushes whatever an agent
allows. `Review CI changes` is audit-only, for the Developer agent: it blocks nothing yet.

The Developer agent is also given the `release-notes` skill, so its rules include
`skill · release-notes`, and the response carries that skill and the `github` server.

## Skill files: `GET /api/v1/sync/skills/{id}/files`

Same key authentication. Returns every supporting file of one skill of the key's
organization, with contents (`SkillFilesResponse`). An unknown id, a malformed id and
another organization's skill all answer `404 not_found`. `Cache-Control: no-store`.

```json
{
  "skill": { "id": "0b6f3c2e-6d1a-4f6e-9a55-3c2d9e8f7a10", "slug": "release-notes" },
  "files": [
    {
      "path": "template.md",
      "size_bytes": 412,
      "sha256": "3f1c5a0e8d2b7c4f9e6a1b0d3c5e7f9a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e",
      "executable": false,
      "content": "## {{version}}\n\n- …"
    }
  ]
}
```

## Example: 304

```http
HTTP/1.1 304 Not Modified
ETag: "k7Hq2y1ZfV0mYc8Q3xRtVb6sPpLwN9aE4uJ5dGhT0oI"
x-kete-request-id: 1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d
```

## Example: 401

```json
{
  "error": {
    "code": "invalid_key",
    "message": "Missing, invalid, expired, or revoked Kete API key.",
    "request_id": "b7748580-c34d-40ee-9d03-817e4455eddd"
  }
}
```
