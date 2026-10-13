// The `kete.doctor` RPC (schema/src/kete/doctor.ts) for `kete doctor` and `/doctor`. It checks each
// config file the last load read the way the loader does (config.ts `loadFile` + `parseInfo`: `{env:…}`
// and `{file:…}` substituted where the loader substitutes them, then JSONC parse, `ConfigNormalize`,
// then the `Info` schema), because the loader drops a file that fails whole and only logs it, so a typo
// otherwise looks like a setting that does nothing. A `.kete/` config file that exists but couldn't be
// read is reported too. Read-only: it changes nothing.
//
// Not covered: config from OPENCODE_CONFIG_CONTENT and from well-known (organization) sources, which
// have no file. A call that races a config reload may pair the new file list with the trust decision
// being made; running it again settles it.

export * as KeteDoctor from "./doctor.js"

import path from "path"
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser"
import { define } from "@opencode/plugin/effect/plugin"
import { Info } from "@opencode/schema/config"
import { KeteDoctorRpc } from "@opencode/schema/kete/doctor"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { KeteDoctor as KeteDoctorChecks } from "@opencode/util/kete/doctor"
import { Effect, Option, Schema } from "effect"
import { Config } from "../config.js"
import { ConfigNormalize } from "../config/normalize.js"
import { ConfigVariable } from "../config/variable.js"
import { KeteFolderTrust } from "./folder-trust.js"

const decodeInfo = Schema.decodeUnknownOption(Info, { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" })

/** One line, no control, bidi or line-separator characters, at most `MAX_MESSAGE` characters. */
export function clip(text: string) {
  const line = KeteDoctorChecks.safe(text)
  return line.length > KeteDoctorRpc.MAX_MESSAGE ? `${line.slice(0, KeteDoctorRpc.MAX_MESSAGE - 1)}…` : line
}

function lineOf(text: string, offset: number) {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index++) if (text.charCodeAt(index) === 10) line++
  return line
}

function where(diagnostic: ConfigNormalize.Diagnostic) {
  const parts = diagnostic.path.filter((part) => part !== "$")
  return parts.length > 0 ? `${parts.join(".")}: ` : ""
}

type Checked = { readonly state: KeteDoctorRpc.FileState; readonly messages: string[] }

/** One file's state, as `parseInfo` would decide it for this (already substituted) text. */
export function checkText(text: string): Checked {
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0)
    return {
      state: "invalid",
      messages: errors
        .slice(0, KeteDoctorRpc.MAX_MESSAGES)
        .map((error) => clip(`line ${lineOf(text, error.offset)}: ${printParseErrorCode(error.error)}`)),
    }
  const result = ConfigNormalize.normalize(input)
  const messages = result.diagnostics.slice(0, KeteDoctorRpc.MAX_MESSAGES).map((diagnostic) => clip(`${where(diagnostic)}${diagnostic.message}`))
  if (result.type === "rejected") return { state: "rejected", messages }
  if (Option.isNone(decodeInfo(result.encoded)))
    return {
      state: "rejected",
      messages: [...messages, "a setting has the wrong type or value (the schema check failed)"].slice(0, KeteDoctorRpc.MAX_MESSAGES),
    }
  return { state: messages.length > 0 ? "warnings" : "ok", messages }
}

function inside(file: string, directory: string) {
  const relative = path.relative(directory, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function trustOf(status: KeteFolderTrust.Status): KeteDoctorRpc.Trust {
  switch (status.kind) {
    case "pending":
    case "clear":
      return { state: status.kind, held: [], heldCount: 0 }
    case "trusted":
      return { state: "trusted", reason: status.reason, held: [], heldCount: 0 }
    case "untrusted":
      return {
        state: "untrusted",
        held: status.held.slice(0, KeteDoctorRpc.MAX_HELD).map(clip),
        heldCount: status.held.length,
        ...(status.refusal ? { refusal: clip(status.refusal) } : {}),
      }
  }
}

export const Plugin = define({
  id: "kete.doctor",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const trust = yield* KeteFolderTrust.Service
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service

    // The loader substitutes the machine's own files always, and project files only once the folder is
    // trusted (untrusted ones load raw); a failed `{file:…}` makes the load fail.
    const checkFile = (file: { readonly path: string; readonly text: string }, substitute: boolean) =>
      substitute
        ? ConfigVariable.substitute({ type: "path", path: file.path, text: file.text }).pipe(
            Effect.provideService(FSUtil.Service, fs),
            Effect.map(checkText),
            Effect.catch((error) =>
              Effect.succeed<Checked>({ state: "rejected", messages: [clip(`substitution failed: ${error.message ?? "a {file:…} reference couldn't be read"}`)] }),
            ),
          )
        : Effect.succeed(checkText(file.text))

    const check = () =>
      // The config is loaded (and so the file list and trust decided) before they're read.
      config.entries().pipe(
        Effect.andThen(Effect.all([trust.configFiles(), trust.status()])),
        Effect.flatMap(([files, status]) =>
          Effect.gen(function* () {
            // Job mode loads project files raw even though it counts as trusted.
            const trusted = status.kind === "trusted" && status.reason !== "job"
            const read = yield* Effect.forEach(files.read, (file) =>
              checkFile(file, !file.project || trusted).pipe(
                Effect.map(
                  (checked): KeteDoctorRpc.File => ({
                    path: clip(file.path),
                    scope: file.project ? "project" : inside(file.path, global.config) ? "global" : "explicit",
                    ...checked,
                  }),
                ),
              ),
            )
            // A `.kete/` config file that exists but the loader couldn't read (permissions) is skipped by it
            // silently. (An unreadable global or top-level project file fails discovery, so the runtime
            // doesn't start and the doctor reports that instead.)
            const known = new Set(files.read.map((file) => file.path))
            const unreadable = yield* Effect.filter(
              files.projectCandidates.filter((file) => !known.has(file)).map((file) => ({ path: file, scope: "project" as const })),
              (candidate) => fs.isFile(candidate.path),
            )
            return {
              files: [
                ...read,
                ...unreadable.map(
                  (candidate): KeteDoctorRpc.File => ({
                    path: clip(candidate.path),
                    scope: candidate.scope,
                    state: "unreadable",
                    messages: ["the runtime didn't load it: it can't be read (check its permissions), or it was created after the last load"],
                  }),
                ),
              ],
              trust: trustOf(status),
            } satisfies KeteDoctorRpc.Report
          }),
        ),
      )

    yield* ctx.rpc.register(KeteDoctorRpc.Definition, { check }).pipe(Effect.orDie)
  }),
})
