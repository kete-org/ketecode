// Folder trust on first run (task 2026-10-11-folder-trust, A10; docs/folder-trust.md). Opening Kete
// Code in a folder never runs code or sends data somewhere because of that folder's own config until
// the person says they trust it.
//
// A location service Config calls from one marked seam in `Config.load` (config.ts). `gate` loads the
// entries itself, through the loader Config hands it: first with the project documents parsed raw
// (no `{env:…}`/`{file:…}` substitution), and decides on those. When the folder is trusted for its
// current fingerprint (or nothing in it is held back) the project documents are loaded again from the
// same text, substituted; otherwise they stay raw (the tokens are left as they are) with their guarded
// settings removed (util/src/kete/folder-trust.ts lists them: the job list plus formatter, shell,
// worktree, remote skills URLs, git references, loosening permission rules and policy allows). MCP,
// providers, sharing, formatters, the shell, worktrees, skills, references, permissions, policies,
// `kete.*` readers and hooks only ever see the gated entries, so nothing guarded starts before trust.
// Two more marked seams ask this service: ConfigPluginSource skips `.kete/plugin(s)/` of an untrusted
// folder (`pluginsAllowed`), and ConfigAgentPlugin strips loosening rules from its project agent
// markdown files (`agentDocuments`; with no service it strips them itself, fail closed). The TUI asks
// through the `kete.folder.trust` RPC (folder-trust/rpc.ts) before it loads `.kete/plugins/`.
// AGENTS.md, agents, commands, local skills, instructions and every other setting load as before.
//
// Whatever the trust state, a project document's `kete` object can't mask the machine-level one for
// the settings that matter for safety (`shield`): global `kete.offline: true` stays on, and
// `integrations`, `platform` and `unattended` come from the machine level when the project doesn't set
// them (or they are held back). Readers take the last `kete` object whole (Config.latest), so without
// this a project `kete: { budget: … }` would turn those off.
//
// - Trusted: the store (`folder-trust.json`, util/src/kete/folder-trust-store.ts) holds the trust
//   root's key with this fingerprint; or this is a private server `kete run --trust-project-config`
//   started (run trust, `runTrusted`); or job mode with no project config loaded at all.
// - Untrusted, something held back: one `kete.folder.trust` form (`"global"` owner) per trust root and
//   fingerprint, shared across locations through the process-wide memory node. Trust stores the
//   fingerprint, also trusts the folder's current project hooks (kete/hooks/settings.ts `projectHooksTrust`,
//   so there is one question, not two) and announces the root, so every location under it reloads its
//   config with everything. Not now (or a cancelled form) holds back until the runtime restarts. A
//   warning naming what's held back is logged once (the path for ACP and attached clients, which
//   don't show the form).
// - The home directory and the filesystem root can't be trusted, nor can a folder too large to
//   fingerprint or whose config only parses after substitution; they are offered "Not now" with the
//   reason. So is a question whose list had to be cut short (folder-trust/form.ts).
// - Fail closed: any error while checking counts as untrusted, and then the project documents are
//   dropped whole rather than passed through.

export * as KeteFolderTrust from "./folder-trust.js"

import path from "path"
import { parse, type ParseError } from "jsonc-parser"
import { Context, Effect, Layer, Stream } from "effect"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { ConfigKete } from "@opencode/schema/config/kete"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { Brand } from "@opencode/util/kete/brand"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import { KeteFolderTrustStore } from "@opencode/util/kete/folder-trust-store"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { ConfigMarkdown } from "../config/markdown.js"
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

/** Config's loader: every entry, with the project documents substituted (`true`, from the text read
 * by the first load only) or parsed raw (`false`). */
export type Load = (substitute: boolean) => Effect.Effect<ReadonlyArray<Entry>>

export type Status =
  | { readonly kind: "pending" }
  | { readonly kind: "clear" }
  | { readonly kind: "trusted"; readonly reason: "store" | "run" | "job"; readonly root?: string }
  | { readonly kind: "untrusted"; readonly root?: string; readonly held: ReadonlyArray<string>; readonly refusal?: string }

export interface Interface {
  /** Loads the entries (`load`) with guarded project settings removed and project documents left
   * unsubstituted unless the folder is trusted. `texts` holds the raw text `load(false)` read. */
  readonly gate: (load: Load, project: Project, texts: ReadonlyMap<string, string>) => Effect.Effect<Entry[]>
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

/** Deny rules from machine-level documents (global, wellknown, explicit, content) and from the
 * machine-level agent markdown files (`agentRules`, already decoded). */
export function machineDenies(documents: ReadonlyArray<Document>, agentRules: ReadonlyArray<Rule> = []): Rule[] {
  return [
    ...documents.flatMap((document) => [
      ...(document.info.permissions ?? []),
      ...Object.values(document.info.agents ?? {}).flatMap((agent) => agent.permissions ?? []),
    ]),
    ...agentRules,
  ].filter((rule) => rule.effect === "deny")
}

/** The permission rules in an agent markdown file's front matter, decoded as ConfigAgentPlugin
 * decodes it (YAML escapes, tags and aliases included). */
export function agentFileRules(text: string): Rule[] {
  const markdown = ConfigMarkdown.parseOption(text)
  return markdown ? KeteFolderTrustRules.frontMatterRules(markdown.data) : []
}

/** Rules every allow (and every ask) fails against: what "machine denies unknown" means. */
const DENY_ALL: ReadonlyArray<Rule> = [{ action: "*", resource: "*", effect: "deny" }]

/** An agent's config with its loosening permission rules removed. */
function stripAgent(agent: ConfigAgent.Info, machineDeny: ReadonlyArray<Rule>) {
  if (!agent.permissions) return { agent, held: [] as Rule[] }
  const split = KeteFolderTrustRules.loosening(agent.permissions, machineDeny, Wildcard.match)
  if (split.held.length === 0) return { agent, held: split.held }
  const { permissions: _permissions, ...rest } = agent
  return { agent: new ConfigAgent.Info(split.kept.length ? { ...rest, permissions: split.kept } : rest), held: split.held }
}

const remake = (document: Document, info: Record<string, unknown>) =>
  new Document({ type: "document", ...(document.path ? { path: document.path } : {}), info: new Info(info as Info) })

/**
 * A project document without its runtime-guarded settings (util/src/kete/folder-trust.ts). Works on
 * the normalized `info`, so v1 keys (`provider`, `plugin`, `permission`, `tools`, `agent`, `mode`,
 * legacy MCP servers) are covered. Returns the document unchanged when nothing is guarded; `held` is
 * what was removed, in the normalized shape `describe` reads, and `rules` the held permission rules.
 */
export function strip(document: Document, machineDeny: ReadonlyArray<Rule>) {
  const info = document.info
  const next: Record<string, unknown> = { ...info }
  const removed: string[] = []
  const held: Record<string, unknown> = {}
  const rules: Array<{ rule: Rule; where: string }> = []
  const take = (key: string, value: unknown) => {
    delete next[key]
    removed.push(key)
    held[key] = value
  }
  for (const key of ["providers", "mcp", "plugins", "enterprise", "shell", "worktree"] as const)
    if (info[key] !== undefined) take(key, info[key])
  if (info.share !== undefined && info.share !== "disabled") take("share", info.share)
  if (info.formatter !== undefined && info.formatter !== false) take("formatter", info.formatter)
  if (info.kete) {
    const kete: Record<string, unknown> = { ...info.kete }
    const guarded = KeteFolderTrustRules.KETE_GUARDED.filter((key) => kete[key] !== undefined)
    if (guarded.length > 0) {
      held.kete = Object.fromEntries(guarded.map((key) => [key, kete[key]]))
      for (const key of guarded) delete kete[key]
      removed.push(...guarded.map((key) => `kete.${key}`))
      if (Object.values(kete).some((value) => value !== undefined)) next.kete = new ConfigKete.Info(kete as ConfigKete.Info)
      else delete next.kete
    }
  }
  if (info.skills) {
    const remote = info.skills.filter(KeteFolderTrustRules.remoteSkill)
    if (remote.length > 0) {
      const kept = info.skills.filter((item) => !KeteFolderTrustRules.remoteSkill(item))
      if (kept.length > 0) next.skills = kept
      else delete next.skills
      removed.push("skills")
      held.skills = remote
    }
  }
  if (info.references) {
    const git = Object.entries(info.references).filter(([, entry]) => KeteFolderTrustRules.gitReference(entry))
    if (git.length > 0) {
      const kept = Object.fromEntries(Object.entries(info.references).filter(([, entry]) => !KeteFolderTrustRules.gitReference(entry)))
      if (Object.keys(kept).length > 0) next.references = kept
      else delete next.references
      removed.push("references")
      held.references = Object.fromEntries(git)
    }
  }
  const policies = info.experimental?.policies
  if (policies) {
    const allows = policies.filter((policy) => policy.effect !== "deny")
    if (allows.length > 0) {
      const kept = policies.filter((policy) => policy.effect === "deny")
      const { policies: _policies, ...rest } = info.experimental!
      next.experimental = new ConfigExperimental.Info(kept.length > 0 ? { ...rest, policies: kept } : rest)
      removed.push("experimental.policies")
      held.experimental = { policies: allows }
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
  if (removed.length === 0 && rules.length === 0) return { document, removed, held, rules }
  return { document: remake(document, next), removed, held, rules }
}

/** Agent documents with every loosening rule removed (`agentDocuments`, and ConfigAgentPlugin when
 * there is no folder-trust service: then `machineDeny` is unknown and every allow and ask goes). */
export function stripAgentDocuments(documents: ReadonlyArray<Document>, machineDeny: ReadonlyArray<Rule> = DENY_ALL): Document[] {
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
    return remake(document, { ...document.info, agents })
  })
}

/** The machine-level `kete` object: the last non-project document that sets one (Config.latest). */
export function machineKete(documents: ReadonlyArray<Document>): ConfigKete.Info | undefined {
  return documents.findLast((document) => document.info.kete !== undefined)?.info.kete
}

/** A project document whose `kete` object can't mask the machine-level one's safety settings
 * (util/src/kete/folder-trust.ts `KETE_MACHINE`; `offline` stays on when the machine level turns it on). */
export function shield(document: Document, machine: ConfigKete.Info | undefined): Document {
  const kete = document.info.kete
  if (!kete || !machine) return document
  const next: Record<string, unknown> = { ...kete }
  let changed = false
  if (machine.offline === true && kete.offline !== true) {
    next.offline = true
    changed = true
  }
  for (const key of KeteFolderTrustRules.KETE_MACHINE)
    if (kete[key] === undefined && machine[key] !== undefined) {
      next[key] = machine[key]
      changed = true
    }
  if (!changed) return document
  return remake(document, { ...document.info, kete: new ConfigKete.Info(next as ConfigKete.Info) })
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
      let machineDeny: ReadonlyArray<Rule> = DENY_ALL
      let rootKey: string | undefined

      const looksLikeProject = (directory: string) =>
        path.basename(directory) === Brand.projectDirectory && path.resolve(directory) !== path.resolve(global.config)
      const isProjectDirectory = (directory: string) =>
        status.kind === "pending" ? looksLikeProject(directory) : projectDirectories.has(directory)

      const trust = Effect.fn("KeteFolderTrust.trust")(function* (
        key: string,
        fingerprint: string,
        held: ReadonlyArray<string>,
        ungated: () => Effect.Effect<ReadonlyArray<Entry>>,
      ) {
        yield* Effect.promise(() => store.trust(key, fingerprint, held))
        // One question, not two: the folder's current project hooks are trusted with it (as they will
        // load once trusted: substituted).
        yield* Effect.gen(function* () {
          const entries = yield* ungated()
          yield* Effect.promise(async () => {
            const repositoryKey = await KeteHooksSettings.repositoryKeyOf(location)
            const hooks = await KeteHooksSettings.projectHooksTrust(entries, {
              globalConfig: global.config,
              repositoryKey,
              cwd: location.directory,
            })
            if (hooks.kind === "ok") await hooksTrust.trust(repositoryKey, hooks.fingerprint, hooks.commands)
          })
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't trust the folder's project hooks", { cause })))
        yield* memory.publish(key)
      })

      const ask = (input: {
        key: string
        root: string
        fingerprint?: string
        refusal?: string
        items: ReadonlyArray<string>
        ungated: () => Effect.Effect<ReadonlyArray<Entry>>
      }) => {
        const question = `${input.key}\u0000${input.fingerprint ?? input.refusal ?? ""}`
        if (memory.declined.has(question) || memory.pending.has(question)) return Effect.void
        memory.pending.add(question)
        const form = { root: input.root, items: input.items, refusal: input.refusal }
        return forms.ask(KeteFolderTrustForm.create(form)).pipe(
          Effect.flatMap((state) =>
            KeteFolderTrustForm.decision(state) === "trust" &&
            input.fingerprint !== undefined &&
            input.refusal === undefined &&
            KeteFolderTrustForm.trustable(form)
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
          root: KeteFolderTrustRules.safe(root),
          held: items.slice(0, 20),
          more: Math.max(0, items.length - 20),
        })
      }

      /** Deny rules in the machine-level agent markdown files (global `.config/kete/agent(s)/`). */
      const machineAgentDenies = (directories: ReadonlyArray<string>) =>
        Effect.promise(async () => {
          const rules: Rule[] = []
          for (const directory of directories)
            for (const file of await KeteFolderTrustRules.agentFiles(directory, fs)) {
              const read = await KeteFolderTrustRules.readBounded(file, fs)
              if (read.kind === "ok") rules.push(...agentFileRules(read.text).filter((rule) => rule.effect === "deny"))
            }
          return rules
        })

      type Decision = { readonly substitute: boolean; readonly entries: ReadonlyArray<Entry> }

      const evaluate = Effect.fn("KeteFolderTrust.evaluate")(function* (
        load: Load,
        raw: ReadonlyArray<Entry>,
        project: Project,
        texts: ReadonlyMap<string, string>,
      ) {
        const isProjectDocument = (entry: Entry): entry is Document =>
          entry.type === "document" && entry.path !== undefined && project.documents.has(entry.path)
        const machineDocuments = raw.filter((entry): entry is Document => entry.type === "document" && !isProjectDocument(entry))
        const machineDirectories = raw.flatMap((entry) =>
          entry.type === "directory" && !project.directories.has(entry.path) ? [entry.path] : [],
        )
        machineDeny = machineDenies(machineDocuments, yield* machineAgentDenies(machineDirectories))

        const root = yield* Effect.promise(() => KeteFolderTrustRules.trustRoot(location.directory, fs))
        const top = root.kind === "ok" ? root.top : location.directory
        const shownPath = (file: string) => KeteFolderTrustRules.display(file, top)

        const items: string[] = []
        const documents: KeteFolderTrustRules.DocumentInput[] = []
        let unparsed: string | undefined
        const stripped = new Map<Entry, Entry>()
        for (const file of project.documents) {
          const text = texts.get(file)
          if (text === undefined) continue
          const tokens = KeteFolderTrustRules.substitutionTokens(text)
          const parsed = parseRaw(text)
          if (!parsed.ok) {
            documents.push({ path: file, document: undefined, text, unparsed: true })
            // A document that parses neither raw nor substituted never loads; one that only parses
            // substituted can't be checked, so the folder can't be trusted.
            if (tokens.env.length > 0 || tokens.files.length > 0) {
              unparsed ??= KeteFolderTrustRules.unparsedReason(file, top)
              items.push(`${KeteFolderTrustRules.shown(shownPath(file))} (it can't be read before substitution)`)
            }
            continue
          }
          documents.push({ path: file, document: parsed.value, text })
          items.push(...KeteFolderTrustRules.describeTokens(tokens, shownPath(file)))
          const entry = raw.find((item) => isProjectDocument(item) && item.path === file)
          if (!entry || entry.type !== "document") continue
          const result = strip(entry, machineDeny)
          if (result.removed.length === 0 && result.rules.length === 0) continue
          stripped.set(entry, result.document)
          items.push(...KeteFolderTrustRules.describe(result.held))
          items.push(...result.rules.map(({ rule, where }) => KeteFolderTrustRules.describeRule(rule, where)))
        }
        const plugins: string[] = []
        const agents: string[] = []
        for (const directory of project.directories) {
          plugins.push(...(yield* Effect.promise(() => KeteFolderTrustRules.pluginDirectories(directory, fs))))
          agents.push(...(yield* Effect.promise(() => KeteFolderTrustRules.agentFiles(directory, fs))))
        }
        items.push(...plugins.map((directory) => `plugin code in ${KeteFolderTrustRules.shown(shownPath(directory))}`))
        for (const file of agents) {
          const read = yield* Effect.promise(() => KeteFolderTrustRules.readBounded(file, fs))
          const where = `agent file ${JSON.stringify(shownPath(file))}`
          if (read.kind === "large") items.push(`${KeteFolderTrustRules.safe(where)} (too large to check)`)
          if (read.kind !== "ok") continue
          const held = KeteFolderTrustRules.loosening(agentFileRules(read.text), machineDeny, Wildcard.match).held
          items.push(...held.map((rule) => KeteFolderTrustRules.describeRule(rule, where)))
        }
        const untrustedEntries = raw.map((entry) => stripped.get(entry) ?? entry)

        if (items.length === 0) {
          status = { kind: "clear" }
          // Nothing to substitute: no project document has a token.
          return { substitute: false, entries: raw } satisfies Decision
        }
        if (KeteFolderTrustRules.runTrusted(env, ppid)) {
          status = { kind: "trusted", reason: "run" }
          return { substitute: true, entries: raw } satisfies Decision
        }
        const ungated = () => load(true)
        if (root.kind !== "ok") {
          status = { kind: "untrusted", held: items, refusal: root.reason }
          rootKey = undefined
          yield* warn(location.directory, undefined, location.directory, items)
          yield* ask({ key: location.directory, root: location.directory, refusal: root.reason, items, ungated })
          return { substitute: false, entries: untrustedEntries } satisfies Decision
        }
        const key = KeteFolderTrustRules.storeKey(root.root)
        rootKey = key
        const home = yield* Effect.promise(() => fs.realpath(global.home).catch(() => global.home))
        const fingerprint = yield* Effect.promise(() => KeteFolderTrustRules.fingerprint({ top, documents, plugins, agents }, fs))
        const refusal =
          KeteFolderTrustRules.neverTrusted(key, home) ??
          unparsed ??
          (fingerprint.kind === "unavailable" ? fingerprint.reason : undefined)
        const value = fingerprint.kind === "ok" ? fingerprint.value : undefined
        if (refusal === undefined && value !== undefined && (yield* Effect.promise(() => store.trusted(key, value)))) {
          status = { kind: "trusted", reason: "store", root: root.root }
          return { substitute: true, entries: raw } satisfies Decision
        }
        status = { kind: "untrusted", root: root.root, held: items, ...(refusal ? { refusal } : {}) }
        yield* warn(key, value, root.root, items)
        yield* ask({ key, root: root.root, fingerprint: value, refusal, items, ungated })
        return { substitute: false, entries: untrustedEntries } satisfies Decision
      })

      const gate = Effect.fn("KeteFolderTrust.gate")(function* (load: Load, project: Project, texts: ReadonlyMap<string, string>) {
        projectDirectories = new Set(project.directories)
        const raw = yield* load(false)
        const isProjectDocument = (entry: Entry): entry is Document =>
          entry.type === "document" && entry.path !== undefined && project.documents.has(entry.path)
        // Job mode loads no project config; if some did load, it is checked like any other folder.
        if (KeteJobMode.enabled(env) && project.directories.size === 0 && !raw.some(isProjectDocument)) {
          status = { kind: "trusted", reason: "job" }
          return [...raw]
        }
        const decision = yield* evaluate(load, raw, project, texts).pipe(
          // Fail closed: an error while checking drops the project documents whole.
          Effect.catchCause((cause) =>
            Effect.logWarning("couldn't check folder trust; holding back the project configuration", { cause }).pipe(
              Effect.andThen(
                Effect.sync((): Decision => {
                  status = { kind: "untrusted", held: ["the project configuration (trust couldn't be checked)"] }
                  machineDeny = DENY_ALL
                  return { substitute: false, entries: raw.filter((entry) => !isProjectDocument(entry)) }
                }),
              ),
            ),
          ),
        )
        const entries = decision.substitute ? yield* load(true) : decision.entries
        const machine = machineKete(entries.filter((entry): entry is Document => entry.type === "document" && !isProjectDocument(entry)))
        return entries.map((entry) => (isProjectDocument(entry) ? shield(entry, machine) : entry))
      })

      return Service.of({
        gate,
        pluginsAllowed: (directory) =>
          Effect.sync(() => status.kind === "trusted" || !isProjectDirectory(directory)),
        agentDocuments: (directory, documents) =>
          Effect.sync(() => {
            if (status.kind === "trusted" || !isProjectDirectory(directory)) return [...documents]
            try {
              return stripAgentDocuments(documents, machineDeny)
            } catch {
              // Fail closed: every allow goes.
              return stripAgentDocuments(documents, DENY_ALL)
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
