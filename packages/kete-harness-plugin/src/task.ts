// Kete-owned. Turns the settings into the run's prompt and allow rules. A preset is a prompt plus
// the least it needs to be allowed; `PLUGIN_TASK` adds instructions to a preset or stands alone,
// and `PLUGIN_ALLOW` adds rules. `fix-build` puts the end of the failed step's log in the prompt
// (redacted): the agent works in its own worktree and can't read the pipeline's files outside it.

import { realpathSync, statSync, openSync, readSync, closeSync } from "node:fs"
import path from "node:path"
import { KeteRedact } from "@opencode/util/kete/redact"
import { Settings } from "./settings.js"

export * as Task from "./task.js"

/** The end of the log that goes into the prompt. */
export const logTailBytes = 48_000

export const presetAllow: Readonly<Record<Settings.Preset, readonly Settings.AllowRule[]>> = {
  // Edits in the run's own worktree; build and test commands need PLUGIN_ALLOW (they vary per project).
  "fix-build": [{ action: "edit", resource: "*" }],
  // Read-only: inspect history and diffs.
  review: [
    { action: "shell", resource: "git diff*" },
    { action: "shell", resource: "git log*" },
    { action: "shell", resource: "git show*" },
  ],
  "release-notes": [
    { action: "shell", resource: "git log*" },
    { action: "shell", resource: "git describe*" },
    { action: "shell", resource: "git tag*" },
    { action: "shell", resource: "git show*" },
  ],
}

export type Built = { readonly prompt: string; readonly allow: Settings.AllowRule[] }

export type Context = {
  /** The pipeline workspace (the repository checkout). */
  readonly workspace: string
  /** The branch a change targets, when the pipeline knows it (a pull request's target). */
  readonly targetBranch: string | undefined
}

export class TaskError extends Error {
  override readonly name = "TaskError"
}

export function build(settings: Settings.Settings, context: Context): Built {
  const parts: string[] = []
  if (settings.preset !== undefined) parts.push(presetPrompt(settings, context))
  if (settings.task !== undefined)
    parts.push(settings.preset === undefined ? settings.task : `Additional instructions:\n${settings.task}`)
  const allow = [...(settings.preset ? presetAllow[settings.preset] : []), ...settings.allow]
  const seen = new Set<string>()
  const unique = allow.filter((rule) => {
    const key = `${rule.action}\u0000${rule.resource}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { prompt: parts.join("\n\n"), allow: unique }
}

function presetPrompt(settings: Settings.Settings, context: Context): string {
  const base = settings.base ?? (context.targetBranch ? `origin/${context.targetBranch}` : undefined)
  switch (settings.preset) {
    case "fix-build": {
      const log = readLogTail(context.workspace, settings.log ?? "")
      return [
        "A step of this CI pipeline failed. Find the cause in the repository and fix it with the smallest change that makes the build pass.",
        "Don't weaken or skip tests, checks or lint rules to make it pass. If you can't fix it, explain what you found.",
        "End with a short summary of the cause and the change.",
        "",
        `The end of the failed step's log (${settings.log}${log.truncated ? ", earlier lines omitted" : ""}, secrets redacted):`,
        "```text",
        log.text,
        "```",
      ].join("\n")
    }
    case "review":
      return [
        `Review the changes on this branch${base ? ` against ${base} (git diff ${base}...HEAD)` : " (the latest commits)"}.`,
        "Look for bugs, security problems, missing tests and unclear code. Don't change any files.",
        "Answer with a concise review in Markdown: the most important findings first, each with the file and line.",
      ].join("\n")
    case "release-notes":
      return [
        `Write release notes for the changes ${base ? `since ${base}` : "since the latest tag (git describe --tags --abbrev=0)"}.`,
        "Group them under Features, Fixes and Other changes; one line each, user-facing wording. Don't change any files.",
        "Answer with the release notes in Markdown only.",
      ].join("\n")
    default:
      return ""
  }
}

/** The log's last `logTailBytes`, redacted. The path must resolve (symlinks too) inside the workspace. */
export function readLogTail(workspace: string, relative: string): { text: string; truncated: boolean } {
  let root: string
  let file: string
  try {
    root = realpathSync(workspace)
    file = realpathSync(path.resolve(root, relative))
  } catch {
    throw new TaskError(`PLUGIN_LOG: ${relative} doesn't exist in the workspace.`)
  }
  const inside = path.relative(root, file)
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside))
    throw new TaskError("PLUGIN_LOG must be a file inside the workspace.")
  const stat = statSync(file)
  if (!stat.isFile()) throw new TaskError("PLUGIN_LOG must be a regular file.")
  const length = Math.min(stat.size, logTailBytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, "r")
  try {
    readSync(fd, buffer, 0, length, stat.size - length)
  } finally {
    closeSync(fd)
  }
  // Drop a partial first line (and a split UTF-8 character) when the log was cut.
  let text = buffer.toString("utf8")
  const truncated = stat.size > length
  if (truncated) text = text.slice(text.indexOf("\n") + 1)
  return { text: KeteRedact.text(text).replace(/```/g, "'''"), truncated }
}
