# Kete Code Runtime — Architecture Reference

## 1. Purpose of This File

This document is the full architecture and engineering reference for the **Kete Code Runtime** repository.

`CLAUDE.md` at the repository root holds the day-to-day working rules and is loaded in every session. This document holds the complete reasoning, future architecture, and detailed guidance behind those rules. Read the relevant sections before making architectural or significant implementation changes.

Items described as "eventually", "future", or "later" are direction, not current tasks. Do not build them unless a task explicitly asks for them.

Where this document conflicts with an implementation assumption, stop and examine the existing architecture before changing the system.

Do not silently reinterpret major architectural decisions.

---

# 2. Product Vision

**Kete Code** is an AI-native software engineering platform.

It is intended to evolve beyond an AI coding assistant into a complete engineering environment capable of helping teams:

* understand software systems;
* design applications;
* generate and modify code;
* test applications;
* review code;
* secure applications;
* manage repositories;
* work with infrastructure;
* automate engineering workflows;
* investigate production problems;
* coordinate specialized AI engineering agents;
* interact with enterprise engineering knowledge;
* execute autonomous engineering tasks.

The long-term direction is:

```text
Requirement
    ↓
Product Analysis
    ↓
Architecture
    ↓
Design
    ↓
Development
    ↓
Testing
    ↓
Security
    ↓
Code Review
    ↓
Deployment
    ↓
Observability
    ↓
Incident Response
    ↓
Continuous Improvement
```

Kete Code should therefore be designed as an **AI Engineering Platform**, not merely an autocomplete tool or chat interface.

---

# 3. Repository Architecture

Kete Code is intentionally divided into two primary repositories.

```text
Kete-Org/
│
├── kete-code/
│   │
│   └── Runtime / CLI / IDE / Agent Execution
│
└── kete-code-platform/
    │
    └── Portal / Control Plane / Model Gateway
```

## This Repository

This repository is:

```text
kete-code
```

It contains the **execution plane** of Kete Code.

It is responsible for running agents and performing engineering work.

---

# 4. Repository Responsibility Boundary

## `kete-code` owns

This repository owns:

* OpenCode-derived runtime;
* Kete Runtime;
* Kete CLI;
* agent execution;
* agent definitions;
* local execution;
* cloud-runtime execution engine;
* enterprise/private runtime;
* workspace management;
* context management;
* session management;
* file operations;
* terminal execution;
* shell tools;
* Git operations;
* code editing;
* code search;
* repository analysis;
* tool execution;
* MCP client/runtime;
* skills execution;
* workflow execution;
* model-provider clients;
* Kete Gateway client;
* local model support;
* runtime authentication client;
* runtime registration client;
* platform synchronization client;
* runtime policies;
* runtime permission enforcement;
* sandbox abstraction;
* telemetry client;
* runtime SDK;
* IDE integrations;
* VS Code integration;
* future JetBrains integration;
* runtime container image;
* local runtime daemon/service.

---

# 5. `kete-code-platform` Responsibility

The separate:

```text
kete-code-platform
```

repository owns centralized platform functionality.

It includes:

* Kete Portal;
* public website;
* user accounts;
* authentication backend;
* organizations;
* teams;
* membership;
* RBAC;
* projects;
* centralized agent configuration;
* centralized skills registry;
* skills marketplace;
* MCP registry;
* organization MCP configuration;
* model-provider configuration;
* Kete Model Gateway;
* model routing;
* model fallback;
* centralized API key management;
* token accounting;
* usage accounting;
* budgets;
* cost management;
* subscriptions;
* billing;
* plans;
* rate limiting;
* centralized audit logs;
* enterprise policies;
* platform administration;
* cloud orchestration control plane;
* knowledge-source management;
* Supabase;
* PostgreSQL;
* Vercel deployment;
* future Cloudflare deployment.

Do not implement these responsibilities inside `kete-code`.

---

# 6. Platform Hosting Context

The separate Kete Code Platform is:

> **Vercel-first with a Cloudflare migration path.**

Initial platform architecture:

```text
Next.js
   │
   ▼
Vercel
   │
   ▼
Kete Platform
   │
   ├── Portal
   ├── APIs
   └── Model Gateway
          │
          ▼
       Supabase
```

Future:

```text
Next.js / Web Platform
        │
        ▼
Cloudflare
        │
        ▼
Kete Platform
        │
        ▼
Supabase/PostgreSQL
```

This hosting strategy is primarily a concern of `kete-code-platform`.

The runtime must not depend on Vercel-specific or Cloudflare-specific implementation details.

---

# 7. Control Plane vs Execution Plane

Kete uses a strict:

> **Control Plane + Execution Plane**

architecture.

```text
              KETE CONTROL PLANE

              kete-code-platform
                      │
                Platform API
                      │
             ┌────────┴────────┐
             │                 │
        Configuration      Model Gateway
             │                 │
             └────────┬────────┘
                      │
                      ▼
              KETE EXECUTION PLANE

                   kete-code
                      │
                Kete Runtime
                      │
          ┌───────────┼───────────┐
          │           │           │
        Agents       Tools       MCP
          │           │           │
          └───────────┼───────────┘
                      │
                  Workspace
```

The control plane determines:

* identity;
* organization;
* configuration;
* policy;
* model availability;
* centralized agents;
* centralized skills;
* MCP configuration;
* usage limits;
* feature availability.

The execution plane performs the work.

---

# 8. Runtime Deployment Modes

Kete Runtime must support three execution modes.

```text
LOCAL

KETE_CLOUD

ENTERPRISE_PRIVATE
```

These are first-class architectural concepts.

Represent them explicitly.

Example:

```ts
type RuntimeType =
  | "local"
  | "kete_cloud"
  | "enterprise_private";
```

Do not design core runtime components assuming only one execution environment.

---

# 9. Local Runtime

The primary initial runtime executes on the developer's machine.

Example:

```text
Developer Laptop
       │
       ├── VS Code
       │
       ├── Terminal
       │
       └── Kete CLI
               │
               ▼
          Kete Runtime
               │
       ┌───────┼─────────┐
       │       │         │
     Agents   MCP      Skills
       │       │         │
       └───────┼─────────┘
               │
             Tools
               │
     ┌─────────┼─────────┐
     ▼         ▼         ▼
   Files      Git      Terminal
```

The runtime may interact with:

* source repositories;
* local files;
* local development tools;
* Git;
* package managers;
* Docker;
* databases;
* browsers;
* MCP servers;
* language servers;
* test frameworks;
* build systems.

All access remains subject to permissions.

---

# 10. Kete Cloud Runtime

The architecture must allow the same runtime to execute inside a Kete-managed sandbox.

Example:

```text
Kete Platform
      │
      ▼
Cloud Orchestrator
      │
      ▼
Runtime Sandbox
      │
      ├── Kete Runtime
      ├── Git Repository
      ├── Build Tools
      ├── Language Runtime
      ├── MCP
      └── Tests
```

Cloud runtimes should eventually be:

* isolated;
* ephemeral where appropriate;
* resource-limited;
* auditable;
* policy controlled.

Do not assume persistent local state.

---

# 11. Enterprise Private Runtime

Enterprise customers must eventually be capable of running the Kete execution plane inside their own infrastructure.

Potential environments include:

```text
Kubernetes
OpenShift
AKS
EKS
GKE
VMs
Private Cloud
On-Premises
```

Architecture:

```text
Kete SaaS Control Plane
          │
          │ secure API
          ▼
Enterprise Network
          │
          ▼
Kete Private Runtime
          │
          ▼
Internal Repositories
```

Where configured, source code should remain entirely within the enterprise environment.

---

# 12. OpenCode Foundation

Kete Runtime is built using **OpenCode as its upstream foundation**.

OpenCode provides mature functionality that Kete should reuse rather than unnecessarily reproduce.

OpenCode should be treated as:

> upstream infrastructure.

Kete-specific functionality should be layered around the upstream runtime wherever possible.

---

# 13. Golden Rule for OpenCode

The most important upstream rule is:

> **Do not modify OpenCode core unless necessary.**

Before modifying upstream code, determine whether the capability can be implemented through:

1. existing extension points;
2. configuration;
3. plugins;
4. adapters;
5. dependency injection;
6. composition;
7. wrappers;
8. Kete-specific modules.

Only modify upstream core when these approaches cannot reasonably solve the requirement.

---

# 14. Why Upstream Isolation Matters

Kete must remain capable of receiving OpenCode improvements.

Bad architecture:

```text
OpenCode
   ↓
Hundreds of Kete modifications
   ↓
Difficult upstream merges
```

Preferred:

```text
OpenCode Upstream
       │
       ▼
OpenCode Core
       │
       ▼
Kete Extension Layer
       │
       ▼
Kete Platform Capabilities
```

Upstream compatibility is a strategic requirement.

---

# 15. Upstream Synchronization

Maintain an upstream remote.

Conceptually:

```text
origin
  → Kete repository

upstream
  → OpenCode repository
```

Provide automation for:

```text
Fetch OpenCode
      ↓
Create Sync Branch
      ↓
Merge/Rebase Upstream
      ↓
Detect Conflicts
      ↓
Resolve
      ↓
Build
      ↓
Run Upstream Tests
      ↓
Run Kete Tests
      ↓
Generate PR
      ↓
Review
      ↓
Merge
```

Do not manually copy random OpenCode files between repositories.

---

# 16. Preserve Licensing

Never remove required:

* copyright notices;
* license files;
* attribution;
* third-party notices.

Do not intentionally obscure OpenCode ancestry.

Before changing licensing-related files, inspect the upstream license and confirm the obligations.

---

# 17. Suggested Runtime Structure

Follow the existing upstream repository structure where practical.

Do not perform a massive reorganization merely to match this document.

Conceptually, Kete-specific components should be clearly separated.

Example:

```text
packages/
│
├── opencode/
│
├── kete/
│   │
│   ├── runtime/
│   ├── auth/
│   ├── platform/
│   ├── agents/
│   ├── skills/
│   ├── workflows/
│   ├── policies/
│   ├── telemetry/
│   ├── sandbox/
│   └── enterprise/
│
├── sdk/
│
└── shared/
```

Actual implementation should respect upstream conventions.

---

# 18. Core Runtime Components

The conceptual architecture is:

```text
Kete Runtime
│
├── OpenCode Core
│
├── Runtime Manager
│
├── Agent Engine
│
├── Session Manager
│
├── Context Engine
│
├── Model Client
│
├── Tool Engine
│
├── Skills Engine
│
├── MCP Manager
│
├── Workflow Engine
│
├── Workspace Manager
│
├── Git Manager
│
├── Terminal Manager
│
├── Permission Engine
│
├── Policy Engine
│
├── Platform Client
│
├── Authentication Client
│
├── Telemetry
│
└── Extension API
```

Prefer explicit interfaces between major components.

---

# 19. Runtime API

Kete Runtime should expose a stable runtime API.

Consumers may eventually include:

```text
Kete CLI
VS Code (and VS Code forks via Open VSX)
JetBrains
Kete Portal
Cloud Orchestrator
Enterprise tools
Third-party clients
```

Do not make clients depend directly on internal implementation details.

---

# 20. CLI

The primary CLI command is:

```bash
kete
```

Expected commands may include:

```bash
kete

kete login
kete logout

kete init

kete agent
kete agents

kete skills

kete mcp

kete models

kete project

kete status

kete doctor

kete config

kete update

kete version
```

Command naming should remain simple and predictable.

Avoid unnecessary command proliferation.

---

# 21. Default Developer Experience

The basic developer experience should eventually be:

```bash
cd my-project

kete
```

Then:

```text
> Explain this repository.

> Find the authentication implementation.

> Build a customer onboarding module.

> Run the tests.

> Fix the failing tests.

> Review this application for security problems.

> Create a feature branch and implement the changes.
```

The architecture should serve this simple interaction.

---

# 22. IDE Architecture

IDE integrations must use the same underlying runtime.

Do NOT build a separate agent engine inside each extension.

Correct:

```text
VS Code
   │
   ▼
Kete Extension
   │
   ▼
Kete Runtime
```

Later:

```text
JetBrains
   │
   ▼
Kete Extension
   │
   ▼
Kete Runtime
```

Both should behave consistently.

## Current implementation (VS Code)

- **One binary per platform.** Each `.vsix` is platform-specific and carries its `kete` binary
  (`packages/kete-vscode/src/binary.ts`); the extension never uses a `kete` on the `PATH`.
- **Its own server.** On first use the extension starts `kete serve --stdio` on `127.0.0.1`, a
  random port and a random per-session password, restarts it with backoff if it crashes, and stops
  it on deactivate (`server.ts`). It runs where the workspace is (`extensionKind: ["workspace"]`),
  and the chat reaches it through `env.asExternalUri`.
- **Local server security.** Every API request needs the password. The server also rejects a
  `Host` other than an IP literal, `localhost` or an explicitly allowed name (DNS rebinding), and
  an `Origin` other than its own or `--cors` (`server/src/kete/local-guard.ts`).
- **The chat is the runtime's web UI** in a webview iframe, paired through the URL fragment (never
  sent to the server). A nonce-allowed relay script passes a few typed messages between the web UI
  (`app/src/kete/vscode-host.tsx`) and the extension: open the workspace, add editor context to the
  prompt, open a diff (paths are checked to stay inside the workspace).
- **Account.** The extension shows `kete whoami --format json` and runs `kete login` / `kete logout`;
  the key stays in the CLI's OS credential store.
- **Editor awareness.** The active file and selection follow the editor into the chat as one context
  item (`editor-context.ts`; never secrets or `files.exclude` matches). The extension follows the
  server's event stream itself (`events.ts`), so a badge and notifications report approvals waiting
  and finished work even while the chat is hidden. `Cmd/Ctrl+Esc` focuses the chat.
- **Review in the editor.** The web UI reports the session it has open; **Review Changes** reads
  the latest turn's diff (`GET /api/session/:id/diff`), rebuilds each file's "before" side from the
  patch (`review.ts`; refused if the file changed since in a way the patch can't undo), serves it
  read-only on a `kete-before:` scheme, and opens VS Code's multi-file diff editor against the real
  files. Reverting writes that "before" content back after a modal confirmation.
- **MCP servers view.** Joins the runtime's `GET /api/mcp` with `kete sync --status --format json`
  (the synced servers and what each needs, read locally). Approving a synced stdio server shows its
  exact command in a modal, then runs `kete sync --approve <key> --command <exact>`, which refuses
  if the command changed in between, and reloads the server. OAuth sign-in runs `kete mcp auth` in
  a terminal; connect and disconnect use the runtime's MCP endpoints.
- **Permission modes.** A session's `kete.permissionMode` metadata (`default`, `accept-edits`,
  `auto`, `ask` or `plan`; subagent sessions follow their root session's) is read by
  `core/src/kete/permission-mode.ts` on the permission `evaluate` hook, which runs only when nothing
  denied the request. It applies Kete Code's safe defaults where only upstream's catch-all allow
  matched (shell commands classified by `core/src/kete/shell-risk.ts`), and never loosens anything
  (`docs/permissions.md`). The extension sets it per chat (`PATCH /api/session/:id`, merging the
  metadata) and passes the default for new sessions as `KETE_PERMISSION_MODE`. Plan mode is the
  `plan` permission mode (read-only, enforced by the runtime) together with upstream's Plan agent.
- **Editor tools.** The extension serves VS Code's diagnostics to the agent as a small MCP server
  (`editor-tools.ts`: `initialize`, `tools/list`, `tools/call` over streamable HTTP, JSON replies
  only) on 127.0.0.1 with a random bearer token, rejecting other `Host`s and any `Origin`. It
  registers it with its own runtime through `PUT /api/experimental/mcp/editor` after every server
  start, so the runtime (not the extension) runs the tool calls and applies permissions as for any
  MCP tool. Terminal output is not offered: it can hold secrets and the runtime has no redaction
  layer for tool output yet.
- **Sessions.** The Sessions view lists the workspace's top-level sessions
  (`GET /api/session?directory=`, `sessions.ts`) and refreshes on session events; picking one, or a
  `vscode://ketecode.kete-code/session?id=…` link, sends `kete.openSession` to the web UI, which
  opens it as a tab the way its own notifications do. Links only ever name a session id, checked
  against the runtime's id format.
- **Theme.** The webview reads VS Code's theme variables (the web UI's frame can't) and posts them
  with the theme kind to the web UI, which maps them onto its tokens (`app/src/kete/vscode-theme.ts`;
  only plain CSS values are accepted) and sets its light or dark scheme to match.

---

# 23. Agent Architecture

Agents are first-class runtime entities.

An agent should be defined by configuration rather than hard-coded behavior.

Conceptual definition:

```ts
interface AgentDefinition {
  id: string;
  name: string;
  description?: string;

  instructions: string;

  model?: ModelConfiguration;

  tools: string[];

  skills: string[];

  mcpServers: string[];

  permissions: AgentPermissions;

  execution?: ExecutionConfiguration;
}
```

Actual interfaces should align with existing OpenCode abstractions.

Do not introduce duplicate models where upstream equivalents already exist.

---

# 24. Initial Agent Categories

Kete may provide agents such as:

```text
Developer
Architect
Product Manager
UI/UX Designer
QA Engineer
Security Engineer
DevOps Engineer
Database Engineer
SRE
Code Reviewer
Technical Writer
```

These are defaults, not hard-coded limits.

Organizations should eventually be capable of defining custom agents.

---

**Current implementation.** Signed in to a Kete organization, the roles come from the platform:
seven built-in agents per organization (Developer, Architect, Code Reviewer, QA, Security, DevOps,
Docs Writer) and marketplace agent templates (Product Manager, UI/UX Designer, Database Engineer,
SRE), synced as managed agents. Not signed in, the runtime adds starter roles itself
(`core/src/kete/roles.ts`: Code Reviewer, QA and Docs Writer as subagents, Security and DevOps as
primary agents, with deny-first permissions); Developer and Architect are `build` and `plan`.
Their behaviour is checked end to end by `bun run --cwd packages/kete-tools role-check --model
<provider/model>`: each role gets a task in a throwaway repository and home, and the check verifies
which files it changed and what it reported (e.g. the reviewer and Security change nothing, Security
doesn't repeat the secret it found, Docs Writer touches only docs). It uses a real model, so it runs
only when asked, never in CI.

---

# 25. Agent Extensibility

Agents should be composable from:

```text
Agent
 │
 ├── Instructions
 ├── Model
 ├── Tools
 ├── Skills
 ├── MCP Servers
 ├── Policies
 ├── Permissions
 └── Context
```

Do not create large specialized code paths for every agent type.

---

# 26. Multi-Agent Future

The runtime must be designed so multiple agents can eventually collaborate.

Example:

```text
User Requirement
      │
      ▼
Product Agent
      │
      ▼
Architect Agent
      │
   ┌──┴──────────┐
   ▼             ▼
Frontend       Backend
Agent          Agent
   │             │
   └──────┬──────┘
          ▼
       QA Agent
          │
          ▼
    Security Agent
          │
          ▼
     DevOps Agent
```

Do not prematurely build a complicated distributed multi-agent system.

Build interfaces that allow this capability later.

---

# 27. Human-in-the-Loop

Human control is a core product principle.

Agents should support permission levels such as:

```text
ALLOW

ASK

DENY
```

Example:

```text
Agent wants to modify file
        │
        ▼
Policy evaluation
        │
        ├── ALLOW → execute
        │
        ├── ASK → request approval
        │
        └── DENY → reject
```

---

# 28. High-Risk Operations

Operations requiring explicit policy consideration include:

```text
delete files
modify system files
Git push
force push
reset --hard
package installation
Docker execution
database migrations
production database access
infrastructure changes
deployment
credential access
external network requests
```

Do not bypass permission checks for convenience.

---

# 29. Skills Architecture

Skills are reusable knowledge/capability packages.

Examples:

```text
Next.js
React
React Native
Supabase
PostgreSQL
Kubernetes
Terraform
Azure
AWS
Security Review
API Design
TM Forum
```

An agent may load multiple skills.

```text
Backend Developer Agent
        │
        ├── Node.js Skill
        ├── PostgreSQL Skill
        ├── Supabase Skill
        └── API Design Skill
```

---

# 30. Skills Portability

Support:

```text
built-in skills
user skills
project skills
organization skills
marketplace skills
```

Marketplace distribution is a platform concern.

Skill execution/loading belongs to the runtime.

---

# 31. Skills Must Be Inspectable

A developer should eventually be able to determine:

```text
Which skills are installed?

Which skills are active?

Which agent loaded them?

Where did the skill come from?

What permissions does it require?
```

Do not make skill activation invisible.

---

# 32. MCP

MCP is a core integration mechanism.

Support:

```text
Local MCP
Remote MCP
Project MCP
User MCP
Organization MCP
```

Potential integrations include:

```text
GitHub
GitLab
Azure DevOps
Jira
Confluence
Slack
Teams
Google Workspace
SharePoint
ServiceNow
Databases
Cloud services
```

---

# 33. MCP Security

Every MCP server should be treated as an external trust boundary.

Consider:

* authentication;
* permissions;
* network access;
* credential exposure;
* tool capabilities;
* response validation;
* auditability.

Do not automatically trust an MCP server because it is configured.

---

# 34. Model Provider Architecture

The runtime must not depend on one LLM provider.

Support a provider abstraction capable of accommodating:

```text
OpenAI
Anthropic
Google Gemini
GLM
DeepSeek
Qwen
Mistral
Ollama
vLLM
OpenAI-compatible APIs
Enterprise models
```

---

# 35. Model Access Modes

Two major model-access modes must be supported.

## Direct

```text
Kete Runtime
      │
      ▼
AI Provider
```

Useful for:

* local development;
* BYOK;
* local models.

## Gateway

```text
Kete Runtime
      │
      ▼
Kete Model Gateway
      │
      ▼
AI Provider
```

Useful for managed Kete environments.

---

# 36. Kete Model Gateway

The centralized Model Gateway belongs to:

```text
kete-code-platform
```

The runtime only contains the gateway client.

The gateway may handle:

```text
routing
fallback
load balancing
provider credentials
usage
token accounting
costs
budgets
rate limiting
policy
audit
caching
guardrails
```

Do not reproduce centralized gateway functionality in the runtime.

---

# 37. Local Models

Kete should support local/private model execution.

Potential providers include:

```text
Ollama
vLLM
OpenAI-compatible endpoints
enterprise inference servers
```

Example:

```text
Developer
    │
    ▼
Kete Runtime
    │
    ▼
Ollama
    │
    ▼
Local Model
```

This capability is strategically important for privacy-sensitive customers.

---

# 38. Platform Authentication

The runtime should eventually support:

```bash
kete login
```

The platform authentication process should establish:

```text
User
Organization
Runtime Device
Authorized Projects
Access Token
Refresh Mechanism
```

Use secure authentication standards.

Do not invent proprietary cryptographic protocols.

---

## Current implementation (`kete login`, v1)

`kete login` uses the platform's CLI login (`docs/platform/cli-login-v1.md`): an OAuth-style
authorization-code flow with PKCE (S256) and a random `state`, redirected to a listener on
`127.0.0.1` with a random free port (or `--port` for SSH forwarding), timing out after 5
minutes. The code is exchanged at `POST /api/v1/cli/token` for a per-device API key, the
organization and the gateway URL. There is no refresh token in v1: the key lives until
`kete logout` (which calls `POST /api/v1/cli/logout`) or until it is revoked in the portal.

The platform URL comes from `--platform-url`, then `KETE_PLATFORM_URL`, then
`kete.platform.url` in the global config, then `Brand.urls.platform` (none yet). Plain HTTP
is only accepted for loopback addresses.

A signed-in account takes precedence over hand-configured gateway settings
(`providers.kete` in config, `KETE_GATEWAY_*`, a `kete auth login` gateway key), which stay in
place and apply again after `kete logout`. A background service reloads after login and
logout. User identity, authorized projects and refresh remain future work.

Code: `util/src/kete/{account,secret-store}.ts`, `cli/src/kete/`, `core/src/kete/gateway.ts`.

---

# 39. Credential Storage

Store credentials using OS-native secure storage where practical.

Examples:

```text
macOS Keychain
Windows Credential Manager
Linux Secret Service
```

The Kete account key from `kete login` follows this: macOS Keychain (`security`), Linux
Secret Service (`secret-tool`), or Windows Credential Manager (PowerShell calling the Win32
credential API), with the key passed on stdin, never in a command argument. Each store is
verified by reading the key back. When none works (headless Linux, containers, a locked
keychain over SSH), the key goes to a file only the user can read
(`<data>/account-key-*`, mode 0600) and `kete login` warns. Non-secret account details are in
`<config>/account.json`.

Note: upstream OpenCode may already store provider credentials in its own files. Moving those to OS-native storage is a change to upstream behaviour, so plan it deliberately (see the upstream-first rule) rather than patching it ad hoc.

Do not store long-lived credentials as plaintext in:

```text
.json
.yaml
.env
config files
logs
```

---

# 40. Platform API

The runtime communicates with `kete-code-platform` through a stable API.

Preferred:

```text
REST/OpenAPI
WebSocket
SSE
```

depending on the interaction.

Do not couple runtime code directly to the platform database.

---

# 41. Critical Database Rule

Never design:

```text
Kete Runtime
      │
      ▼
Supabase Database
```

Use:

```text
Kete Runtime
      │
      ▼
Kete Platform API
      │
      ▼
Supabase
```

The platform owns its data model.

---

# 42. API Versioning

Runtime/platform communication must support version compatibility.

Example:

```text
/api/v1/runtime/register

/api/v1/runtime/config

/api/v1/agents

/api/v1/skills
```

Do not make breaking API changes without version/migration consideration.

---

# 43. Runtime Registration

A runtime instance should eventually register with the platform.

Conceptual metadata:

```text
runtime_id
user_id
organization_id
runtime_type
runtime_version
operating_system
architecture
capabilities
last_seen
```

Avoid collecting unnecessary device information.

---

# 44. Configuration Synchronization

The runtime may synchronize:

```text
agents
skills
MCP configurations
model configuration
organization policies
project policies
feature flags
runtime limits
```

Synchronization must fail safely.

## Current implementation: agents (sync v1)

Platform-managed agents come from `GET /api/v1/sync` (`docs/platform/sync-v1.md`), authenticated
with the `kete login` key and conditional on `If-None-Match`:

- **When:** at startup and every 5 minutes in the running server (`core/src/kete/sync/plugin.ts`),
  after `kete login`, and on `kete sync`. A 304 costs one small request and nothing else.
- **Where:** `<config>/managed/<organization id>/agents.json`, apart from user-authored agents,
  written atomically (temporary file, then rename; retried on Windows). The whole response is one
  file, so an agent the platform stops returning disappears. `kete logout` removes it.
- **Loading:** after the config agents. A managed agent replaces a local agent with the same slug.
  Its permissions are the default base, then the local global rules, then the organization's rules
  (last match wins). It runs on the Kete gateway (`kete/<model_id>`) and its model calls carry
  `x-kete-agent-id` / `x-kete-agent-version` for per-agent budgets. Its description ends with
  "Managed by <organization>".
- **Failing safely:** offline or on a platform error, the last cached copy stays in use and a warning
  is logged; the cache is never deleted on errors. Not signed in: no request, no managed agents.
- **Skills and MCP servers** the synced agents name come with them. Skill files go to
  `<config>/managed/<org>/skills/<slug>/`, verified by SHA-256 and downloaded only when changed;
  scripts are written without the executable bit. A stdio MCP server runs only after the developer
  approves its exact command (`kete sync --approve <key>`); a changed command needs approval again.
  No secret is ever synced: OAuth servers sign in with `kete mcp auth <key>`, and key-based servers
  wait until the contract defines how the key is sent. Local agents ask before using a managed
  server's tools.
- **Gateway refusals:** an agent over its monthly budget gets "Agent budget reached … ask an admin
  in your organization to raise it in the Kete Code portal", and is not retried. A paused or changed
  agent gets "Agent unavailable …", is not retried, and triggers a sync that removes or updates it.

- **Organization policies** (`policies`) are enforced on the permission `evaluate` hook, on top of
  every agent's rules and the user's configuration (`util/src/kete/sync/policy.ts`). Within a
  policy `deny` and `ask` accumulate and a later `allow` is an exception; across policies the most
  restrictive result wins; nothing is ever loosened. A local runtime is `development`. Audit-only
  policies are logged. **Fail closed:** signed in without the organization's policies loaded (never
  synced, or the cache is unreadable), edits, shell commands and web requests ask first.
- **Runtime registration:** the installation (a random id in `<data>/installation.json`) registers
  with `PUT /api/v1/runtimes/{id}` at startup when its version, key or organization changed or a day
  passed, then daily (`util/src/kete/runtime-registration.ts`): type, version, OS, arch and the
  device name chosen at `kete login`; nothing else. Failures are logged and retried later.

Code: `util/src/kete/sync/` (contract, client, cache, policy; shared by the CLI and core),
`util/src/kete/runtime-registration.ts`, `core/src/kete/sync/plugin.ts`, `cli/src/kete/sync.ts`.

---

# 45. Offline Capability

Local Kete Runtime should remain useful during temporary platform outages where possible.

Examples that may remain available:

```text
local repository analysis
local Git
local models
cached agents
cached skills
local MCP
```

Operations requiring centralized authorization must still respect security requirements.

Offline capability must never become a mechanism for bypassing policy.

---

# 46. Workspace Model

Kete operates within explicitly authorized workspaces.

Example:

```text
~/projects/customer-app
```

Access to this workspace does not imply access to:

```text
~/.ssh

~/Documents

~/Downloads

other repositories
```

Workspace boundaries should be enforceable.

---

# 47. File Operations

File tools should support:

```text
read
write
create
rename
move
search
patch
delete
```

Destructive operations should be permission-aware.

Prefer minimal diffs.

Do not rewrite entire files unnecessarily.

---

# 48. Terminal

Terminal execution is powerful and dangerous.

Commands must pass through the permission/policy system.

Capture:

```text
command
working directory
exit code
duration
stdout
stderr
```

while redacting secrets where possible.

---

# 49. Git

Git is a first-class capability.

Support:

```text
status
diff
branch
checkout
worktree
commit
stash
pull
push
merge
rebase
log
```

Prefer feature branches for agent-created changes.

Never automatically force-push unless explicitly authorized.

---

# 50. Git Worktrees

Consider Git worktrees for parallel agent execution.

Example:

```text
repository
│
├── main
│
├── worktree-agent-123
│
├── worktree-agent-456
│
└── worktree-agent-789
```

This may become important for multi-agent development.

Do not implement parallel Git modifications against the same working tree without concurrency safeguards.

---

# 51. Session Architecture

An agent session should have an explicit identity.

Conceptually:

```text
session
│
├── user
├── organization
├── project
├── workspace
├── agent
├── model
├── messages
├── tools
├── permissions
├── usage
└── state
```

Do not rely on global mutable state.

---

# 52. Context Management

Context is a constrained resource.

The runtime should intelligently manage:

```text
conversation
source files
Git diffs
documentation
tool results
MCP results
skills
repository structure
```

Avoid blindly sending entire repositories to models.

---

# 53. Repository Understanding

Kete should develop strong repository intelligence.

Potential capabilities:

```text
file indexing
symbol understanding
dependency graph
code search
semantic search
Git history
architecture inference
API discovery
database discovery
test discovery
```

Repository understanding should be reusable across agents.

---

# 54. Memory

Separate:

```text
session context

project knowledge

user preferences

organization knowledge
```

Do not combine them into one uncontrolled memory store.

Persist only what the architecture explicitly permits.

---

# 55. Privacy

Source code is sensitive.

Do not transmit source code outside the configured execution/model boundary without necessity.

Users and enterprises should eventually be able to control:

```text
model provider
data routing
telemetry
cloud execution
retention
external integrations
```

---

# 56. Secrets

Never expose secrets unnecessarily to an LLM.

Potential secrets include:

```text
API keys
JWTs
passwords
private keys
database credentials
cloud credentials
OAuth tokens
SSH keys
```

Implement redaction where practical.

---

# 57. Secret Detection

Before sending tool output or files to external models, consider secret detection/redaction.

Never assume repository contents are safe.

`.env` and credential files require special care.

---

# 58. Telemetry

Runtime telemetry may include:

```text
runtime version
runtime type
agent
model
tool
execution duration
token usage
errors
performance
feature usage
```

Avoid transmitting raw source code as telemetry.

---

# 59. Observability

Kete Runtime should eventually support structured:

```text
logs
metrics
traces
events
```

Use correlation IDs so one agent operation can be followed across components.

Example:

```text
request_id
session_id
agent_run_id
tool_call_id
```

---

# 60. Logging

Use structured logs.

Example:

```json
{
  "level": "error",
  "component": "runtime.git",
  "operation": "commit",
  "sessionId": "session_123",
  "message": "Git commit failed"
}
```

Never log secrets.

---

# 61. Error Architecture

Errors should be:

```text
structured
actionable
traceable
safe
```

Where appropriate include:

```text
error code
component
operation
session
agent
tool
runtime version
timestamp
correlation ID
```

Do not silently swallow failures.

---

# 62. Sandbox Abstraction

Execution should eventually support:

```text
Native Local

Docker

Kubernetes

Cloud Sandbox

Enterprise Sandbox
```

Expose execution through an abstraction.

Conceptually:

```ts
interface ExecutionEnvironment {
  execute(command: Command): Promise<ExecutionResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
```

Do not over-engineer this abstraction before actual requirements emerge.

---

# 63. Cloud Runtime Containers

The same Kete runtime should eventually be packageable as a container.

Example:

```text
Kete Runtime Image
│
├── Runtime
├── Git
├── Shell
├── Tooling
└── Agent Engine
```

Language-specific build environments may be separate images.

---

# 64. Enterprise Runtime Security

Enterprise mode should eventually support:

```text
network policies
private model endpoints
private MCP
private Git
private registries
enterprise proxies
custom certificates
centralized policy
enterprise logging
```

Avoid hard-coding assumptions about public Internet access.

---

# 65. Extensibility

Kete should provide stable extension mechanisms for:

```text
models
agents
skills
tools
MCP
workflows
runtime adapters
IDE clients
```

Avoid forcing every new capability into runtime core.

---

# 66. Plugin Architecture

Where appropriate, prefer plugin-style extension over core modification.

Plugins must have:

```text
identity
version
capabilities
configuration
permissions
lifecycle
```

Do not allow plugins unrestricted access by default.

---

# 67. Workflow Engine

Kete should eventually support reusable engineering workflows.

Example:

```text
Feature Development
        │
        ▼
Analyze Requirement
        │
        ▼
Create Branch
        │
        ▼
Implement
        │
        ▼
Test
        │
        ▼
Security Review
        │
        ▼
Generate PR
```

Workflows should orchestrate agents/tools rather than duplicate them.

---

# 68. Future Software Factory

The architecture should eventually enable:

```text
Requirement
      ↓
Architecture
      ↓
Repository Creation
      ↓
Database
      ↓
Backend
      ↓
Frontend
      ↓
Tests
      ↓
Security
      ↓
CI/CD
      ↓
Deployment
      ↓
Documentation
```

Do not attempt to implement the entire software factory during the initial runtime MVP.

---

# 69. Production Engineering

Long-term Kete capabilities may integrate with:

```text
OpenTelemetry
Prometheus
Grafana
Elastic
Sentry
Datadog
Azure Monitor
CloudWatch
```

Potential flow:

```text
Incident
   ↓
Kete SRE Agent
   ↓
Logs + Metrics + Traces
   ↓
Repository
   ↓
Root Cause
   ↓
Proposed Fix
   ↓
PR
```

Design extensibility with this future in mind.

---

# 70. Architecture Intelligence

Future Kete Engineering Intelligence may map:

```text
Application
   ↓
Repository
   ↓
Services
   ↓
APIs
   ↓
Databases
   ↓
Infrastructure
   ↓
Dependencies
```

This should be built as higher-level intelligence rather than deeply coupling it to low-level runtime primitives.

---

# 71. Coding Standards

Prefer:

* strong typing;
* readable names;
* small focused modules;
* explicit interfaces;
* dependency isolation;
* deterministic behavior;
* predictable error handling;
* testable components.

Avoid unnecessary abstraction.

Avoid speculative frameworks.

---

# 72. Follow Upstream Conventions

When working inside OpenCode-derived areas:

> Follow upstream OpenCode conventions unless there is a compelling Kete-specific reason not to.

Do not reformat or refactor upstream files unnecessarily.

Unnecessary upstream changes increase future merge conflicts.

---

# 73. TypeScript

Where TypeScript is used:

* enable strict typing where compatible;
* avoid `any`;
* validate external inputs;
* prefer discriminated unions;
* avoid unsafe type assertions.

External data includes:

```text
API responses
MCP responses
configuration
model output
tool input
environment variables
```

Treat all external input as untrusted.

---

# 74. Dependencies

Before introducing a dependency:

1. Check whether upstream already provides equivalent functionality.
2. Determine whether the dependency is actively maintained.
3. Evaluate security implications.
4. Evaluate bundle/runtime impact.
5. Check license compatibility.
6. Prefer small focused dependencies.

Do not add packages simply to avoid writing a few lines of straightforward code.

---

# 75. Testing Strategy

Use multiple test layers.

```text
Unit
  ↓
Integration
  ↓
Runtime
  ↓
Compatibility
  ↓
End-to-End
```

Critical runtime functionality must have regression tests.

---

# 76. Upstream Compatibility Tests

After OpenCode synchronization, verify:

```text
runtime startup
model execution
tool execution
sessions
file editing
terminal
Git
MCP
configuration
```

Then run Kete-specific regression tests.

---

# 77. Security Testing

Security-sensitive components require explicit tests.

Examples:

```text
workspace escape
path traversal
command permission bypass
secret leakage
unauthorized MCP
invalid tokens
expired tokens
policy bypass
unsafe file access
```

---

# 78. CI

Every pull request should eventually run:

```text
Install
   ↓
Lint
   ↓
Type Check
   ↓
Unit Tests
   ↓
Integration Tests
   ↓
Security Checks
   ↓
Build
```

OpenCode sync PRs should additionally run compatibility suites.

---

# 79. Releases

Runtime releases should be versioned independently from Kete Platform.

Example:

```text
Kete Runtime 1.4.0

Kete Platform 1.9.0
```

Maintain API compatibility information.

---

# 80. Semantic Versioning

Use semantic versioning unless explicitly changed by an ADR.

```text
MAJOR.MINOR.PATCH
```

Breaking runtime API changes require major-version consideration.

---

# 81. Update Mechanism

The CLI should eventually support:

```bash
kete update
```

Updates must verify artifact integrity.

Do not execute unverified downloaded binaries.

---

# 82. Feature Flags

Use feature flags for experimental functionality.

Examples:

```text
multi_agent

cloud_runtime

enterprise_runtime

remote_mcp

agent_memory

advanced_sandbox
```

Avoid scattering experimental conditional logic across unrelated files.

---

# 83. Configuration

Configuration precedence should be explicit.

Potential hierarchy:

```text
Platform Policy
      ↓
Organization
      ↓
Project
      ↓
User
      ↓
Workspace
```

Security policy precedence must be clearly defined.

More restrictive security policy should generally win unless the policy system explicitly defines otherwise.

---

# 84. Environment Configuration

Never hard-code:

```text
API endpoints
credentials
organization IDs
model names
deployment URLs
```

Use typed configuration.

Provide safe defaults where appropriate.

---

# 85. Development Environments

Support:

```text
development
test
staging
production
```

Local development should not require production credentials.

---

# 86. Documentation

Major features must document:

```text
Purpose
Architecture
Configuration
Usage
Security
Failure Modes
Testing
```

Keep documentation near the implementation where practical.

---

# 87. Architecture Decision Records

Significant decisions should use ADRs.

Suggested:

```text
docs/
└── adr/
    ├── 0001-opencode-upstream-strategy.md
    ├── 0002-runtime-platform-separation.md
    ├── 0003-runtime-authentication.md
    ├── 0004-agent-architecture.md
    ├── 0005-skills-architecture.md
    ├── 0006-mcp-security.md
    └── 0007-sandbox-architecture.md
```

Do not casually reverse accepted ADRs.

Create a superseding ADR when required.

---

# 88. Pull Requests

PRs should be:

```text
focused
reviewable
tested
documented
small enough to understand
```

Avoid combining:

```text
feature implementation
large refactor
dependency upgrades
formatting
```

into one unrelated PR.

---

# 89. Branching

Prefer:

```text
main
  │
  ├── feature/*
  ├── fix/*
  ├── chore/*
  ├── docs/*
  └── upstream/*
```

All significant changes should go through PR review.

---

# 90. Commit Discipline

Commits should describe intent.

Prefer:

```text
feat(runtime): add platform registration client

fix(git): prevent agent force push without approval

feat(mcp): add remote server authentication

test(policy): cover workspace access restrictions
```

Avoid meaningless messages such as:

```text
update

fix

changes
```

---

# 91. AI Agent Working Rules

Before modifying this repository, AI coding agents must:

1. Read this file.
2. Inspect the repository structure.
3. Inspect relevant existing implementation.
4. Identify whether functionality already exists upstream.
5. Identify the correct architectural layer.
6. Determine security implications.
7. Determine whether platform changes belong in the other repository.
8. Make the smallest reasonable change.
9. Add or update tests.
10. Run relevant tests.
11. Report what changed.

---

# 92. Do Not Guess Existing Architecture

Never create a new implementation merely because the required functionality is not immediately obvious.

Search first.

Inspect:

```text
existing modules
upstream implementation
configuration
tests
plugins
extension points
```

Reuse before replacing.

---

# 93. Do Not Duplicate Upstream Functionality

Before creating:

```text
new agent engine
new session manager
new tool system
new model abstraction
new MCP implementation
new configuration system
```

verify that OpenCode does not already provide the required capability.

Extend rather than duplicate.

---

# 94. Avoid Large Unrequested Refactors

When implementing a feature:

> Change only what is necessary.

Do not opportunistically rewrite unrelated components.

This is particularly important in upstream-derived code.

---

# 95. Security Is Not Optional

Never weaken:

```text
authentication
authorization
permission checks
workspace restrictions
secret handling
TLS verification
input validation
sandboxing
```

simply to make a feature work.

Fix the architecture instead.

---

# 96. No Hidden Failures

Never silently:

```text
catch and ignore errors

skip failed tests

disable security checks

return success after failure

ignore invalid configuration
```

Failures must be explicit.

---

# 97. No Fake Implementations

Do not implement production functionality using:

```text
hard-coded success responses
fake API calls
mock authentication
dummy persistence
silent fallbacks
```

unless explicitly working inside tests or a clearly labelled prototype.

---

# 98. No Hard-Coded Provider Assumptions

Do not write:

```text
if model == Claude
```

throughout business logic.

Use provider/model capabilities.

Different models should be interchangeable through abstraction.

---

# 99. Runtime Must Remain Platform Independent

Do not couple runtime core to:

```text
Vercel
Cloudflare
Supabase
AWS
Azure
GCP
```

Cloud/provider integrations should exist through adapters.

---

# 100. Cross-Repository Decision Rule

Before implementing a capability ask:

> Does this execute engineering work, or centrally manage the Kete platform?

If it executes engineering work:

```text
kete-code
```

If it centrally manages Kete:

```text
kete-code-platform
```

Examples:

| Capability                | Repository           |
| ------------------------- | -------------------- |
| File editing              | `kete-code`          |
| Terminal                  | `kete-code`          |
| Git                       | `kete-code`          |
| Agent execution           | `kete-code`          |
| Skills execution          | `kete-code`          |
| MCP client                | `kete-code`          |
| Local models              | `kete-code`          |
| VS Code extension         | `kete-code`          |
| Runtime sandbox           | `kete-code`          |
| Portal                    | `kete-code-platform` |
| Organizations             | `kete-code-platform` |
| Team management           | `kete-code-platform` |
| RBAC administration       | `kete-code-platform` |
| Billing                   | `kete-code-platform` |
| Subscription plans        | `kete-code-platform` |
| Model Gateway             | `kete-code-platform` |
| Central model credentials | `kete-code-platform` |
| Usage accounting          | `kete-code-platform` |
| Skills marketplace        | `kete-code-platform` |
| MCP registry              | `kete-code-platform` |
| Platform admin            | `kete-code-platform` |

---

# 101. MVP Priority

Do not begin by building every future capability.

The initial priority is a reliable local coding runtime.

The first major milestone is:

```bash
kete
```

Then:

```text
> Build a Next.js customer management application using Supabase.
```

Kete should:

```text
1. Inspect the workspace

2. Understand the repository

3. Clarify only when necessary

4. Create an implementation plan

5. Create a feature branch when appropriate

6. Create/modify files

7. Install required dependencies with appropriate permission

8. Run commands

9. Build the application

10. Run tests

11. Detect failures

12. Diagnose failures

13. Correct failures

14. Re-run tests

15. Review the diff

16. Summarize the work
```

This must become reliable before advanced autonomous engineering features take priority.

---

# 102. Development Sequence

Recommended development sequence:

```text
PHASE 1
OpenCode Foundation
      ↓
Build + Test Upstream
      ↓
Kete Branding / Namespace
      ↓
Upstream Sync Process


PHASE 2
Kete Runtime MVP
      ↓
CLI
      ↓
Files
      ↓
Terminal
      ↓
Git
      ↓
Models
      ↓
MCP
      ↓
Skills


PHASE 3
VS Code Extension
      ↓
Chat
      ↓
Code Editing
      ↓
Agent Sessions
      ↓
Diff Review
      ↓
Publish to VS Code Marketplace + Open VSX


PHASE 4
Kete Platform Integration
      ↓
Login
      ↓
Runtime Registration
      ↓
Configuration Sync
      ↓
Agent Sync
      ↓
Skills Sync
      ↓
Policies


PHASE 5
Advanced Agents
      ↓
Architecture
      ↓
QA
      ↓
Security
      ↓
DevOps


PHASE 6
Multi-Agent
      ↓
Workflows
      ↓
Parallel Execution
      ↓
Worktrees


PHASE 7
Cloud Runtime
      ↓
Sandboxes
      ↓
Autonomous Jobs


PHASE 8
Enterprise Runtime
```

Do not reverse this order without a clear product reason.

---

# 103. Definition of Done

A feature is not complete merely because it compiles.

Where applicable, completion requires:

```text
implementation
tests
error handling
security review
documentation
logging/observability
backward compatibility consideration
```

---

# 104. Performance

Avoid unnecessary:

```text
full repository scans
large model contexts
repeated file reads
duplicate embeddings
unbounded logs
unbounded session history
```

Measure before optimizing, but avoid obviously inefficient designs.

---

# 105. Concurrency

Assume multiple agents may eventually operate concurrently.

Protect:

```text
files
Git state
session state
shared caches
workspace metadata
```

against corruption.

Use worktrees or isolated workspaces where appropriate.

---

# 106. Resilience

External services fail.

Design for failures involving:

```text
models
network
platform API
MCP
Git hosts
package registries
```

Use bounded retries where appropriate.

Do not create infinite retry loops.

---

# 107. Timeouts

Network calls, tools, and subprocesses should have appropriate timeout behavior.

Long-running operations must be cancellable where practical.

---

# 108. Cancellation

Users should eventually be able to cancel:

```text
agent runs
tool execution
long builds
model requests
workflows
```

Cancellation should propagate safely.

---

# 109. Auditability

Significant agent actions should eventually be explainable.

A user should be able to understand:

```text
What did the agent do?

Why?

Which files changed?

Which commands ran?

Which model was used?

Which tools were called?

Which permissions were granted?
```

---

# 110. User Trust

Kete should never pretend an operation succeeded when it did not.

Agents should distinguish:

```text
planned

attempted

completed

failed

requires approval
```

---

# 111. Product Differentiation

Do not optimize Kete solely to replicate Kilo Code.

OpenCode and Kilo provide useful architectural references, but Kete's long-term differentiation includes:

```text
AI Engineering Teams

Multi-Agent Engineering

Enterprise Knowledge

Engineering Intelligence

Architecture Intelligence

Software Factory

Production Engineering

Enterprise Private Runtime

Model Independence

Skills Marketplace

MCP Ecosystem

Governance

Engineering Analytics
```

The runtime architecture should enable these capabilities.

---

# 112. Guiding Architectural Principle

The core architectural principle is:

> **Use OpenCode as the foundation, not as the boundary of Kete Code.**

Reuse mature upstream capabilities.

Preserve upstream compatibility.

Build Kete differentiation through clean extensions.

---

# 113. Guiding Repository Principle

Remember:

```text
kete-code
     =
EXECUTION PLANE


kete-code-platform
     =
CONTROL PLANE
```

Keep this separation clean.

---

# 114. Final Instruction to Coding Agents

When asked to implement a new Kete capability:

```text
Understand Requirement
        ↓
Inspect Existing Code
        ↓
Check OpenCode Capability
        ↓
Determine Repository Boundary
        ↓
Determine Security Impact
        ↓
Design Smallest Clean Extension
        ↓
Implement
        ↓
Test
        ↓
Document
        ↓
Report
```

Never start by generating large amounts of new code.

Understand the system first.

---

# 115. North Star

Kete Code should ultimately make this possible:

```text
Developer / Engineering Team
             │
             ▼
          Kete Code
             │
    ┌────────┼─────────┐
    ▼        ▼         ▼
Understand  Build     Operate
    │        │         │
    └────────┼─────────┘
             ▼
       AI Engineering
          Platform
```

The developer should be able to move naturally from:

```text
idea
```

to:

```text
architecture
```

to:

```text
working software
```

to:

```text
production
```

to:

```text
continuous improvement
```

while maintaining human control, security, traceability, enterprise governance, and freedom of model choice.

That is the architectural direction of **Kete Code**.
