// `kete completion`: bash, zsh and fish are Effect's own `--completions` scripts (compared end to end
// through the CLI), PowerShell is Kete's generator over the real command spec, and no shell prints
// the install lines.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Commands } from "../../src/commands/commands"
import type { Spec } from "../../src/framework/spec"
import { KeteCompletion } from "../../src/kete/completion"
import { KeteCompletionTree } from "../../src/kete/completion-tree"

let root: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kete-completion-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

// A clean environment rooted in `root`: no inherited KETE_* or OPENCODE_* values.
function environment() {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of Object.keys(env)) if (/^(KETE|OPENCODE)_/i.test(name)) delete env[name]
  return {
    ...env,
    HOME: root,
    USERPROFILE: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
}

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../../src/index.ts"), ...args], {
    cwd: path.join(import.meta.dir, "../.."),
    env: environment(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

const powershell = () =>
  Effect.runPromise(KeteCompletionTree.describe(Commands)).then((tree) => KeteCompletion.powershell(Commands.name, tree))

// The PowerShell entry for one command path: from `$tree['<path>'] = @{` to its closing brace.
function entry(script: string, key: string) {
  const start = script.indexOf(`  $tree['${key}'] = @{\n`)
  if (start < 0) return undefined
  return script.slice(start, script.indexOf("\n  }\n", start))
}

// Every listed command path in the spec, aliases included.
function paths(node: Spec.Any, prefix: ReadonlyArray<string> = []): ReadonlyArray<string> {
  return Object.values(node.commands).flatMap((child) => {
    if (child.spec.unlisted) return []
    const spellings = [child.name, ...(child.spec.alias ? [child.spec.alias] : []), ...child.aliases.map((alias) => alias.name)]
    return spellings.flatMap((spelling) => {
      const own = [...prefix, spelling]
      return [own.join(" "), ...paths(child, own)]
    })
  })
}

describe("kete completion", () => {
  for (const shell of ["bash", "zsh", "fish"] as const) {
    test(`${shell}: the same script as \`kete --completions ${shell}\``, async () => {
      const [completion, flag] = await Promise.all([cli(["completion", shell]), cli(["--completions", shell])])
      expect(completion.exitCode).toBe(0)
      expect(flag.exitCode).toBe(0)
      expect(completion.stdout.length).toBeGreaterThan(1000)
      expect(completion.stdout).toBe(flag.stdout)
      expect(completion.stdout).toContain("completion")
    })
  }

  test("no shell: install lines for all four shells, exit 0", async () => {
    const result = await cli(["completion"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`eval "$(kete completion bash)"`)
    expect(result.stdout).toContain(`eval "$(kete completion zsh)"`)
    expect(result.stdout).toContain("kete completion fish > ~/.config/fish/completions/kete.fish")
    expect(result.stdout).toContain("kete completion powershell | Out-String | Invoke-Expression")
    for (const where of ["~/.bashrc", "~/.zshrc", "$PROFILE"]) expect(result.stdout).toContain(where)
  })

  test("an unknown shell exits non-zero and names the supported shells", async () => {
    const result = await cli(["completion", "tcsh"])
    expect(result.exitCode).not.toBe(0)
    const output = result.stdout + result.stderr
    for (const shell of KeteCompletion.shells) expect(output).toContain(`"${shell}"`)
  })

  test("powershell through the CLI: registers a native completer for kete", async () => {
    const result = await cli(["completion", "powershell"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Register-ArgumentCompleter -Native -CommandName @('kete', 'kete.exe') -ScriptBlock {")
  })
})

describe("kete completion powershell", () => {
  test("top-level commands, nested subcommands and run's flags", async () => {
    const script = await powershell()
    const top = entry(script, "")
    expect(top).toBeDefined()
    for (const name of ["run", "mcp", "session", "completion", "job", "upgrade", "update"])
      expect(top).toContain(`,@('${name}', `)
    const mcp = entry(script, "mcp")
    for (const name of ["add", "list", "presets"]) expect(mcp).toContain(`,@('${name}', `)
    expect(entry(script, "mcp add")).toBeDefined()
    const run = entry(script, "run")
    for (const flag of ["--model", "-m", "--agent", "--format", "--file", "-f", "--continue", "-c", "--help", "--offline"])
      expect(run).toContain(`,@('${flag}', `)
    // Value-taking flags are skipped when finding the command; booleans aren't.
    const values = run?.split("\n").find((line) => line.trim().startsWith("values = "))
    expect(values).toContain("'--model'")
    expect(values).toContain("'-m'")
    expect(values).not.toContain("'--continue'")
    // Hidden flags stay hidden, as in --help.
    expect(run).not.toContain("'--yolo'")
  })

  test("every listed command in the spec has an entry", async () => {
    const script = await powershell()
    const expected = paths(Commands)
    expect(expected).toContain("mcp add")
    expect(expected).toContain("job run")
    for (const key of expected) expect(entry(script, key), key).toBeDefined()
  })

  test("quotes in descriptions are escaped for single-quoted strings", () => {
    const script = KeteCompletion.powershell("kete", {
      name: "kete",
      aliases: [],
      description: "",
      flags: [{ names: ["--it's"], description: "it’s 'quoted'", value: false }],
      commands: [{ name: "one", aliases: ["uno"], description: "", flags: [], commands: [] }],
    })
    expect(script).toContain("@('--it''s', 'it’’s ''quoted''')")
    // An empty description falls back to the name (tooltips must not be empty).
    expect(script).toContain(",@('one', 'one')")
    expect(script).toContain(",@('uno', 'uno')")
    expect(script).toContain("  $tree['uno'] = @{")
  })
})
