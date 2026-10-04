// Starter role agents for developers who aren't signed in to a Kete organization: Code Reviewer, QA
// and Docs Writer as subagents the default agent can delegate to, and Security and DevOps as agents
// the user can switch to or delegate to (mode "all"), so a workflow step can hand work to them. They mirror the platform's built-in agents (kete-code-platform create_builtin_agents) so a
// local user gets the same roles; Developer and Architect are the runtime's own `build` and `plan`.
//
// Signed in, the organization decides which agents exist (platform sync, ./sync/plugin.ts), so none
// of these are added: an agent the organization paused must not come back as a local copy. Agents
// in the user's configuration with the same id still win (config agents load after this plugin).

export * as KeteRoles from "./roles.js"

import { define } from "@opencode/plugin/effect/plugin"
import { KeteAccount } from "@opencode/util/kete/account"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import type { Permission } from "../permission.js"

type Rule = Permission.Ruleset[number]

/** Reading and searching, never secrets without asking, nothing else unless a role adds it. */
const readOnly: Rule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "ask" },
]

/** Commands that only look: status, history, diffs, listings and searches. */
const lookCommands = ["git status*", "git diff*", "git log*", "git show*", "git blame*", "ls*", "rg *", "grep *", "find *", "cat *", "wc *"]
const allowShell = (patterns: readonly string[]): Rule[] => patterns.map((resource) => ({ action: "shell", resource, effect: "allow" }))

/** Never, whatever a role allows. */
const never: Rule[] = [
  { action: "shell", resource: "sudo *", effect: "deny" },
  { action: "shell", resource: "rm -rf /*", effect: "deny" },
  { action: "shell", resource: "rm -rf ~*", effect: "deny" },
]

const subagent: Rule[] = [
  { action: "question", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
]

export type Role = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly mode: "primary" | "subagent" | "all"
  readonly system: string
  readonly permissions: Rule[]
}

export const roles: readonly Role[] = [
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reviews a change for correctness, security and maintainability, with file:line references and suggested fixes. Read-only.",
    mode: "subagent",
    system: `You are the Code Reviewer agent.

- Review the diff you are given (or the working tree's changes) for correctness, security, error handling, tests and maintainability.
- Report each finding with its file:line, why it matters, and a concrete fix. Say which ones block merging.
- Do not edit files. If nothing needs changing, say so plainly.`,
    permissions: [...readOnly, ...allowShell(lookCommands), ...subagent, ...never],
  },
  {
    id: "qa",
    name: "QA",
    description: "Writes and runs tests for the happy path, edge cases and failures, and finds the root cause of flaky tests.",
    mode: "subagent",
    system: `You are the QA agent.

- Write tests for the happy path, edge cases and failure cases of the change you are given, in the project's existing test style.
- Run the tests and report exactly what passed and failed, with output.
- For a flaky test, find the root cause instead of retrying or loosening it. Change production code only to make it testable, and say so.`,
    permissions: [
      ...readOnly,
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
      ...allowShell(lookCommands),
      ...allowShell(["npm test*", "npm run test*", "pnpm test*", "pnpm run test*", "yarn test*", "bun test*", "bun run test*", "npx vitest*", "npx jest*", "pytest*", "python -m pytest*", "go test*", "cargo test*", "dotnet test*", "mvn test*", "gradle test*", "./gradlew test*", "rspec*", "bundle exec rspec*"]),
      ...subagent,
      ...never,
    ],
  },
  {
    id: "docs-writer",
    name: "Docs Writer",
    description: "Keeps documentation matching the code: READMEs, guides and docs folders only.",
    mode: "subagent",
    system: `You are the Docs Writer agent.

- Keep the documentation accurate to the code as it is: read the code before writing about it.
- Edit documentation files only (Markdown, docs folders, READMEs). Write plainly and briefly, with runnable examples.
- Point out any code comment or behaviour that contradicts the docs instead of changing the code.`,
    permissions: [
      ...readOnly,
      ...allowShell(lookCommands),
      { action: "edit", resource: "*.md", effect: "allow" },
      { action: "edit", resource: "*.mdx", effect: "allow" },
      { action: "edit", resource: "docs/*", effect: "allow" },
      { action: "edit", resource: "*/docs/*", effect: "allow" },
      ...subagent,
      ...never,
    ],
  },
  {
    id: "security",
    name: "Security",
    description: "Read-only security review: dependency and secret scanners, then a manual review, reported by severity.",
    mode: "all",
    system: `You are the Security agent.

- Review the code without changing it. Start with the scanners that are installed (Semgrep, gitleaks, npm/pnpm/bun audit, pip-audit, Trivy), then review by hand: authentication and authorisation, input validation, injection, secrets, dependencies and configuration.
- Report findings by severity (critical, high, medium, low) with the file:line, how it could be exploited, and the fix. Separate confirmed issues from suspicions.
- Never repeat a secret value you find, in any part of your answer or in commands you suggest: name the file and line, and if you must identify it, show only its first four characters followed by "…" (for example \`sk_t…\`).`,
    permissions: [
      ...readOnly,
      { action: "shell", resource: "*", effect: "ask" },
      ...allowShell(lookCommands),
      ...allowShell(["semgrep *", "gitleaks detect*", "npm audit*", "pnpm audit*", "yarn audit*", "bun audit*", "pip-audit*", "trivy fs*", "osv-scanner*", "cargo audit*", "govulncheck*"]),
      // Fixing is changing: those ask even though auditing doesn't.
      ...["npm audit fix*", "pnpm audit --fix*", "yarn audit fix*"].map((resource): Rule => ({ action: "shell", resource, effect: "ask" })),
      { action: "webfetch", resource: "*", effect: "ask" },
      { action: "question", resource: "*", effect: "allow" },
      ...never,
    ],
  },
  {
    id: "devops",
    name: "DevOps",
    description: "CI/CD pipelines and infrastructure as code: small, reversible changes with the rollback stated. Asks before every change.",
    mode: "all",
    system: `You are the DevOps agent.

- Work on CI/CD pipelines, containers and infrastructure as code with small, reversible changes, and state how to roll each one back.
- Validate before applying: lint, plan or dry-run first, and show the output.
- Never change production or shared infrastructure without an explicit, approved plan; prefer a pull request.`,
    permissions: [
      ...readOnly,
      { action: "edit", resource: "*", effect: "ask" },
      { action: "shell", resource: "*", effect: "ask" },
      ...allowShell(lookCommands),
      { action: "webfetch", resource: "*", effect: "ask" },
      { action: "subagent", resource: "*", effect: "ask" },
      { action: "question", resource: "*", effect: "allow" },
      ...never,
    ],
  },
]

export function make(options: { readonly account?: Pick<KeteAccount.Options, "config"> } = {}) {
  return define({
    id: "kete.roles",
    effect: Effect.fn(function* (ctx) {
      const account = yield* Effect.tryPromise(() => KeteAccount.read(options.account ?? KeteAccount.defaults())).pipe(
        // Unreadable: treat as signed in, so an organization's choices are never overridden.
        Effect.catch(() => Effect.succeed("unreadable" as const)),
      )
      if (account) return
      yield* ctx.agent.transform((editor) => {
        for (const role of roles)
          editor.update(Agent.ID.make(role.id), (item) => {
            item.name = Agent.Name.make(role.name)
            item.description = role.description
            item.mode = role.mode
            item.system = role.system
            // Replace rather than push: a published agent's rule list is frozen.
            item.permissions = [...role.permissions]
          })
      })
    }),
  })
}

export const Plugin = make()
