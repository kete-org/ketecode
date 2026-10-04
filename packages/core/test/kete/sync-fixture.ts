// In-memory skill and MCP registries for plugin tests: transforms re-run from scratch on reload, as in
// the runtime, so a test sees what a client would after the plugin's reload.
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { Mcp } from "@opencode/schema/mcp"
import type { Skill } from "@opencode/schema/skill"

type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]
type McpEditor = Parameters<Parameters<Plugin.Context["mcp"]["transform"]>[0]>[0]

export function registries(initial: { skills?: Skill.Info[]; servers?: Record<string, Mcp.ServerConfig> } = {}) {
  const skills = new Map<string, Skill.Info>()
  const servers = new Map<string, Mcp.ServerConfig>()
  const skillTransforms: Array<(editor: SkillEditor) => void> = []
  const mcpTransforms: Array<(editor: McpEditor) => void> = []
  const skillEditor = {
    list: () => [...skills.values()],
    get: (id: string) => skills.get(id),
    add: (skill: Skill.Info) => void skills.set(skill.id, skill),
    update: (id: string, update: (skill: Skill.Info) => void) => {
      const current = skills.get(id)
      if (current) update(current)
    },
    remove: (id: string) => void skills.delete(id),
  } as unknown as SkillEditor
  const mcpEditor = {
    list: () => [...servers.entries()],
    get: (name: string) => servers.get(name),
    set: (name: string, config: Mcp.ServerConfig) => void servers.set(name, config),
    update: (name: string, update: (config: Mcp.ServerConfig) => void) => {
      const current = servers.get(name)
      if (current) update(current)
    },
    remove: (name: string) => void servers.delete(name),
  } as unknown as McpEditor
  const rebuildSkills = () => {
    skills.clear()
    for (const skill of initial.skills ?? []) skills.set(skill.id, skill)
    for (const transform of skillTransforms) transform(skillEditor)
  }
  const rebuildServers = () => {
    servers.clear()
    for (const [name, config] of Object.entries(initial.servers ?? {})) servers.set(name, config)
    for (const transform of mcpTransforms) transform(mcpEditor)
  }
  const registration = { dispose: Effect.void }
  return {
    skills,
    servers,
    host: {
      skill: {
        list: () => Effect.succeed([...skills.values()]),
        transform: (callback: (editor: SkillEditor) => void) =>
          Effect.sync(() => {
            skillTransforms.push(callback)
            rebuildSkills()
            return registration
          }),
        reload: () => Effect.sync(rebuildSkills),
      } as unknown as Plugin.Context["skill"],
      mcp: {
        list: () => Effect.succeed([]),
        transform: (callback: (editor: McpEditor) => void) =>
          Effect.sync(() => {
            mcpTransforms.push(callback)
            rebuildServers()
            return registration
          }),
        reload: () => Effect.sync(rebuildServers),
      } as unknown as Plugin.Context["mcp"],
    },
  }
}

type Evaluation = Parameters<Parameters<Plugin.Context["permission"]["hook"]>[1]>[0]

/** A permission domain that records `evaluate` hooks, and runs them like the permission service. */
export function permissions() {
  const hooks: Array<(event: Evaluation) => Effect.Effect<void>> = []
  return {
    host: {
      hook: ((name: string, callback: (event: Evaluation) => Effect.Effect<void>) =>
        Effect.sync(() => {
          if (name === "evaluate") hooks.push(callback)
          return { dispose: Effect.void }
        })) as unknown as Plugin.Context["permission"]["hook"],
      list: () => Effect.die("unused permission.list"),
      get: () => Effect.die("unused permission.get"),
      reply: () => Effect.die("unused permission.reply"),
    } as unknown as Plugin.Context["permission"],
    evaluate: (event: Omit<Evaluation, "sessionID"> & { sessionID?: string }) =>
      Effect.gen(function* () {
        const evaluation = { sessionID: "ses_test", ...event } as Evaluation
        for (const hook of hooks) yield* hook(evaluation)
        return { effect: evaluation.effect, message: evaluation.message }
      }),
  }
}
