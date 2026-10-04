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

export class Info extends Schema.Class<Info>("ConfigKete.Info")({
  budget: Budget.pipe(optional).annotate({ description: "Spending limits" }),
  platform: Platform.pipe(optional).annotate({ description: "Kete platform connection" }),
  runtime: Runtime.pipe(optional).annotate({ description: "Where this runtime runs" }),
  subagents: Subagents.pipe(optional).annotate({ description: "Limits for subagents" }),
  workflows: Schema.Record(Schema.String, Workflow).pipe(optional).annotate({
    description: "Reusable workflows that run agents in order, by name; run them with the workflow tool or /<name>",
  }),
}) {}
