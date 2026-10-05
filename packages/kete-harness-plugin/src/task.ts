// Kete-owned. Turns the settings into the run's prompt and allow rules. A preset is a prompt plus
// the least it needs to be allowed; `PLUGIN_TASK` adds instructions to a preset or stands alone,
// and `PLUGIN_ALLOW` adds rules. `fix-build` puts the end of the failed step's log in the prompt
// (redacted): the agent works in its own worktree and can't read the pipeline's files outside it.
//
// Preset shell rules are exact commands, never prefixes: `git diff*` would also allow
// `git diff --output=<file>` (a write) and `git difftool`, `git tag*` would allow `git tag -d`. kete
// matches a rule against each command's whole text (redirections included), so an exact rule allows
// that command and nothing else; the prompt lists them.

import { realpathSync, statSync, openSync, readSync, closeSync } from "node:fs"
import path from "node:path"
import type { Secrets } from "./secrets.js"
import { Settings } from "./settings.js"

export * as Task from "./task.js"

/** The end of the log that goes into the prompt. */
export const logTailBytes = 48_000

/** The exact read-only git commands a preset may run, for its base (a validated ref name, so no wildcard). */
export function presetCommands(preset: Settings.Preset, base: string | undefined): string[] {
  switch (preset) {
    // Edits only (below); build and test commands need PLUGIN_ALLOW (they vary per project).
    case "fix-build":
      return []
    case "review":
      return base
        ? [
            `git diff ${base}...HEAD`,
            `git diff --stat ${base}...HEAD`,
            `git log --oneline ${base}..HEAD`,
            `git log ${base}..HEAD`,
          ]
        : [
            "git diff HEAD~1",
            "git diff --stat HEAD~1",
            "git log --oneline -n 20",
            "git show --stat HEAD",
            "git show HEAD",
          ]
    case "release-notes":
      return base
        ? [`git log --oneline ${base}..HEAD`, `git log ${base}..HEAD`, `git diff --stat ${base}...HEAD`]
        : ["git describe --tags --abbrev=0", "git tag --list", "git log --oneline -n 200"]
  }
}

export function presetAllow(preset: Settings.Preset, base: string | undefined): Settings.AllowRule[] {
  // fix-build edits in the run's own worktree (kete job run never edits the workspace itself).
  if (preset === "fix-build") return [{ action: "edit", resource: "*" }]
  return presetCommands(preset, base).map((resource) => ({ action: "shell", resource }))
}

export type Built = { readonly prompt: string; readonly allow: Settings.AllowRule[] }

export type Context = {
  /** The pipeline workspace (the repository checkout). */
  readonly workspace: string
  /** The branch a change targets, when the pipeline knows it (a pull request's target). */
  readonly targetBranch: string | undefined
  /** The workspace's latest tag (`release-notes` without PLUGIN_BASE), when known. */
  readonly latestTag?: string | undefined
  readonly redact: Secrets.Redactor
}

export class TaskError extends Error {
  override readonly name = "TaskError"
}

/** The ref a preset compares with: PLUGIN_BASE, else origin/<target> (review) or the latest tag (release-notes). */
export function presetBase(settings: Settings.Settings, context: Context): string | undefined {
  if (settings.base !== undefined) return settings.base
  const target = context.targetBranch?.replace(/^refs\/heads\//, "")
  if (settings.preset === "review" && target && Settings.isBranchName(target)) return `origin/${target}`
  if (settings.preset === "release-notes" && context.latestTag && Settings.isBranchName(context.latestTag))
    return context.latestTag
  return undefined
}

export function build(settings: Settings.Settings, context: Context): Built {
  const parts: string[] = []
  const base = presetBase(settings, context)
  if (settings.preset !== undefined) parts.push(presetPrompt(settings, context, base))
  if (settings.task !== undefined)
    parts.push(settings.preset === undefined ? settings.task : `Additional instructions:\n${settings.task}`)
  const allow = [...(settings.preset ? presetAllow(settings.preset, base) : []), ...settings.allow]
  const seen = new Set<string>()
  const unique = allow.filter((rule) => {
    const key = `${rule.action}\u0000${rule.resource}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { prompt: parts.join("\n\n"), allow: unique }
}

function presetPrompt(settings: Settings.Settings, context: Context, base: string | undefined): string {
  const commands = settings.preset ? presetCommands(settings.preset, base) : []
  const only = `The only shell commands you may run are these, exactly as written:\n${commands.map((c) => `- \`${c}\``).join("\n")}`
  switch (settings.preset) {
    case "fix-build": {
      const log = readLogTail(context.workspace, settings.log ?? "", context.redact)
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
        `Review the changes on this branch${base ? ` against ${base} (git diff ${base}...HEAD)` : " (the latest commit)"}.`,
        "Look for bugs, security problems, missing tests and unclear code. Don't change any files.",
        "Answer with a concise review in Markdown: the most important findings first, each with the file and line.",
        only,
      ].join("\n")
    case "release-notes":
      return [
        `Write release notes for the changes ${base ? `since ${base}` : "since the latest tag (git describe --tags --abbrev=0; the recent history if there is none)"}.`,
        "Group them under Features, Fixes and Other changes; one line each, user-facing wording. Don't change any files.",
        "Answer with the release notes in Markdown only.",
        only,
      ].join("\n")
    default:
      return ""
  }
}

/** The log's last `logTailBytes`, redacted. The path must resolve (symlinks too) inside the workspace. */
export function readLogTail(
  workspace: string,
  relative: string,
  redact: Secrets.Redactor,
): { text: string; truncated: boolean } {
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
  return { text: redact(text).replace(/```/g, "'''"), truncated }
}
