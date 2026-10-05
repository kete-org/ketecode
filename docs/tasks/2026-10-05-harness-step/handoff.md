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

## 2026-10-05 security review fixes (build agent)
Done: the seven findings and the nits (result.md "Security review fixes"), tests, README, user guide, card.
Decisions (user pre-approved the recommendations):
- Push hardening: fresh temporary repository with alternates instead of only `-c` overrides, because
  `-c` can't neutralise `url.*.insteadOf`, filter drivers or `include.path` in the repo config. Pinned
  `core.sshCommand=ssh` (not empty: an empty value makes git try to run an empty command) and
  `safe.directory=*` (system config is off, so the image's `/etc/gitconfig` no longer applies to the
  step's own git). Allowed remotes: https, http to loopback, ssh/scp-like, local path/`file://`.
- Keys: `{file:}` references, not descriptors: kete's descriptor key exists only in job mode, which
  needs the root helper. Plus `prctl(PR_SET_DUMPABLE, 0)` for the step (best effort, warns).
- Preset bases: release-notes without `base` uses the workspace's latest tag (resolved by the step);
  with none, exact fallbacks (`git describe --tags --abbrev=0`, `git tag --list`, `git log --oneline -n 200`).
- Resolved the earlier open question: there is no default `base_url` any more.
Open: a repository's own `.kete/` config can still influence kete (provider settings) in run mode;
documented as residual risk, not fixed here (it is `kete job run`'s behaviour, not the step's).

