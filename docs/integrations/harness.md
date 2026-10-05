# Harness

Kete Code can read Harness (pipelines, executions, services, environments and more) from a
session, and act on it when you allow it, through Harness's official MCP server
([`harness-mcp-v2`](https://www.npmjs.com/package/harness-mcp-v2), MIT,
[github.com/harness/mcp-server](https://github.com/harness/mcp-server)).

```sh
kete mcp add harness                      # read-only; asks for your API key (hidden input)
kete mcp add harness --org default --project payments
kete mcp add harness --base-url https://harness.example.com   # self-managed Harness
kete mcp add harness --write              # allow create/update/delete/execute (each use still asks)
kete mcp add harness --global             # global config instead of the project's
```

`kete mcp presets` lists the built-in presets.

Kete Code can also run **as a step in a Harness pipeline**: see [Pipeline step](#pipeline-step).

## What it sets up

- A local MCP server named `harness` that runs `npx -y harness-mcp-v2@3.2.32`: an **exact pinned
  version**, never `@latest`. It needs Node.js (`npx`) on your `PATH`.
- `HARNESS_READ_ONLY=true` unless you pass `--write`: the server itself then refuses to create,
  update, delete or execute anything.
- Permission rules in the same config file: `harness_list`, `harness_get`, `harness_describe`,
  `harness_schema`, `harness_search`, `harness_diagnose` and `harness_status` run without asking;
  `harness_create`, `harness_update`, `harness_delete` and `harness_execute` **always ask**, with or
  without `--write`; any other or future Harness tool asks too. Rules match on `harness_<tool>`
  (MCP tool permissions are `<server>_<tool>`). Running `kete mcp add harness` again replaces these
  rules instead of adding copies.
- Optional settings become the server's environment: `--org` → `HARNESS_ORG`, `--project` →
  `HARNESS_PROJECT`, `--base-url` → `HARNESS_BASE_URL` (always written; default
  `https://app.harness.io`). To change any of them, re-run `kete mcp add harness` with the new
  flags rather than editing the file: the stored key is bound to the exact definition (below).
- Running `kete mcp add harness` again keeps any stricter rule of yours on these tools (a `deny`, an
  `ask` where the preset allows, or a rule for a narrower resource) after the preset's rules, so it
  still wins. An `allow` of yours where the preset asks is replaced, with a warning.

## The API key

`kete mcp add harness` asks for the key with hidden input and stores it in your OS credential
store (macOS Keychain, Windows Credential Manager, or Secret Service on Linux; a file only you can
read when none is available, with a warning). The config gets only a reference:

```jsonc
"environment": { "HARNESS_API_KEY": "{kete-secret:mcp:harness}", "HARNESS_READ_ONLY": "true" }
```

The runtime looks the key up when it starts the server and passes it only to that process. It is
never written to config, printed or logged. Only `mcp:` entries can be referenced this way, so a
config can't hand your Kete account key to a server.

**The key is bound to the server definition it was stored for.** A repository you open can bring
its own `.kete/` config, so a reference alone doesn't release the key. Next to the key, the
credential store keeps a SHA-256 fingerprint of the server `kete mcp add harness` wrote: its name,
`type: "local"`, the exact `command`, its working directory, and every `environment` entry except
the key reference itself (`HARNESS_BASE_URL`, `HARNESS_ORG`, `HARNESS_PROJECT`, `HARNESS_READ_ONLY`,
`HARNESS_TOOLSETS`, ...). When the runtime starts a server it releases the key only if the server is
local, it is named `harness` (the reference must be `mcp:<its own name>`), and its current definition
has the stored fingerprint. Anything else — another server referring to `mcp:harness`, a changed
command, a different `HARNESS_BASE_URL`, an added variable, a `cwd` — refuses to start the server
with an error naming the server and the entry (never the key). If you changed the definition on
purpose, run `kete mcp add harness` again (with the flags you want) to re-bind the stored key.

The fingerprint is the guarantee: the runtime doesn't know at start-up which config file a server
came from, so it doesn't distinguish project from global config; it compares definitions. Because
one fingerprint is stored, only one `harness` definition works at a time (the last one you added).
A server that gets a stored key runs in a Kete-owned working directory
(`<data dir>/mcp-servers/harness`), not the project, so a repository's `.npmrc`, `node_modules` or
`.env` can't redirect `npx` or the server.

Re-running `kete mcp add harness` (for example with another `--org`) reuses the stored key without
asking for it again; `kete mcp add harness --new-key` asks for a new one.

Without a terminal (CI, scripts), set `HARNESS_API_KEY` in the environment the runtime starts with;
`kete mcp add harness` then writes `{env:HARNESS_API_KEY}` instead. Prefer the stored key where you
can: `{env:...}` is expanded when config loads, in **any** config file (upstream behaviour), so a
project config can put `{env:HARNESS_API_KEY}` in any server's environment, arguments or headers,
and the expanded value is visible through the config API. The stored key has neither problem.

To remove the key, delete the `harness` server from your config and the `kete-code` /
`mcp:harness` entry from your credential store.

### Create a key with least privilege

1. Prefer a **service account** in Harness (Account Settings → Access Control → Service Accounts)
   with a role that only has **view** permissions on the projects the agent should see. Add create,
   edit or execute permissions only for what you will let it do with `--write`.
2. Create an API key and token for it (or, for personal use, Profile → My API Keys → + API Key →
   + Token). Give the token an expiry.
3. Paste the token when `kete mcp add harness` asks.

Harness enforces the token's permissions; Kete Code's rules and read-only mode are a second layer,
not a replacement.

## Offline mode

The server reaches Harness over the internet, so offline mode (`--offline`, `KETE_OFFLINE`,
`kete.offline`) skips it: the runtime turns it off and logs
`Offline mode: skipped MCP server "harness" ...`. It comes back when offline mode is off.

## Upgrading the server

The pin is an exact version, but there is **no integrity hash**: `npx` trusts the npm registry (and
your npm configuration) to serve the published `harness-mcp-v2@3.2.32`, as it does for any package.

The version is pinned in `packages/schema/src/kete/mcp-presets.ts` (`harnessVersion`). To upgrade,
check the release notes and the package's diff, change the pin, run the preset tests
(`bun run test ./test/kete/mcp-presets.test.ts` in `packages/core`), and re-run
`kete mcp add harness` to update an existing config. Editing the version in the `command` by hand
changes the definition, so the stored key isn't released until you re-run `kete mcp add harness`.

## Pipeline step

A Harness CI pipeline can run Kete Code as a **Plugin** step to fix a failing build, review a
change or write release notes, with a spending budget, a time limit and a clear outcome. The image
is `ghcr.io/kete-org/kete-harness-plugin:<release tag>` (linux/amd64 and linux/arm64, signed with
cosign; pin it by digest from the release notes). Two modes:

- **`run`** (default): runs `kete job run` inside the step's own container, in the pipeline
  workspace. It works on its own git worktree and branch, so the checkout isn't changed. Unattended
  rules apply (ADR 0008): every permission the run's policy doesn't allow is denied, and it can't
  start without a budget and a time limit. You can push the result to a **new** branch.
- **`cloud`**: starts a Kete cloud job on a repository connected to a Kete project
  (`POST /api/v1/jobs`), waits for it, and prints the job URL and pull request link. This needs
  cloud jobs to be enabled for your organization.

The package README (`packages/kete-harness-plugin/README.md`) lists every setting.

### Fix a failing build (run mode)

The build step writes its log into the workspace; the Kete step runs only when the stage has
failed, and pushes its fix to a new branch:

```yaml
- step:
    type: Run
    name: Build
    identifier: build
    spec:
      shell: Bash
      command: bun install && bun run build 2>&1 | tee build.log; exit ${PIPESTATUS[0]}
- step:
    type: Plugin
    name: Kete Code fix
    identifier: kete_fix
    when:
      stageStatus: Failure
    spec:
      connectorRef: ghcr_anonymous            # a Docker registry connector for https://ghcr.io
      image: ghcr.io/kete-org/kete-harness-plugin:kete-v0.3.0
      settings:
        preset: fix-build
        log: build.log
        budget: "2"                           # USD for the whole run
        timeout: 30m
        allow: |
          shell:bun install*
          shell:bun run build*
          shell:bun test*
        push_branch: kete/fix-<+pipeline.sequenceId>
        kete_api_key: <+secrets.getValue("kete_api_key")>
        gateway_url: <+variables.kete_gateway_url>
```

Instead of a Kete API key, run mode accepts one provider key (`anthropic_api_key`,
`openai_api_key`, `gemini_api_key`, `openrouter_api_key`, `deepseek_api_key`, with `model` such as
`anthropic/claude-sonnet-4-5`) or an OpenAI-compatible endpoint in your network (`model_url`,
`model`, optionally `model_api_key`).

What the step does: it writes the job spec (prompt, `allow` rules, budget, time limit, branch),
runs `kete job run`, copies the run's audit log to `kete-output/audit.jsonl` (secrets already
redacted by the runtime) and writes `kete-output/summary.md` (the outcome, cost, denials and the
final answer, redacted) and `kete-output/result.json`. Publish `kete-output/` as an artifact, or
post `summary.md` to the pull request in a later step. With `push_branch`, a completed run's changes
are committed (repository hooks never run) and pushed **only if that branch doesn't exist** on the
remote yet; the target branch, the default branch, the current branch, `main` and `master` are
refused before the run starts. The push uses the clone credentials Harness gives the step
(`DRONE_NETRC_*`); without them, or with a read-only token, the outcome is `push_failed`.

### Review a pull request

```yaml
- step:
    type: Plugin
    name: Kete Code review
    identifier: kete_review
    spec:
      connectorRef: ghcr_anonymous
      image: ghcr.io/kete-org/kete-harness-plugin:kete-v0.3.0
      settings:
        preset: review                        # compares with origin/<target branch>; read-only
        budget: "1"
        timeout: "15"
        anthropic_api_key: <+secrets.getValue("anthropic_api_key")>
        model: anthropic/claude-sonnet-4-5
```

`release-notes` works the same way (`base: v1.2.0` to choose the starting tag); the notes are the
final answer, in `summary.md` and `KETE_SUMMARY`.

### Start a cloud job (cloud mode)

```yaml
- step:
    type: Plugin
    name: Kete Code cloud job
    identifier: kete_cloud
    spec:
      connectorRef: ghcr_anonymous
      image: ghcr.io/kete-org/kete-harness-plugin:kete-v0.3.0
      settings:
        mode: cloud
        task: Upgrade lodash to the latest 4.x and fix anything that breaks
        project: 0b8e6c1e-5a1f-4f53-9d55-2f7f2f1c7a10   # Kete project id
        repo: 6c2e1f4a-7d3b-4e8a-9b1c-0d2e3f4a5b6c      # the connected repository's id
        agent: build
        budget: "5"                                     # at most 25
        timeout: 60m                                    # at most 120 minutes
        push_branch: "true"                             # the platform pushes kete/job/<suffix>
        open_pr: "true"
        kete_api_key: <+secrets.getValue("kete_api_key")>
```

The step polls the job with backoff (5 s, growing to 30 s) until it ends, or until its time limit
plus 15 minutes for provisioning and finishing, when it asks the platform to cancel the job. A
retried create reuses its `Idempotency-Key` (set `idempotency_key` to make a re-run of the step
return the same job).

### Outputs and exit codes

| Exit | Meaning |
|---|---|
| `0` | the run completed (cloud: the job succeeded) |
| `1` | a failure: model or tool error, the time limit, a failed push, an unreachable platform |
| `2` | refused: invalid settings, the run's policy or budget, the platform refusing the job, a push to an existing or protected branch |

Output variables, readable as `<+execution.steps.kete_fix.output.outputVariables.KETE_OUTCOME>`:
`KETE_OUTCOME`, `KETE_SUMMARY` (one line, redacted, at most 2000 bytes), `KETE_BRANCH` (the branch
pushed, else empty) and `KETE_JOB_URL` (cloud mode).

### Keys and least privilege

- Store every key as a **Harness secret** and reference it with `<+secrets.getValue("...")>`. The
  step never prints a setting's value, and the agent's processes don't see the step's settings, the
  clone credentials or other secret-looking variables; they get only the model key the run needs.
  Note that a provider key *is* in the agent's environment, so `allow` only the commands it needs.
- **Kete API key:** a dedicated key for the pipeline, not a personal one. Cloud mode needs
  `agents.run`, plus `jobs.push` only if you set `push_branch`/`open_pr`. `budget` caps each run;
  the key's own permissions are enforced by the platform.
- **Provider keys:** a separate key with a spending limit at the provider.
- **Git:** use `push_branch` only with a codebase connector whose token can create branches; branch
  protection on your default branch stays your second line of defence (the step never pushes there).
- **`allow`:** start from nothing and add the commands the task needs; the audit log
  (`kete-output/audit.jsonl`) lists every denied permission to tune it.

### Running as a non-root user

The image runs as uid 1000. `kete job run` adds a git worktree, so the workspace's `.git` must be
writable by the step's user; otherwise the step refuses (exit 2) and says so. Run the stage as uid
1000 (`runAsUser: "1000"` on the stage's Kubernetes infrastructure), or set the step's `runAsUser` to the user
that cloned the repository. Running as root doesn't relax anything: the unattended policy is
enforced by the runtime either way.
