// Folder trust on first run (task 2026-10-11-folder-trust, A10; docs/folder-trust.md). Opening Kete
// Code in a folder never runs code or sends data somewhere because of that folder's own config until
// the person says they trust it.
//
// A location service Config calls from one marked seam in `Config.load` (config.ts): `gate` receives
// every loaded entry and returns them with the project documents' guarded settings removed when the
// folder isn't trusted for its current fingerprint (util/src/kete/folder-trust.ts lists them: the job
// list plus formatter, shell, worktree and loosening permission rules). MCP, providers, sharing,
// formatters, the shell, worktrees, permissions, `kete.*` readers and hooks only ever see the gated
// entries, so nothing guarded starts before trust. Two more marked seams ask this service:
// ConfigPluginSource skips `.kete/plugin(s)/` of an untrusted folder (`pluginsAllowed`), and
// ConfigAgentPlugin strips loosening rules from its project agent markdown files (`agentDocuments`).
// AGENTS.md, agents, commands, skills, instructions and every other setting load as before.
//
// - Trusted: the store (`folder-trust.json`, util/src/kete/folder-trust-store.ts) holds the trust
//   root's key with this fingerprint; or this is a private server `kete run --trust-project-config`
//   started (run trust, `runTrusted`); or job mode (its server loads no project config).
// - Untrusted, something held back: one `kete.folder.trust` form (`"global"` owner) per trust root and
//   fingerprint, shared across locations through the process-wide memory node. Trust stores the
//   fingerprint, also trusts the folder's current project hooks (kete/hooks/settings.ts `projectHooksTrust`,
//   so there is one question, not two) and announces the root, so every location under it reloads its
//   config with everything. Not now (or a cancelled form) holds back until the runtime restarts. A
//   warning naming what's held back is logged once (the path for ACP and attached clients, which
//   don't show the form).
// - The home directory and the filesystem root can't be trusted, nor can a folder too large to
//   fingerprint; they are offered "Not now" with the reason.
// - Fail closed: any error while checking counts as untrusted, and then the project documents are
//   dropped whole rather than passed through.

export * as KeteFolderTrust from "./folder-trust.js"

import path from "path"
import { parse, type ParseError } from "jsonc-parser"
import { Context, Effect, Layer, Stream } from "effect"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { ConfigKete } from "@opencode/schema/config/kete"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Brand } from "@opencode/util/kete/brand"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import { KeteFolderTrustStore } from "@opencode/util/kete/folder-trust-store"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { Form } from "../form.js"
import { Location } from "../location.js"
import { Wildcard } from "../util/wildcard.js"
import { KeteHooksSettings } from "./hooks/settings.js"
import { KeteHooksTrust } from "./hooks/trust.js"
import { KeteFolderTrustForm } from "./folder-trust/form.js"
import { KeteFolderTrustMemory } from "./folder-trust/memory.js"

type Rule = KeteFolderTrustRules.Rule

/** Which loaded paths are the project's (Config.load knows: `sources.direct` and `sources.project`). */
export interface Project {
  /** Every project config file path Config read (direct files and `<.kete>/kete.json(c)`). */
  readonly documents: ReadonlySet<string>
  /** The project `.kete/` directories (their `Directory` entries). */
  readonly directories: ReadonlySet<string>
}

export type Status =
  | { readonly kind: "pending" }
  | { readonly kind: "clear" }
  | { readonly kind: "trusted"; readonly reason: "store" | "run" | "job"; readonly root?: string }
  | { readonly kind: "untrusted"; readonly root?: string; readonly held: ReadonlyArray<string>; readonly refusal?: string }

export interface Interface {
  /** The entries with guarded project settings removed unless the folder is trusted. */
  readonly gate: (
    entries: ReadonlyArray<Entry>,
    project: Project,
    texts: ReadonlyMap<string, string>,
  ) => Effect.Effect<Entry[]>
  /** Whether plugin code in this config directory may load. */
  readonly pluginsAllowed: (directory: string) => Effect.Effect<boolean>
  /** Agent markdown documents from this config directory, with loosening rules removed unless trusted. */
  readonly agentDocuments: (directory: string, documents: ReadonlyArray<Document>) => Effect.Effect<Document[]>
  /** Emits when this location's trust root is trusted (Config reloads). */
  readonly changes: () => Stream.Stream<void>
  readonly status: () => Effect.Effect<Status>
}

export class Service extends Context.Service<Service, Interface>()("@kete/FolderTrust") {}

export interface Options {
  readonly env?: Record<string, string | undefined>
  readonly ppid?: number
  readonly fs?: KeteFolderTrustRules.Fs
}

/** Deny rules from machine-level documents (global, wellknown, explicit, content). */
export function machineDenies(documents: ReadonlyArray<Document>): Rule[] {
  return documents.flatMap((document) => [
    ...(document.info.permissions ?? []),
    ...Object.values(document.info.agents ?? {}).flatMap((agent) => agent.permissions ?? []),
  ]).filter((rule) => rule.effect === "deny")
}

/** An agent's config with its loosening permission rules removed. */
function stripAgent(agent: ConfigAgent.Info, machineDeny: ReadonlyArray<Rule>) {
  if (!agent.permissions) return { agent, held: [] as Rule[] }
  const split = KeteFolderTrustRules.loosening(agent.permissions, machineDeny, Wildcard.match)
  if (split.held.length === 0) return { agent, held: split.held }
  const { permissions: _permissions, ...rest } = agent
  return { agent: new ConfigAgent.Info(split.kept.length ? { ...rest, permissions: split.kept } : rest), held: split.held }
}

/**
 * A project document without its runtime-guarded settings (util/src/kete/folder-trust.ts). Works on
 * the normalized `info`, so v1 keys (`provider`, `plugin`, `permission`, `tools`, `agent`, `mode`)
 * are covered. Returns the document unchanged when nothing is guarded.
 */
export function strip(document: Document, machineDeny: ReadonlyArray<Rule>) {
  const info = document.info
  const next: Record<string, unknown> = { ...info }
  const removed: string[] = []
  const rules: Array<{ rule: Rule; where: string }> = []
  for (const key of ["providers", "mcp", "plugins", "enterprise", "shell", "worktree"] as const)
    if (info[key] !== undefined) {
      delete next[key]
      removed.push(key)
    }
  if (info.share !== undefined && info.share !== "disabled") {
    delete next.share
    removed.push("share")
  }
  if (info.formatter !== undefined && info.formatter !== false) {
    delete next.formatter
    removed.push("formatter")
  }
  if (info.kete) {
    const kete: Record<string, unknown> = { ...info.kete }
    const held = KeteFolderTrustRules.KETE_GUARDED.filter((key) => kete[key] !== undefined)
    if (held.length > 0) {
      for (const key of held) delete kete[key]
      removed.push(...held.map((key) => `kete.${key}`))
      if (Object.values(kete).some((value) => value !== undefined)) next.kete = new ConfigKete.Info(kete as ConfigKete.Info)
      else delete next.kete
    }
  }
  if (info.permissions) {
    const split = KeteFolderTrustRules.loosening(info.permissions, machineDeny, Wildcard.match)
    if (split.held.length > 0) {
      rules.push(...split.held.map((rule) => ({ rule, where: "permissions" })))
      if (split.kept.length > 0) next.permissions = split.kept
      else delete next.permissions
    }
  }
  if (info.agents) {
    const agents: Record<string, ConfigAgent.Info> = {}
    let changed = false
    for (const [id, agent] of Object.entries(info.agents)) {
      const result = stripAgent(agent, machineDeny)
      agents[id] = result.agent
      if (result.held.length > 0) {
        changed = true
        rules.push(...result.held.map((rule) => ({ rule, where: `agent ${JSON.stringify(id)}` })))
      }
    }
    if (changed) next.agents = agents
  }
  if (removed.length === 0 && rules.length === 0) return { document, removed, rules }
  return {
    document: new Document({ type: "document", ...(document.path ? { path: document.path } : {}), info: new Info(next as Info) }),
    removed,
    rules,
  }
}

/** Agent documents with every loosening rule removed (`agentDocuments`). */
function stripAgentDocuments(documents: ReadonlyArray<Document>, machineDeny: ReadonlyArray<Rule>): Document[] {
  return documents.map((document) => {
    if (!document.info.agents) return document
    let changed = false
    const agents: Record<string, ConfigAgent.Info> = {}
    for (const [id, agent] of Object.entries(document.info.agents)) {
      const result = stripAgent(agent, machineDeny)
      agents[id] = result.agent
      if (result.held.length > 0) changed = true
    }
    if (!changed) return document
    return new Document({
      type: "document",
      ...(document.path ? { path: document.path } : {}),
      info: new Info({ ...document.info, agents } as Info),
    })
  })
}

const parseRaw = (text: string): { ok: true; value: unknown } | { ok: false } => {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  return errors.length ? { ok: false } : { ok: true, value }
}

export const layerWith = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const location = yield* Location.Service
      const forms = yield* Form.Service
      const memory = yield* KeteFolderTrustMemory.Service
      const scope = yield* Effect.scope
      const env = options.env ?? process.env
      const ppid = options.ppid ?? process.ppid
      const fs = options.fs ?? KeteFolderTrustRules.nodeFs
      const store = KeteFolderTrustStore.make(global.state)
      const hooksTrust = KeteHooksTrust.make(global.state)

      let status: Status = { kind: "pending" }
      let projectDirectories = new Set<string>()
      let machineDeny: Rule[] = []
      let rootKey: string | undefined

      const looksLikeProject = (directory: string) =>
        path.basename(directory) === Brand.projectDirectory && path.resolve(directory) !== path.resolve(global.config)
      const isProjectDirectory = (directory: string) =>
        status.kind === "pending" ? looksLikeProject(directory) : projectDirectories.has(directory)

      const trust = Effect.fn("KeteFolderTrust.trust")(function* (
        key: string,
        fingerprint: string,
        held: ReadonlyArray<string>,
        ungated: ReadonlyArray<Entry>,
      ) {
        yield* Effect.promise(() => store.trust(key, fingerprint, held))
        // One question, not two: the folder's current project hooks are trusted with it.
        yield* Effect.promise(async () => {
          const repositoryKey = await KeteHooksSettings.repositoryKeyOf(location)
          const hooks = await KeteHooksSettings.projectHooksTrust(ungated, {
            globalConfig: global.config,
            repositoryKey,
            cwd: location.directory,
          })
          if (hooks.kind === "ok") await hooksTrust.trust(repositoryKey, hooks.fingerprint, hooks.commands)
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't trust the folder's project hooks", { cause })))
        yield* memory.publish(key)
      })

      const ask = (input: {
        key: string
        root: string
        fingerprint?: string
        refusal?: string
        items: ReadonlyArray<string>
        ungated: ReadonlyArray<Entry>
      }) => {
        const question = `${input.key}\u0000${input.fingerprint ?? input.refusal ?? ""}`
        if (memory.declined.has(question) || memory.pending.has(question)) return Effect.void
        memory.pending.add(question)
        return forms.ask(KeteFolderTrustForm.create({ root: input.root, items: input.items, refusal: input.refusal })).pipe(
          Effect.flatMap((state) =>
            KeteFolderTrustForm.decision(state) === "trust" && input.fingerprint !== undefined && input.refusal === undefined
              ? trust(input.key, input.fingerprint, input.items, input.ungated)
              : Effect.sync(() => memory.declined.add(question)),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => memory.declined.add(question)).pipe(
              Effect.andThen(Effect.logWarning("the folder trust question failed; holding back", { cause })),
            ),
          ),
          // Interrupted (the location closed): neither answered nor declined; ask again next time.
          Effect.ensuring(Effect.sync(() => memory.pending.delete(question))),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      }

      const warn = (key: string, fingerprint: string | undefined, root: string, items: ReadonlyArray<string>) => {
        const id = `${key}\u0000${fingerprint ?? ""}`
        if (memory.warned.has(id)) return Effect.void
        memory.warned.add(id)
        return Effect.logWarning("project configuration held back: this folder isn't trusted", {
          root,
          held: items.slice(0, 20),
          more: Math.max(0, items.length - 20),
        })
      }

      const evaluate = Effect.fn("KeteFolderTrust.evaluate")(function* (
        entries: ReadonlyArray<Entry>,
        project: Project,
        texts: ReadonlyMap<string, string>,
      ) {
        const isProjectDocument = (entry: Entry): entry is Document =>
          entry.type === "document" && entry.path !== undefined && project.documents.has(entry.path)
        machineDeny = machineDenies(
          entries.filter((entry): entry is Document => entry.type === "document" && !isProjectDocument(entry)),
        )
        const items: string[] = []
        const stripped = entries.map((entry) => {
          if (!isProjectDocument(entry)) return entry
          const result = strip(entry, machineDeny)
          if (result.removed.length === 0 && result.rules.length === 0) return entry
          const text = entry.path ? texts.get(entry.path) : undefined
          const raw = text === undefined ? undefined : parseRaw(text)
          const described = raw?.ok ? KeteFolderTrustRules.describe(raw.value) : []
          items.push(...(described.length > 0 || result.removed.length === 0 ? described : result.removed))
          items.push(...result.rules.map(({ rule, where }) => KeteFolderTrustRules.describeRule(rule, where)))
          return result.document
        })
        const plugins: string[] = []
        const agents: string[] = []
        for (const directory of project.directories) {
          plugins.push(...(yield* Effect.promise(() => KeteFolderTrustRules.pluginDirectories(directory, fs))))
          agents.push(...(yield* Effect.promise(() => KeteFolderTrustRules.agentPermissionFiles(directory, fs))))
        }
        const changed = stripped.some((entry, index) => entry !== entries[index])
        if (!changed && plugins.length === 0 && agents.length === 0) {
          status = { kind: "clear" }
          return [...entries]
        }
        if (KeteFolderTrustRules.runTrusted(env, ppid)) {
          status = { kind: "trusted", reason: "run" }
          return [...entries]
        }

        const root = yield* Effect.promise(() => KeteFolderTrustRules.trustRoot(location.directory, fs))
        const top = root.kind === "ok" ? root.top : location.directory
        items.push(...plugins.map((directory) => `plugin code in ${JSON.stringify(KeteFolderTrustRules.display(directory, top))}`))
        items.push(
          ...agents.map((file) => `permission rules in agent file ${JSON.stringify(KeteFolderTrustRules.display(file, top))}`),
        )
        if (root.kind !== "ok") {
          status = { kind: "untrusted", held: items, refusal: root.reason }
          rootKey = undefined
          yield* warn(location.directory, undefined, location.directory, items)
          yield* ask({ key: location.directory, root: location.directory, refusal: root.reason, items, ungated: entries })
          return stripped
        }
        const key = KeteFolderTrustRules.storeKey(root.root)
        rootKey = key
        const home = yield* Effect.promise(() => fs.realpath(global.home).catch(() => global.home))
        const documents = [...project.documents].flatMap((file) => {
          const text = texts.get(file)
          if (text === undefined) return []
          const raw = parseRaw(text)
          return raw.ok ? [{ path: file, document: raw.value }] : []
        })
        const fingerprint = yield* Effect.promise(() =>
          KeteFolderTrustRules.fingerprint({ top, documents, plugins, agents }, fs),
        )
        const refusal =
          KeteFolderTrustRules.neverTrusted(key, home) ?? (fingerprint.kind === "unavailable" ? fingerprint.reason : undefined)
        const value = fingerprint.kind === "ok" ? fingerprint.value : undefined
        if (refusal === undefined && value !== undefined && (yield* Effect.promise(() => store.trusted(key, value)))) {
          status = { kind: "trusted", reason: "store", root: root.root }
          return [...entries]
        }
        status = { kind: "untrusted", root: root.root, held: items, ...(refusal ? { refusal } : {}) }
        yield* warn(key, value, root.root, items)
        yield* ask({ key, root: root.root, fingerprint: value, refusal, items, ungated: entries })
        return stripped
      })

      return Service.of({
        gate: (entries, project, texts) =>
          Effect.suspend(() => {
            projectDirectories = new Set(project.directories)
            if (KeteJobMode.enabled(env)) {
              status = { kind: "trusted", reason: "job" }
              return Effect.succeed([...entries])
            }
            return evaluate(entries, project, texts)
          }).pipe(
            // Fail closed: an error while checking drops the project documents whole.
            Effect.catchCause((cause) =>
              Effect.logWarning("couldn't check folder trust; holding back the project configuration", { cause }).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    status = { kind: "untrusted", held: ["the project configuration (trust couldn't be checked)"] }
                    return entries.filter(
                      (entry) => !(entry.type === "document" && entry.path !== undefined && project.documents.has(entry.path)),
                    )
                  }),
                ),
              ),
            ),
          ),
        pluginsAllowed: (directory) =>
          Effect.sync(() => status.kind === "trusted" || !isProjectDirectory(directory)),
        agentDocuments: (directory, documents) =>
          Effect.sync(() => {
            if (status.kind === "trusted" || !isProjectDirectory(directory)) return [...documents]
            try {
              return stripAgentDocuments(documents, machineDeny)
            } catch {
              // Fail closed: every allow goes.
              return stripAgentDocuments(documents, [{ action: "*", resource: "*", effect: "deny" }])
            }
          }),
        changes: () =>
          memory.trusted().pipe(
            Stream.filter((key) => key === rootKey),
            Stream.map(() => undefined),
          ),
        status: () => Effect.sync(() => status),
      })
    }),
  )

export const layer = layerWith()

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layerWith(options),
    deps: [Global.node, Location.node, Form.node, KeteFolderTrustMemory.node],
  })
}

export const node = configured()
