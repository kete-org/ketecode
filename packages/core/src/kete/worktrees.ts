// Subagents in their own git worktrees, so parallel agents don't overwrite each other's files or
// the parent's.
//
// - `isolate` creates a worktree through the upstream Worktree service (so it is listed, named
//   and set up like any other) from the parent's last commit, puts it on a new branch
//   `kete/agent-<slug>`, and returns the location and metadata to create the child session with.
//   The record of it lives in the child's metadata under `kete.worktree` (only the session it
//   names owns it; nested children inherit metadata but not ownership) and in a KV index, which
//   outlives the session.
// - `report` runs when the subagent finishes: it tells the parent which branch holds the work and
//   how to review and merge it. A subagent that changed nothing has its worktree and branch
//   removed, and its session moved back to the parent's directory; continuing it is refused
//   (`check`).
// - Other sessions are kept out of an agent's worktree (kete/worktree-lease.ts). The plugin refuses
//   to remove a detached worktree whose commits no branch or tag holds unless forced (every
//   worktree, not just agents'), and removes the clean worktrees of deleted sessions (`sweep`).
//   Branches are never deleted while they hold commits.

export * as KeteWorktrees from "./worktrees.js"

import { ToolFailure } from "@opencode/ai"
import { Worktree as WorktreeSchema } from "@opencode/schema/worktree"
import { FSUtil } from "@opencode/util/fs-util"
import { AppProcess } from "@opencode/util/process"
import { Effect, Option, Predicate } from "effect"
import path from "path"
import type { Agent } from "../agent.js"
import { KV } from "../kv.js"
import { Permission } from "../permission.js"
import { Project } from "../project.js"
import type { SessionMessage } from "../session/message.js"
import type { Tool as ToolSchema } from "@opencode/schema/tool"
import { Location } from "../location.js"
import { AbsolutePath } from "../schema.js"
import { Session } from "../session.js"
import { SessionSchema } from "../session/schema.js"
import { Slug } from "../util/slug.js"
import { Worktree } from "../worktree.js"
import { WorktreeStrategies } from "../worktree/strategies.js"
import { KeteGit } from "./git.js"
import { KeteWorktreeLease } from "./worktree-lease.js"

export const metadataKey = "kete.worktree"
export const branchPrefix = "kete/"
const indexPrefix = KeteWorktreeLease.indexPrefix

export const Record = KeteWorktreeLease.Record
export type Record = KeteWorktreeLease.Record
const decodeRecord = KeteWorktreeLease.decode

/** The worktree `session` owns, if any. */
export function owned(session: Pick<SessionSchema.Info, "id" | "metadata">): Record | undefined {
  const record = decodeRecord(session.metadata?.[metadataKey])
  return Option.isSome(record) && record.value.sessionID === session.id ? record.value : undefined
}

/** The repository directory a session's location belongs to: its directory without its subpath. */
export function projectDirectory(session: Pick<SessionSchema.Info, "location" | "subpath">) {
  const subpath = session.subpath ?? ""
  if (subpath === "" || subpath === ".") return session.location.directory
  return path.resolve(session.location.directory, ...subpath.split("/").map(() => ".."))
}

/** What a subagent in its own worktree is told before its task. */
export function instructions(record: Record) {
  return [
    `You are working in your own git worktree at ${record.root}, on branch ${record.branch}, which starts from commit ${record.base.slice(0, 12)}.`,
    "Other agents may be working at the same time in other worktrees. Commit your changes to this branch before you finish: your parent reviews and merges the branch, and uncommitted changes aren't on it.",
    "Don't switch branches, push, or change files outside this worktree.",
  ].join(" ")
}

export type Status = { readonly commits: number; readonly changes: number }

/** What a finished subagent's worktree holds, as the note appended to its answer. */
export function describe(record: Record, status: Status) {
  const base = record.base.slice(0, 12)
  const commits = `${status.commits} commit${status.commits === 1 ? "" : "s"}`
  const changes = `${status.changes} uncommitted change${status.changes === 1 ? "" : "s"}`
  return [
    `<worktree branch="${record.branch}" directory="${record.root}" base="${base}">`,
    `The subagent's work is on branch ${record.branch}: ${commits} since ${base}${status.changes > 0 ? `, and ${changes} in its worktree` : ""}.`,
    `Review it with \`git log ${base}..${record.branch}\` and \`git diff ${base}...${record.branch}\`; merge it into your branch with \`git merge ${record.branch}\`.`,
    ...(status.changes > 0
      ? [
          `Uncommitted changes aren't on the branch: continue the subagent and ask it to commit them, or commit them in ${record.root}.`,
        ]
      : []),
    "</worktree>",
  ].join("\n")
}

const message = (error: unknown) =>
  Predicate.hasProperty(error, "message") && typeof error.message === "string" && error.message !== ""
    ? error.message
    : Predicate.hasProperty(error, "_tag")
      ? String(error._tag)
      : String(error)

/** The tool call a worktree is created for, so the setup script's permission request names it. */
export interface Invocation {
  readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID
  readonly id: ToolSchema.CallID
}

export const make = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const projects = yield* Project.Service
  const permission = yield* Permission.Service
  const worktrees = yield* Worktree.Service
  const kv = yield* KV.Service
  const fs = yield* FSUtil.Service
  const git = yield* KeteGit.make

  const status = Effect.fnUntraced(function* (record: Record) {
    const commits = yield* git.text(record.root, ["rev-list", "--count", `${record.base}..HEAD`])
    const changes = yield* git.text(record.root, ["status", "--porcelain"])
    return { commits: Number(commits), changes: changes.split("\n").filter(Boolean).length } satisfies Status
  })

  /** Removes a clean worktree; the branch too when it holds nothing beyond its base. Keeps anything with changes. */
  const release = Effect.fnUntraced(function* (record: Record) {
    if (yield* fs.isDir(record.root)) {
      const current = yield* status(record)
      if (current.changes > 0) return false
      yield* worktrees.remove({
        projectID: record.projectID,
        directory: AbsolutePath.make(record.root),
        force: false,
      })
    }
    const tip = yield* git.run(record.source, ["rev-parse", "--verify", `refs/heads/${record.branch}`])
    if (tip.exitCode === 0 && tip.stdout.trim() === record.base)
      yield* git.text(record.source, ["branch", "-D", record.branch])
    yield* kv.remove(indexPrefix + record.sessionID)
    return true
  })

  /** Removes the clean worktrees of sessions that no longer exist; keeps those with uncommitted changes. */
  const sweep = Effect.gen(function* () {
    let after: string | undefined
    const records: Record[] = []
    do {
      const page = yield* kv.scan({ prefix: indexPrefix, after })
      for (const entry of page.entries) {
        const record = decodeRecord(entry.value)
        if (Option.isSome(record)) records.push(record.value)
      }
      after = page.next
    } while (after)
    yield* Effect.forEach(
      records,
      (record) =>
        sessions.get(record.sessionID).pipe(
          Effect.as(undefined),
          Effect.catchTag("Session.NotFoundError", () =>
            release(record).pipe(
              Effect.tap((released) =>
                released
                  ? Effect.void
                  : Effect.logWarning("kept a deleted subagent's worktree: it has uncommitted changes", {
                      directory: record.root,
                    }),
              ),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to clean up a subagent worktree", { directory: record.root, cause }),
          ),
        ),
      { discard: true },
    )
  })

  /**
   * Creates a worktree on a new branch for a new child of `parent`, from the parent's last commit.
   * Returns the location and metadata to create the child with.
   */
  const isolate = Effect.fn("KeteWorktrees.isolate")(function* (
    parent: SessionSchema.Info,
    childID: SessionSchema.ID,
    invocation: Invocation,
  ) {
    if (parent.location.workspaceID !== undefined)
      return yield* new ToolFailure({ message: "Worktrees for subagents are only available in local sessions." })
    const source = projectDirectory(parent)
    // Creating the worktree runs the project's setup script; the agent asks for it like any command.
    const setup = (yield* projects.list()).find((project) => project.id === parent.projectID)?.commands?.start?.trim()
    if (setup)
      yield* permission
        .assert({
          action: "shell",
          resources: [setup],
          save: [setup],
          metadata: { reason: "worktree setup script (the project's commands.start)" },
          sessionID: parent.id,
          agent: invocation.agent,
          source: { type: "tool", messageID: invocation.messageID, id: invocation.id },
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ToolFailure({
                message: `The subagent's worktree wasn't created: its setup script (${setup}) wasn't allowed.`,
                error,
              }),
          ),
        )
    const base = yield* git.text(source, ["rev-parse", "--verify", "HEAD"]).pipe(
      Effect.mapError(
        (error) =>
          new ToolFailure({
            message: `A subagent worktree needs a git repository with at least one commit (${message(error)}).`,
          }),
      ),
    )
    yield* sweep.pipe(
      Effect.andThen(git.run(source, ["worktree", "prune"])),
      Effect.catchCause((cause) => Effect.logWarning("failed to prune subagent worktrees", { source, cause })),
    )
    const info = yield* worktrees
      .create({ projectID: parent.projectID, from: AbsolutePath.make(source), name: `agent-${Slug.create()}` })
      .pipe(
        Effect.mapError(
          (error) => new ToolFailure({ message: `Could not create a worktree for the subagent: ${message(error)}` }),
        ),
      )
    const branch = `${branchPrefix}${path.basename(info.directory)}`
    const switched = yield* git.run(info.directory, ["switch", "--create", branch]).pipe(Effect.option)
    if (Option.isNone(switched) || switched.value.exitCode !== 0) {
      yield* worktrees
        .remove({ projectID: parent.projectID, directory: info.directory, force: true })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to remove an unused worktree", { cause })))
      return yield* new ToolFailure({
        message: `Could not create branch ${branch} for the subagent: ${Option.isSome(switched) ? switched.value.stderr.trim() : "git did not run"}`,
      })
    }
    const record: Record = {
      sessionID: childID,
      projectID: parent.projectID,
      root: info.directory,
      branch,
      base,
      source,
    }
    yield* kv.set(indexPrefix + childID, record)
    const nested = parent.subpath ? path.join(info.directory, parent.subpath) : info.directory
    const directory = (yield* fs.isDir(nested)) ? nested : info.directory
    return {
      record,
      location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      metadata: { ...parent.metadata, [metadataKey]: record },
    }
  })

  /** Refuses to continue a child whose worktree was removed. */
  const check = Effect.fn("KeteWorktrees.check")(function* (child: SessionSchema.Info) {
    const record = owned(child)
    if (record === undefined || (yield* fs.isDir(record.root))) return
    return yield* new ToolFailure({
      message: `Subagent ${child.id} finished without changes, so its worktree was removed. Start a new subagent instead of continuing this one.`,
    })
  })

  /**
   * Describes a finished subagent's worktree for its parent. With `release`, a worktree without
   * commits or changes is removed with its branch, and the child moves back to its parent's
   * directory.
   */
  const report = Effect.fn("KeteWorktrees.report")(function* (
    childID: SessionSchema.ID,
    options: { readonly release: boolean },
  ) {
    const child = yield* sessions.get(childID).pipe(Effect.option)
    const record = Option.isSome(child) ? owned(child.value) : undefined
    if (record === undefined || !(yield* fs.isDir(record.root))) return undefined
    const current = yield* status(record).pipe(Effect.option)
    if (Option.isNone(current))
      return `<worktree branch="${record.branch}" directory="${record.root}">\nThe subagent worked on branch ${record.branch} in ${record.root}; its status could not be read.\n</worktree>`
    if (!options.release || current.value.commits > 0 || current.value.changes > 0)
      return describe(record, current.value)
    const released = yield* release(record).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to remove an unchanged subagent worktree", { directory: record.root, cause }).pipe(
          Effect.as(false),
        ),
      ),
    )
    if (!released) return describe(record, current.value)
    const parentID = Option.isSome(child) ? child.value.parentID : undefined
    if (parentID !== undefined)
      yield* sessions.get(parentID).pipe(
        Effect.flatMap((parent) => sessions.move({ sessionID: childID, directory: parent.location.directory })),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to move a subagent back to its parent's directory", { childID, cause }),
        ),
      )
    return `<worktree branch="${record.branch}">\nThe subagent changed nothing, so its worktree and branch ${record.branch} were removed.\n</worktree>`
  })

  return {
    isolate,
    check,
    report,
    sweep,
    leasedTo: (directory: string, sessionID: SessionSchema.ID) => leasedTo(kv, directory, sessionID),
  }
})

export const leasedTo = KeteWorktreeLease.leasedTo

/**
 * `make`, when the services it needs are provided. Subagents are also built in contexts without
 * them (focused tests); worktree subagents aren't available there.
 */
export const optional = Effect.gen(function* () {
  const [worktree, kv, fs, proc, projects, permission] = yield* Effect.all([
    Effect.serviceOption(Worktree.Service),
    Effect.serviceOption(KV.Service),
    Effect.serviceOption(FSUtil.Service),
    Effect.serviceOption(AppProcess.Service),
    Effect.serviceOption(Project.Service),
    Effect.serviceOption(Permission.Service),
  ])
  if (
    Option.isNone(worktree) ||
    Option.isNone(kv) ||
    Option.isNone(fs) ||
    Option.isNone(proc) ||
    Option.isNone(projects) ||
    Option.isNone(permission)
  )
    return undefined
  return yield* make.pipe(
    Effect.provideService(Worktree.Service, worktree.value),
    Effect.provideService(KV.Service, kv.value),
    Effect.provideService(FSUtil.Service, fs.value),
    Effect.provideService(AppProcess.Service, proc.value),
    Effect.provideService(Project.Service, projects.value),
    Effect.provideService(Permission.Service, permission.value),
  )
})

/**
 * Wraps a worktree strategy's remove: a detached worktree whose HEAD has commits that no branch,
 * tag or remote branch contains is only removed with force, since removing it would lose them.
 */
export function guard(
  strategy: WorktreeStrategies.Strategy,
  git: Effect.Success<typeof KeteGit.make>,
): WorktreeStrategies.Strategy {
  return {
    ...strategy,
    remove: (input) =>
      Effect.gen(function* () {
        if (!input.force) {
          const symbolic = yield* git.run(input.directory, ["symbolic-ref", "--quiet", "HEAD"])
          if (symbolic.exitCode !== 0) {
            const unique = Number(
              yield* git.text(input.directory, [
                "rev-list",
                "--count",
                "HEAD",
                "--not",
                "--branches",
                "--tags",
                "--remotes",
              ]),
            )
            if (unique > 0)
              return yield* new WorktreeSchema.OperationError({
                message: `This worktree has ${unique} commit${unique === 1 ? "" : "s"} that no branch or tag contains; removing it would lose them. Create a branch for them first (git branch <name> HEAD), or remove it with force.`,
                forceRequired: true,
              })
          }
        }
        yield* strategy.remove(input)
      }),
  }
}

export const Plugin = {
  id: "kete.worktrees",
  effect: Effect.fn("KeteWorktrees.Plugin")(function* () {
    const strategies = yield* WorktreeStrategies.Service
    const git = yield* KeteGit.make
    const controls = yield* make

    const current = strategies.get()
    const upstream = current.strategies.get(current.selected)
    if (upstream !== undefined && upstream.id === "git")
      yield* strategies.transform((editor) => editor.add(guard(upstream, git)))

    yield* controls.sweep.pipe(
      Effect.catchCause((cause) => Effect.logWarning("failed to clean up subagent worktrees", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
}
