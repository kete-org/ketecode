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
// Trusted project documents are substituted from the `{file:…}` bytes the fingerprint hashed
// (`checkedFiles`) and must set exactly what their raw text showed (`substitute`), else the folder is
// refused. More marked seams ask this service: ConfigPluginSource skips `.kete/plugin(s)/` of an
// untrusted folder (`pluginsAllowed`) and a project's configured local plugins
// (`configuredPluginAllowed`), and ConfigAgentPlugin strips loosening rules from its project agent
// markdown files (`agentDocuments`; with no service it strips them itself, fail closed). For a folder
// trusted through the store these re-check the files against the digests taken with the trusted
// fingerprint (`bound`): a change since then doesn't load (and Config reloads, which asks again), so
// nothing runs on a stale decision while the debounced reload is pending or for a change the config
// watcher never sees (node_modules). The TUI asks through the `kete.folder.trust` RPC
// (folder-trust/rpc.ts) before it loads `.kete/plugins/`.
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

import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { parse, type ParseError } from "jsonc-parser"
import { Cause, Context, Effect, Layer, PubSub, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { ConfigKete } from "@opencode/schema/config/kete"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
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

/** What Config's loader returns: every entry, and each project file's substituted text. */
export interface Loaded {
  readonly entries: ReadonlyArray<Entry>
  readonly substituted: ReadonlyMap<string, string>
}

/** Config's loader: every entry, with the project documents parsed raw (`false`) or substituted from
 * the text the raw load read. With `files`, a `{file:…}` target is served from the text the
 * fingerprint hashed (any other target fails the load); without it (run trust) targets are read. */
export type Load = (substitute: false | { readonly files?: ReadonlyMap<string, string> }) => Effect.Effect<Loaded>

export type Status =
  | { readonly kind: "pending" }
  | { readonly kind: "clear" }
  | { readonly kind: "trusted"; readonly reason: "store" | "run" | "job"; readonly root?: string }
  | { readonly kind: "untrusted"; readonly root?: string; readonly held: ReadonlyArray<string>; readonly refusal?: string }

export interface Interface {
  /** Loads the entries (`load`) with guarded project settings removed and project documents left
   * unsubstituted unless the folder is trusted. `texts` holds the raw text `load(false)` read. */
  readonly gate: (load: Load, project: Project, texts: ReadonlyMap<string, string>) => Effect.Effect<Entry[]>
  /** Whether plugin code in this config directory may load: the folder is trusted and (store trust)
   * its plugin files are still the ones whose fingerprint was trusted. */
  readonly pluginsAllowed: (directory: string) => Effect.Effect<boolean>
  /** Whether a configured local plugin (an absolute target from a config document's `plugins`) may
   * load: always for one no project document configures; for a project's, the folder is trusted and
   * (store trust) the plugin's files are still the ones whose fingerprint was trusted. */
  readonly configuredPluginAllowed: (target: string) => Effect.Effect<boolean>
  /** For the `kete.folder.trust` RPC: each requested plugin directory that is one of this location's
   * project plugin directories and may load, with its digest now (`KeteFolderTrustRules.pluginDigest`). */
  readonly pluginDigests: (
    directories: ReadonlyArray<string>,
  ) => Effect.Effect<Array<{ readonly directory: string; readonly digest: string }>>
  /** Agent markdown documents from this config directory, with loosening rules removed unless trusted. */
  readonly agentDocuments: (directory: string, documents: ReadonlyArray<Document>) => Effect.Effect<Document[]>
  /** Emits when this location's trust root is trusted, or when plugin or agent files changed after
   * trust was decided (Config reloads). */
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

/**
 * The file system Config substitutes project documents with once folder trust allows it: a
 * `{file:…}` target is served from the text the fingerprint hashed (`files`, resolved path → text),
 * so what loads is what was checked, and any other target fails (ConfigVariable reports a bad file
 * reference, and the load fails closed).
 */
export function checkedFiles(fs: FSUtil.Interface, files: ReadonlyMap<string, string>): FSUtil.Interface {
  return {
    ...fs,
    readFileString: (file: string) => {
      const text = files.get(file)
      return text !== undefined
        ? Effect.succeed(text)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "KeteFolderTrust",
              method: "readFileString",
              description: "not read when the folder's trust was checked",
              pathOrDescriptor: file,
            }),
          )
    },
  }
}

/** The absolute local plugin targets a document's `plugins` configure, resolved exactly as
 * ConfigPluginSource's scan resolves them (config/plugin/source.ts). */
export function configuredTargets(document: Document): string[] {
  return (document.info.plugins ?? []).flatMap((spec) => {
    const target = typeof spec === "string" ? spec : spec.package
    if (target.startsWith("-")) return []
    const directory = document.path ? path.dirname(document.path) : undefined
    let resolved = target
    if (target.startsWith("file://"))
      try {
        resolved = fileURLToPath(target)
      } catch {
        return []
      }
    else if ((target.startsWith("./") || target.startsWith("../")) && directory) resolved = path.resolve(directory, target)
    return path.isAbsolute(resolved) ? [resolved] : []
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
      let machineDeny: ReadonlyArray<Rule> = DENY_ALL
      let rootKey: string | undefined
      // What a store-trusted folder's plugin and agent files were when its trust was decided (from the
      // fingerprint's own read): plugin code and agent rules load only while they still match, so a
      // change can't run on the old decision before the debounced reload re-checks (or one the config
      // watcher never sees, like a plugin's node_modules). "any" for run and job trust.
      let bound:
        | "any"
        | {
            readonly plugins: ReadonlyMap<string, string>
            readonly agents: ReadonlyMap<string, string>
            readonly configured: ReadonlyMap<string, string | null>
          } = "any"
      // Local plugin targets the gated project documents configure (resolved as ConfigPluginSource does).
      let projectTargets = new Set<string>()
      const stale = yield* PubSub.unbounded<void>()
      const invalidate = PubSub.publish(stale, undefined).pipe(Effect.asVoid)

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

      type Substituted =
        | { readonly kind: "ok"; readonly entries: ReadonlyArray<Entry> }
        | { readonly kind: "refused"; readonly reason: string }
        | { readonly kind: "failed"; readonly reason: string; readonly cause: Cause.Cause<never> }

      /**
       * Loads the project documents substituted from the bytes the fingerprint read, and checks each
       * against its raw text (`substitutionMismatch`): what was shown and fingerprinted must be what
       * loads. Any difference, or a failed load, is a refusal (fail closed).
       */
      const substitute = (
        load: Load,
        files: ReadonlyMap<string, string>,
        documents: ReadonlyArray<KeteFolderTrustRules.DocumentInput>,
        top: string,
      ) =>
        load({ files }).pipe(
          Effect.map((loaded): Substituted => {
            const home = os.homedir()
            for (const document of documents) {
              if (document.unparsed) continue
              const text = loaded.substituted.get(document.path)
              if (text === undefined) continue
              const parsed = parseRaw(text)
              // A document that doesn't parse once substituted never loads.
              if (!parsed.ok) continue
              const at = KeteFolderTrustRules.substitutionMismatch(document.document, parsed.value, (token) =>
                files.get(KeteFolderTrustRules.fileTarget(token, document.path, home)),
              )
              if (at !== undefined) return { kind: "refused", reason: KeteFolderTrustRules.mismatchReason(document.path, top, at) }
            }
            return { kind: "ok", entries: loaded.entries }
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("couldn't substitute the project configuration", { cause }).pipe(
              Effect.as<Substituted>({ kind: "failed", reason: "substituting {env:…}/{file:…} in the project config failed", cause }),
            ),
          ),
        )

      /** The entries; or (run trust) the load the gate runs outside the fail-closed catch, or (a trusted
       * folder whose substitution failed, e.g. a bad file reference) that failure, so the error surfaces
       * as it always has. */
      type Decision =
        | { readonly entries: ReadonlyArray<Entry> }
        | { readonly load: { readonly files?: ReadonlyMap<string, string> } }
        | { readonly fail: Cause.Cause<never> }

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
        const agentsByDirectory = new Map<string, string[]>()
        for (const directory of project.directories) {
          plugins.push(...(yield* Effect.promise(() => KeteFolderTrustRules.pluginDirectories(directory, fs))))
          const files = yield* Effect.promise(() => KeteFolderTrustRules.agentFiles(directory, fs))
          agentsByDirectory.set(directory, files)
          agents.push(...files)
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

        // `status` and `bound` change together, with no yield between, so a concurrent check never sees
        // a trusted status with another decision's binding.
        if (items.length === 0) {
          status = { kind: "clear" }
          bound = "any"
          // Nothing to substitute: no project document has a token.
          return { entries: raw } satisfies Decision
        }
        if (KeteFolderTrustRules.runTrusted(env, ppid)) {
          status = { kind: "trusted", reason: "run" }
          bound = "any"
          return { load: {} } satisfies Decision
        }
        if (root.kind !== "ok") {
          status = { kind: "untrusted", held: items, refusal: root.reason }
          rootKey = undefined
          yield* warn(location.directory, undefined, location.directory, items)
          yield* ask({ key: location.directory, root: location.directory, refusal: root.reason, items, ungated: () => Effect.succeed([]) })
          return { entries: untrustedEntries } satisfies Decision
        }
        const key = KeteFolderTrustRules.storeKey(root.root)
        rootKey = key
        const home = yield* Effect.promise(() => fs.realpath(global.home).catch(() => global.home))
        const fingerprint = yield* Effect.promise(() => KeteFolderTrustRules.fingerprint({ top, documents, plugins, agents }, fs))
        let refusal =
          KeteFolderTrustRules.neverTrusted(key, home) ??
          unparsed ??
          (fingerprint.kind === "unavailable" ? fingerprint.reason : undefined)
        // Checked before the question is asked, so a folder whose substitution changes what it sets is
        // never offered Trust.
        let substituted: ReadonlyArray<Entry> | undefined
        let failed: Cause.Cause<never> | undefined
        if (refusal === undefined && fingerprint.kind === "ok") {
          const result = yield* substitute(load, fingerprint.files, documents, top)
          if (result.kind === "ok") substituted = result.entries
          else {
            refusal = result.reason
            if (result.kind === "failed") failed = result.cause
          }
        }
        const value = fingerprint.kind === "ok" ? fingerprint.value : undefined
        if (
          (refusal === undefined || failed !== undefined) &&
          fingerprint.kind === "ok" &&
          (yield* Effect.promise(() => store.trusted(key, fingerprint.value)))
        ) {
          status = { kind: "trusted", reason: "store", root: root.root }
          bound = {
            plugins: fingerprint.plugins,
            agents: new Map(
              [...agentsByDirectory].map(([directory, files]) => [
                directory,
                KeteFolderTrustRules.agentDigestOf(directory, files, fingerprint.agents),
              ]),
            ),
            configured: fingerprint.configured,
          }
          if (failed !== undefined || substituted === undefined) return { fail: failed ?? Cause.die(new Error("no substituted configuration")) } satisfies Decision
          return { entries: substituted } satisfies Decision
        }
        status = { kind: "untrusted", root: root.root, held: items, ...(refusal ? { refusal } : {}) }
        const ungated = () => (substituted === undefined ? Effect.succeed([]) : Effect.succeed(substituted))
        yield* warn(key, value, root.root, items)
        yield* ask({ key, root: root.root, fingerprint: value, refusal, items, ungated })
        return { entries: untrustedEntries } satisfies Decision
      })

      const gate = Effect.fn("KeteFolderTrust.gate")(function* (load: Load, project: Project, texts: ReadonlyMap<string, string>) {
        projectDirectories = new Set(project.directories)
        const raw = (yield* load(false)).entries
        const isProjectDocument = (entry: Entry): entry is Document =>
          entry.type === "document" && entry.path !== undefined && project.documents.has(entry.path)
        // Job mode loads no project config; if some did load, it is checked like any other folder.
        if (KeteJobMode.enabled(env) && project.directories.size === 0 && !raw.some(isProjectDocument)) {
          status = { kind: "trusted", reason: "job" }
          bound = "any"
          return [...raw]
        }
        const decision: Decision = yield* evaluate(load, raw, project, texts).pipe(
          // Fail closed: an error while checking drops the project documents whole.
          Effect.catchCause((cause) =>
            Effect.logWarning("couldn't check folder trust; holding back the project configuration", { cause }).pipe(
              Effect.andThen(
                Effect.sync((): Decision => {
                  status = { kind: "untrusted", held: ["the project configuration (trust couldn't be checked)"] }
                  machineDeny = DENY_ALL
                  bound = "any"
                  return { entries: raw.filter((entry) => !isProjectDocument(entry)) }
                }),
              ),
            ),
          ),
        )
        if ("fail" in decision) return yield* Effect.failCause(decision.fail)
        const entries = "entries" in decision ? decision.entries : (yield* load(decision.load)).entries
        projectTargets = new Set(entries.filter(isProjectDocument).flatMap((document) => configuredTargets(document)))
        const machine = machineKete(entries.filter((entry): entry is Document => entry.type === "document" && !isProjectDocument(entry)))
        return entries.map((entry) => (isProjectDocument(entry) ? shield(entry, machine) : entry))
      })

      /** Whether a project plugin directory's files are still the trusted ones (always, for run/job trust). */
      const pluginCurrent = (directory: string) =>
        Effect.gen(function* () {
          const binding = bound
          if (binding === "any") return true
          const expected = binding.plugins.get(directory)
          const now = yield* Effect.promise(() => KeteFolderTrustRules.pluginDigest(directory, fs))
          if (expected !== undefined && now === expected) return true
          yield* invalidate
          return false
        })

      const configuredPluginAllowed = Effect.fn("KeteFolderTrust.configuredPluginAllowed")(function* (target: string) {
        if (!projectTargets.has(target)) return true
        if (status.kind !== "trusted") return false
        const binding = bound
        if (binding === "any") return true
        const expected = binding.configured.get(target)
        const now = yield* Effect.promise(() => KeteFolderTrustRules.targetDigest(target, fs))
        if (expected !== undefined && now !== undefined && now === expected) return true
        yield* invalidate
        return false
      }, Effect.catchCause(() => Effect.succeed(false)))

      const pluginsAllowed = Effect.fn("KeteFolderTrust.pluginsAllowed")(function* (directory: string) {
        if (!isProjectDirectory(directory)) return true
        if (status.kind !== "trusted") return false
        const directories = yield* Effect.promise(() => KeteFolderTrustRules.pluginDirectories(directory, fs))
        for (const item of directories) if (!(yield* pluginCurrent(item))) return false
        return true
      }, Effect.catchCause(() => Effect.succeed(false)))

      const pluginDigests = Effect.fn("KeteFolderTrust.pluginDigests")(function* (requested: ReadonlyArray<string>) {
        if (status.kind !== "trusted") return []
        const real = (file: string) => Effect.promise(() => fs.realpath(file).catch(() => undefined))
        const known: Array<[string, string]> = []
        for (const directory of projectDirectories) {
          const resolved = yield* real(directory)
          if (resolved !== undefined) known.push([resolved, directory])
        }
        const result: Array<{ directory: string; digest: string }> = []
        for (const directory of requested) {
          const name = path.basename(directory)
          if (!(KeteFolderTrustRules.PLUGIN_DIRECTORIES as ReadonlyArray<string>).includes(name)) continue
          const parent = yield* real(path.dirname(directory))
          const project = known.find(([resolved]) => resolved === parent)?.[1]
          if (project === undefined) continue
          const ours = path.join(project, name)
          if (!(yield* pluginCurrent(ours))) continue
          const digest = yield* Effect.promise(() => KeteFolderTrustRules.pluginDigest(ours, fs))
          if (digest !== undefined) result.push({ directory, digest })
        }
        return result
      }, Effect.catchCause(() => Effect.succeed([] as Array<{ directory: string; digest: string }>)))

      const agentDocuments = Effect.fn("KeteFolderTrust.agentDocuments")(
        function* (directory: string, documents: ReadonlyArray<Document>) {
          if (!isProjectDirectory(directory)) return [...documents]
          if (status.kind === "trusted") {
            const binding = bound
            if (binding === "any") return [...documents]
            const now = yield* Effect.promise(() => KeteFolderTrustRules.agentDigest(directory, fs))
            if (now !== undefined && now === binding.agents.get(directory)) return [...documents]
            // Changed since trust was decided: strip until the reload asks again.
            yield* invalidate
          }
          return stripAgentDocuments(documents, machineDeny)
        },
        // Fail closed: every allow goes.
        (effect, _directory, documents) => effect.pipe(Effect.catchCause(() => Effect.sync(() => stripAgentDocuments(documents, DENY_ALL)))),
      )

      return Service.of({
        gate,
        pluginsAllowed,
        configuredPluginAllowed,
        pluginDigests,
        agentDocuments,
        changes: () =>
          Stream.merge(
            memory.trusted().pipe(
              Stream.filter((key) => key === rootKey),
              Stream.map(() => undefined),
            ),
            Stream.fromPubSub(stale),
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
