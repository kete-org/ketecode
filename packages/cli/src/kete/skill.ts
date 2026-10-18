// `kete skill add|list|update|remove`: the real dependencies for ./skill-flow.ts (see there for the rules).

export * as KeteSkillCommand from "./skill"

import { readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Option } from "effect"
import { Brand } from "@opencode/util/kete/brand"
import { KeteAccount } from "@opencode/util/kete/account"
import { Global } from "@opencode/util/global"
import { KeteSyncCache } from "@opencode/util/kete/sync/cache"
import { KeteSyncSkills } from "@opencode/util/kete/sync/skills"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { KeteSkillFlow } from "./skill-flow"

const realDeps = (): KeteSkillFlow.Deps => ({
  cwd: process.env.PWD ?? process.cwd(),
  globalDir: Global.Path.config,
  tmp: os.tmpdir(),
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  confirm: async (message) => {
    const { confirm, isCancel } = await import("@clack/prompts")
    const answer = await confirm({ message, initialValue: false })
    return !isCancel(answer) && answer === true
  },
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
  policies: async () => {
    const account = KeteAccount.defaults()
    const signedIn = await KeteAccount.read(account)
    if (!signedIn) return undefined
    if (!KeteSyncCache.validOrganization(signedIn.organization.id)) throw new Error("the signed-in organization id is not valid")
    const cached = await KeteSyncCache.read(account.config, signedIn.organization.id)
    return cached ? (cached.response.policies ?? []) : "no-cache"
  },
  orgSkills: async () => {
    const organizations = await readdir(path.join(Global.Path.config, "managed")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const slugs = await Promise.all(
      organizations.filter(KeteSyncCache.validOrganization).map((organization) => KeteSyncSkills.present(Global.Path.config, organization)),
    )
    return new Set(slugs.flatMap((set) => [...set]))
  },
})

const settle = (work: () => Promise<number>) =>
  Effect.promise(() =>
    work().catch((error: unknown) => {
      process.stderr.write(`${Brand.cliName} skill: ${error instanceof Error ? error.message : String(error)}\n`)
      return KeteSkillFlow.EXIT.failed
    }),
  ).pipe(Effect.map((code) => void (process.exitCode = code)))

const skill = Commands.commands.skill.commands

export const addCommand = Runtime.handler(skill.add, (input) =>
  settle(() =>
    KeteSkillFlow.add(
      realDeps(),
      { source: input.source, path: Option.getOrUndefined(input.path), ref: Option.getOrUndefined(input.ref), name: Option.getOrUndefined(input.name) },
      { global: input.global, yes: input.yes },
    ),
  ),
)
export const listCommand = Runtime.handler(skill.list, (input) => settle(() => KeteSkillFlow.list(realDeps(), { global: input.global })))
export const updateCommand = Runtime.handler(skill.update, (input) =>
  settle(() => KeteSkillFlow.update(realDeps(), Option.getOrUndefined(input.name), { global: input.global, yes: input.yes })),
)
export const removeCommand = Runtime.handler(skill.remove, (input) =>
  settle(() => KeteSkillFlow.remove(realDeps(), input.name, { global: input.global, yes: input.yes })),
)
