/// <reference path="../markdown.d.ts" />

// Kete Code's built-in skills and tool-namespace text, layered over upstream's.
//
// Upstream registers an "opencode" skill (how OpenCode works: config paths,
// commands, docs) and a "report" skill that files GitHub issues. After the
// rebrand both would mislead the model: the paths and commands no longer
// exist, and bug reports could land in OpenCode's repository. This plugin runs
// after upstream's (see plugin/internal.ts) and replaces them, so upstream's
// markdown stays untouched and never conflicts on sync.

export * as KeteSkillPlugin from "./skill.js"

import { define, type Context } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { Brand } from "@opencode/util/kete/brand"
import { Effect } from "effect"
import os from "os"
import { Config } from "../config.js"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import keteContent from "./skill/kete.md" with { type: "text" }
import reportContent from "./skill/report.md" with { type: "text" }

export const KeteContent = keteContent

export const KeteDescription = `Use this skill for any question about ${Brand.displayName} itself, including how it works, using or configuring it, troubleshooting it, developing plugins or integrations, and using its SDK, clients, server, or API. Also use it for ${Brand.displayName} agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, and the CLI and TUI.`

const ReportDescription = `Use when the user wants to report a ${Brand.displayName} issue or bug. Collect standard diagnostics, add user-specific reproduction context, and draft the report.`

/** Description of the inherited `opencode` tool namespace. The namespace ID itself is part of the tool API and stays. */
export const ToolNamespaceDescription = `Tools for managing ${Brand.displayName} itself, such as working with sessions, searching the available models, and reading MCP resources.`

/** Upstream's built-in skill IDs that this plugin replaces. */
export const replacedSkills = ["opencode", "report"] as const

export const Plugin = define({
  id: "kete.skill",
  effect: Effect.fn(function* (ctx) {
    const report = yield* reportWithDiagnostics(ctx.app)
    yield* ctx.skill.transform((editor) => {
      for (const id of replacedSkills) editor.remove(id)
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make(Brand.cliName),
          name: Skill.Name.make(Brand.displayName),
          description: KeteDescription,
          path: AbsolutePath.make(`/builtin/${Brand.cliName}.md`),
          content: KeteContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("report"),
          name: Skill.Name.make("Report"),
          description: ReportDescription,
          path: AbsolutePath.make("/builtin/report.md"),
          content: report,
        }),
      )
    })
    yield* ctx.tool.transform((draft) => {
      draft.namespace({ name: "opencode", description: ToolNamespaceDescription })
    })
  }),
})

/** Where a drafted report goes: only Kete's own tracker, and only once one exists. */
export function reportDestination(issues: string | undefined = Brand.urls.issues) {
  if (issues === undefined)
    return [
      "## Where the report goes",
      "",
      `${Brand.displayName} does not have a public issue tracker yet. Do not publish the report anywhere: give the user`,
      "the finished title and body in a single markdown block so they can send it to the",
      `${Brand.displayName} team, and say which diagnostics were unavailable.`,
    ].join("\n")
  return [
    "## Where the report goes",
    "",
    `File it in the ${Brand.displayName} issue tracker: <${issues}>. Show the user the final title and body and publish only after`,
    "they confirm. If you cannot publish (no access, CLI missing, not authenticated), give them the title and body",
    "instead. Report the created issue URL when done.",
  ].join("\n")
}

const reportWithDiagnostics = Effect.fn("KeteSkillPlugin.reportWithDiagnostics")(function* (app: Context["app"]) {
  const plugins = yield* configuredPlugins()
  return [
    reportContent.trimEnd(),
    "",
    reportDestination(),
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before sending.",
    "",
    `- ${Brand.displayName} version: ${app.version}`,
    `- install/channel: ${app.channel}`,
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    `- Terminal: ${terminal()}`,
    `- Shell: ${shell()}`,
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

const configuredPlugins = Effect.fn("KeteSkillPlugin.configuredPlugins")(function* () {
  const config = yield* Config.Service
  return (yield* config.entries())
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.plugins ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.package))
    .toSorted()
})

function terminal() {
  return (
    [
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
