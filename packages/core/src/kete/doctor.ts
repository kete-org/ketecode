// The `kete.doctor` RPC (schema/src/kete/doctor.ts) for `kete doctor` and `/doctor`. It checks each
// config file the last load read the way the loader does (config.ts `parseInfo`: JSONC parse,
// `ConfigNormalize`, then the `Info` schema), because the loader drops a file that fails whole and
// only logs it, so a typo otherwise looks like a setting that does nothing. Read-only: it reads the
// text the loader already read and changes nothing.

export * as KeteDoctor from "./doctor.js"

import path from "path"
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser"
import { define } from "@opencode/plugin/effect/plugin"
import { Info } from "@opencode/schema/config"
import { KeteDoctorRpc } from "@opencode/schema/kete/doctor"
import { Global } from "@opencode/util/global"
import { Effect, Option, Schema } from "effect"
import { Config } from "../config.js"
import { ConfigNormalize } from "../config/normalize.js"
import { KeteFolderTrust } from "./folder-trust.js"

const decodeInfo = Schema.decodeUnknownOption(Info, { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" })
const substitution = /\{(env|file):[^}]*\}/

function clip(text: string) {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
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

/** One file's state, as the loader would decide it. */
export function checkText(text: string): { readonly state: KeteDoctorRpc.FileState; readonly messages: string[] } {
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
  const messages = result.diagnostics.map((diagnostic) => clip(`${where(diagnostic)}${diagnostic.message}`))
  if (result.type === "rejected") return { state: "rejected", messages: messages.slice(0, KeteDoctorRpc.MAX_MESSAGES) }
  if (Option.isNone(decodeInfo(result.encoded))) {
    // `{env:…}`/`{file:…}` are substituted before the schema check, so a value like "{env:PORT}" where
    // a number belongs is fine at load time: say it couldn't be checked rather than call it broken.
    if (substitution.test(text))
      return {
        state: "warnings",
        messages: [...messages, "couldn't fully check: it uses {env:…} or {file:…} substitution"].slice(0, KeteDoctorRpc.MAX_MESSAGES),
      }
    return {
      state: "rejected",
      messages: [...messages, "a setting has the wrong type or value (the schema check failed)"].slice(0, KeteDoctorRpc.MAX_MESSAGES),
    }
  }
  return { state: messages.length > 0 ? "warnings" : "ok", messages: messages.slice(0, KeteDoctorRpc.MAX_MESSAGES) }
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

    const check = () =>
      // The config is loaded (and so the file list and trust decided) before they're read.
      config.entries().pipe(
        Effect.andThen(Effect.all([trust.configFiles(), trust.status()])),
        Effect.map(([files, status]): KeteDoctorRpc.Report => ({
          files: files.map((file) => ({
            path: file.path,
            scope: file.project ? "project" : inside(file.path, global.config) ? "global" : "explicit",
            ...checkText(file.text),
          })),
          trust: trustOf(status),
        })),
      )

    yield* ctx.rpc.register(KeteDoctorRpc.Definition, { check }).pipe(Effect.orDie)
  }),
})
