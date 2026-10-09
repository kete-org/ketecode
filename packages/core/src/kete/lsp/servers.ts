// Which language servers Kete Code may start, from the built-in catalogue and the upstream `lsp`
// configuration key (`schema/src/config/lsp.ts`, which OpenCode v2 keeps but no longer reads).
//
// Built-in servers: TypeScript/JavaScript, Python, Go and Rust, each used only when its program is
// already on PATH — Kete Code never downloads a language server. Their settings turn off features
// that run the project's code or reach the network on their own: rust-analyzer's build scripts and
// proc macros, TypeScript's automatic type acquisition, Go toolchain and module downloads, cargo's
// network.
//
// Configuration (`lsp`), read per document like the sandbox settings (sandbox/settings.ts):
// - `lsp: false` anywhere turns every server off; `lsp: { <id>: { disabled: true } }` one server.
// - A server's `command`, `env` and `initialization`, and new servers, count only from the global
//   config (`~/.config/kete/`): a repository's config names programs that would start without asking
//   on the first edit, so it may only switch servers off (listed in `ignored`).

export * as KeteLspServers from "./servers.js"

import path from "path"
import type { ConfigLSP } from "@opencode/schema/config/lsp"
import type { Schema } from "effect"

export interface Server {
  readonly id: string
  /** Program and arguments; the program is looked up on PATH. */
  readonly command: ReadonlyArray<string>
  /** Other programs to try, in order, when `command[0]` isn't on PATH (built-ins only). */
  readonly alternatives?: ReadonlyArray<ReadonlyArray<string>>
  readonly extensions: ReadonlyArray<string>
  /** Files or directories that mark a project root, nearest first. */
  readonly roots: ReadonlyArray<string>
  readonly env?: Readonly<Record<string, string>>
  readonly initialization?: Readonly<Record<string, unknown>>
}

export const builtins: ReadonlyArray<Server> = [
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    roots: ["tsconfig.json", "jsconfig.json", "package.json"],
    initialization: { disableAutomaticTypingAcquisition: true },
  },
  {
    id: "python",
    command: ["pyright-langserver", "--stdio"],
    alternatives: [["basedpyright-langserver", "--stdio"]],
    extensions: [".py", ".pyi"],
    roots: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt"],
  },
  {
    id: "go",
    command: ["gopls"],
    extensions: [".go"],
    roots: ["go.work", "go.mod"],
    env: { GOTOOLCHAIN: "local", GOPROXY: "off" },
  },
  {
    id: "rust",
    command: ["rust-analyzer"],
    extensions: [".rs"],
    roots: ["Cargo.toml"],
    env: { CARGO_NET_OFFLINE: "true" },
    initialization: {
      cargo: { buildScripts: { enable: false } },
      procMacro: { enable: false },
      checkOnSave: false,
    },
  },
]

export interface Document {
  /** The file the document came from; documents without one count as project configuration. */
  readonly path?: string
  readonly lsp?: Schema.Schema.Type<typeof ConfigLSP.Info>
}

export interface Settings {
  readonly enabled: boolean
  readonly servers: ReadonlyArray<Server>
  /** Settings a project's configuration gave that were ignored (it can only switch servers off). */
  readonly ignored: ReadonlyArray<string>
}

function inside(file: string, directory: string) {
  const relative = path.relative(directory, file)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const extension = (value: string) => (value.startsWith(".") ? value : `.${value}`).toLowerCase()

/** Combines the built-ins with the configuration documents (lowest to highest priority). */
export function resolve(input: { readonly documents: ReadonlyArray<Document>; readonly globalDirectory: string }): Settings {
  const servers = new Map<string, Server>(builtins.map((server) => [server.id, server]))
  const disabled = new Set<string>()
  const ignored: string[] = []
  let enabled = true

  for (const doc of input.documents) {
    const lsp = doc.lsp
    if (lsp === undefined) continue
    const user = doc.path !== undefined && inside(doc.path, input.globalDirectory)
    if (lsp === false) {
      enabled = false
      continue
    }
    if (lsp === true) {
      if (user) enabled = true
      continue
    }
    for (const [id, entry] of Object.entries(lsp)) {
      if ("disabled" in entry && entry.disabled === true) {
        disabled.add(id)
        continue
      }
      if (!("command" in entry)) continue
      if (!user) {
        ignored.push(`lsp.${id}`)
        continue
      }
      if (entry.disabled === false) disabled.delete(id)
      const base = servers.get(id)
      const extensions = entry.extensions?.map(extension) ?? base?.extensions
      if (!extensions?.length || entry.command.length === 0) {
        ignored.push(`lsp.${id} (needs a command and extensions)`)
        continue
      }
      servers.set(id, {
        id,
        command: entry.command,
        extensions,
        roots: base?.roots ?? [],
        env: { ...base?.env, ...entry.env },
        initialization: entry.initialization ?? base?.initialization,
      })
    }
  }

  return {
    enabled,
    servers: enabled ? [...servers.values()].filter((server) => !disabled.has(server.id)) : [],
    ignored,
  }
}

/** The servers for a file, by its extension. */
export function forFile(settings: Settings, file: string) {
  const ext = path.extname(file).toLowerCase()
  if (ext === "") return []
  return settings.servers.filter((server) => server.extensions.includes(ext))
}

/**
 * The directory a server runs in for a file: the nearest directory between the file and the
 * workspace that holds one of the server's root markers, else the workspace.
 */
export async function root(
  server: Pick<Server, "roots">,
  file: string,
  workspace: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!inside(file, workspace)) return workspace
  let directory = path.dirname(file)
  while (inside(directory, workspace)) {
    for (const marker of server.roots) if (await exists(path.join(directory, marker))) return directory
    if (directory === workspace) break
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return workspace
}

/** The language id `textDocument/didOpen` carries. */
export function languageID(file: string): string {
  const ext = path.extname(file).toLowerCase()
  const ids: Record<string, string> = {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python",
    ".pyi": "python",
    ".go": "go",
    ".rs": "rust",
  }
  return ids[ext] ?? "plaintext"
}
