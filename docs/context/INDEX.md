# Knowledge base index

Read this first. `kete-code` is Kete Code's **execution plane**: the agent runtime, the `kete`
CLI, the SDK, the web UI, the VS Code extension and the JetBrains plugin. It is a fork of OpenCode v2 (pin in
`.opencode-version`); Kete-owned code lives in `packages/*/src/kete/`, `packages/kete-*` and any
path containing `kete`. The control plane (portal, platform API, gateway, database) is the
`kete-code-platform` repo; what the two share is in `contracts.md` — read that instead of opening
the other repo.

**Code is the source of truth.** These files tell you where to look and what must hold; read the
real code before editing it. If a card is wrong, fix it in the same task. Cards cover Kete-owned
code in depth and upstream OpenCode only where Kete connects to it.

## Files

| File | Read it to |
|---|---|
| `repo-map.md` | find which folder holds what |
| `modules/<module>.md` | plan a change in one module: entry points, key files, seams, rules, tests, recipes |
| `commands.md` | test, typecheck, lint, generate, build — narrowest first, run inside the package |
| `conventions.md` | match the code's patterns (Effect, plugins, schemas, hooks, tests) |
| `decisions.md` | the rule each ADR and CLAUDE.md principle imposes |
| `pitfalls.md` | mistakes already made once — upstream markers first |
| `contracts.md` | what the runtime and the platform rely on from each other |

Deeper references: `CLAUDE.md` (the rules; wins over `AGENTS.md`), `docs/architecture.md`,
`docs/adr/`, `docs/platform/` (contract copies), `docs/upstream-patches.md` (every upstream edit,
by feature — the best seam map), `docs/upstream-sync.md`, `docs/release.md`, `docs/job-hosts.md` (operator guide for every kind of self-hosted job host).

## Module cards

| Card | Covers |
|---|---|
| brand-env | Brand identity, `KETE_*` → `OPENCODE_*` env bridge |
| account-login | `kete login/logout/whoami`, PKCE, account file, OS secret store |
| sync | managed agents, skills, MCP servers and policies from the platform |
| runtime-registration | `PUT /api/v1/runtimes/{installation_id}` |
| gateway | the `kete` provider, model discovery, prices, credit balance |
| budget | `kete.budget.session` pause-and-ask |
| permissions | permission mode ("ask before edits") and the subagent permission ceiling |
| sandbox | the local OS sandbox for the agent's shell commands (ADR 0013): sandbox-exec / bwrap, `kete.sandbox` settings, `sandbox_off`/`sandbox_network`, approval marks, `kete sandbox`, TUI footer |
| roles-skills | starter role agents, built-in skills, role-check |
| attribution-hosted | provider attribution headers, hosted services off by default |
| local-models | local model servers (Ollama, LM Studio, vLLM): env hosts, `kete.local-models` status RPC, `kete models pull`, no-tools models, offline mode, pickers and first-run offer |
| subagents | subagent timeout, concurrency limit, stop cascade, subtask checks |
| unattended | unattended-run fail-closed policy (ADR 0008): `kete.unattended` metadata, the policy-allow/deny hooks, required budget and time limit |
| audit-log | local append-only audit log for unattended runs (ADR 0008): line format v1, the redactor, storage and cap, fail-closed writes |
| worktrees-parallel | subagent worktrees, leases, session_move checks, stale writes |
| workflows | `kete.workflows` and the `workflow` tool |
| lsp | language server diagnostics after edits: `lsp` config, sandboxed servers, report |
| todo | the session task list: `todowrite` tool, `kete.todo` RPC, TUI sidebar/footer, web dock |
| config-kete | the `kete` config section, discovery, adding a key end to end |
| mcp-presets | built-in MCP presets (`kete mcp add harness`, `kete mcp add slack`, `kete mcp presets`): catalogue, stored MCP secrets (`{kete-secret:mcp:<name>}`), permission rules, offline skip |
| cli | Kete commands in the CLI, disabled self-update |
| job-mode | cloud-job runtime flag: process seam, config/plugin/MCP/model restrictions, request enforcement |
| root-helper | the Go root helper and its TypeScript client: fixed tool user, cgroup isolation, socket protocol v1 |
| egress | the Go egress proxy and nftables rules for cloud jobs: per-user ports, per-phase host allowlists, per-VM CA, registry rules, capped request log, configuration v2 (upstream proxy, CA bundle, internal ranges) |
| job-entrypoint | the Go root entrypoint of a cloud job: machine config env, setup, firewall and proxy restarts, claim, clone, `kete job run`, outcomes, credentials, safe bundle, uploads; the kubevm profile (config file, boot-ID check, runtime claim, outbox) |
| job-host | the self-hosted job host agent `kete-job-host` (ADR 0023, P2 + P4 + P5 agent side): enroll, signed poll/report, desired state, HPKE-sealed configs, deadline killer, reconcile; the `firecracker` driver, host nftables table, image fetch + cosign verification, guest kernel, packaging, KVM tests; the `dedicated` driver (reaper, namespaces, loop overlay root), one job per generation, R1 boot enrollment, R2 interface; contract `docs/platform/job-host-v1.md` and shared test vectors |
| kubernetes-runner | the enterprise Kubernetes runner (ADR 0011, P1–P3): `kete-job-host kubernetes` on job-host-v2, Lease, state and keys in Secrets, proxy/CA, the kubevm pod driver (job pods, per-job Secret, outbox, pods/log, failure reasons, RuntimeClass guard), the `publishing` state and publisher pods, clone credentials, the test-only placeholder driver, the `kete-runner` Helm chart (RBAC, admission policies, NetworkPolicies), kind e2e |
| gitlab-provider | the runner's GitLab self-managed provider and publisher (P3): repository registry, minted/static clone tokens, `kete-job-host publish` (hostile outbox, Go port of the platform's bundle validator + vectors, base checks, create-only push over pure-Go git smart HTTP, draft MR, fixed-code outcome), fake GitLab |
| job-image | The cloud job image: Dockerfile, build and e2e scripts, the `kete-job-image.yml` workflow, the release `image` job (GHCR push by digest) |
| server-sdk | local server guard, isolated server tests, protocol and client generation |
| ui-branding | web UI and TUI branding and themes |
| web-app | the web app's Kete chat panel: empty state, composer controls, the permission-mode toggle |
| vscode-extension | the extension and the web UI's side of its bridge |
| jetbrains-plugin | the IntelliJ-platform plugin (`packages/kete-jetbrains`): bundled or first-use-downloaded (signature-verified) runtime, JCEF chat and its bridge, context, review, diagnostics tool, CI/release/publish workflows, the web UI's `ide-host.ts` |
| harness-plugin | the Kete Code step for Harness pipelines (`packages/kete-harness-plugin`): `PLUGIN_*` settings, `run` mode (`kete job run`, artifacts, new-branch push), `cloud` mode (`POST /api/v1/jobs`, polling), outputs and exit codes, the image, its workflow and release jobs |
| kete-tools-ci | upstream sync, upstream:check, verify, release, role-check, CI |

Card template (`node scripts/agent/card-check.mjs` enforces it): front matter `module`, `paths`,
`verified-at`; sections Quick answers, Purpose, Entry points, Key files, Data flow, Data and APIs
used, Rules that must not break, Testing, Changes, Gotchas. Cite `path:line`; never paste code;
no secrets or environment values.

## Agents (`.claude/agents/`; Kete copies in `.kete/agents/` are generated)

| Agent | Model | Job |
|---|---|---|
| scout | sonnet | answers where/how from these docs; searches code only if they don't |
| planner | opus | spec.md → plan.md from the cards; upstream-first |
| implementer | sonnet | follows plan.md, reads only the files it lists |
| verifier | sonnet | runs checks via check-summary; PASS/FAIL + failing excerpts |
| reviewer | sonnet | diff vs spec, CLAUDE.md, pitfalls; ≤40 lines |
| librarian | sonnet | keeps docs/context current; edits nothing else |
| upstream-guard | sonnet | upstream edits necessary, minimal, marked and recorded |

## Task flow

- **Small** (a few files; no upstream edit, shared contract, config schema or security change):
  no task folder. Scout if needed → edit → narrow check (`commands.md`) → done.
- **Medium**: `/task-new` → agree `spec.md` → `/task-plan` → `/task-build` (implementer,
  verifier) → `/task-review` → `/task-close` (result.md, librarian, metrics).
- **Large** (upstream edits, shared contracts, config schema, security, several packages, or
  unclear scope): as medium, and the user approves `spec.md` and `plan.md` before building.

Task folders: `docs/tasks/<date>-<slug>/` with `spec.md`, `plan.md`, `handoff.md` (append-only),
`result.md`. Agents get these **paths**, never pasted content or chat history. One task per
session: start each medium or large task in a fresh session from this file and the task folder.

## Rules that save calls

- Read this file and the relevant cards before exploring code; delegate lookups to `scout`.
- Before relying on a card, run `node scripts/agent/stale-cards.mjs <card>`; stale → librarian first.
- Every "Docs enough: no" answer becomes a Quick answers line (the librarian adds it at close).
- Pass file paths, not contents. Never return full logs or whole files.
- Implementer fails verification twice → back to planner → then ask the user.
- Parallel agents only for independent work; parallel code edits only in separate git worktrees.
- No agent pushes, merges or hard-resets (`disallowedTools` in the agents that can run commands); `.env` and key files are denied for everyone (`.claude/settings.json`).
