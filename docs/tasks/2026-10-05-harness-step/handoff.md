# Handoff: Kete Code step for Harness CI/CD pipelines

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-05 build agent (single session)
Done: package `packages/kete-harness-plugin`, workflow `kete-harness-plugin.yml`, release jobs, docs, cards.
Decisions (recommended options, user pre-approved):
- Entrypoint in TypeScript compiled with `bun build --compile` (reuses `KeteRedact`; no Go needed).
- Run mode: `kete job run --json --standalone`; the step commits the worktree and pushes only to a new
  branch (`--force-with-lease=<ref>:`), refusing target/default/current/main/master before the run.
- `fix-build` inlines the log tail (redacted) in the prompt: the agent's worktree can't read the workspace.
- `PLUGIN_MODEL_URL` → custom `endpoint` provider (`aisdk:@ai-sdk/openai-compatible`) via
  `KETE_CONFIG_CONTENT`; key via `{env:PIPELINE_MODEL_ENDPOINT_KEY}` (a `KETE_*` name is renamed by the env bridge).
- `PLUGIN_GATEWAY_URL` required with `PLUGIN_KETE_API_KEY` in run mode (the gateway URL isn't derivable).
- Cloud mode needs `PLUGIN_PROJECT`, `PLUGIN_REPO` (ids) and `PLUGIN_AGENT` (the API requires them);
  job URL `<base_url>/jobs/<id>` (the portal's job page route); wait limit = timeout + 15 min, then cancel.
- `PLUGIN_COMMENT` not added as a setting: `kete-output/summary.md` is always written for a later step to post.
Open: `defaultBaseURL` `https://app.ketecode.ai` per the task, while `brand.urls.platform` is still undefined.
