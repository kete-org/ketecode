// `kete completion`: the pure parts. The shells, the install lines, and the PowerShell script, which
// Effect's generator (bash, zsh, fish; see ./completion-tree.ts) doesn't cover.

export const shells = ["bash", "zsh", "fish", "powershell"] as const
export type Shell = (typeof shells)[number]

/** A flag as the completer sees it: every spelling (`--model`, `-m`) and whether it takes a value. */
export interface Flag {
  readonly names: ReadonlyArray<string>
  readonly description: string
  readonly value: boolean
}

/** A command and its subcommands, from the CLI's command spec. */
export interface Tree {
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly description: string
  readonly flags: ReadonlyArray<Flag>
  readonly commands: ReadonlyArray<Tree>
}

/** The lines `kete completion` prints without a shell: how to install each script. */
export function instructions(name: string): ReadonlyArray<string> {
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["bash", "add to ~/.bashrc", `eval "$(${name} completion bash)"`],
    ["zsh", "add to ~/.zshrc (after compinit)", `eval "$(${name} completion zsh)"`],
    ["fish", "run once", `${name} completion fish > ~/.config/fish/completions/${name}.fish`],
    ["powershell", "add to $PROFILE", `${name} completion powershell | Out-String | Invoke-Expression`],
  ]
  const shell = Math.max(...rows.map((row) => row[0].length))
  const where = Math.max(...rows.map((row) => row[1].length))
  return [
    `Usage: ${name} completion <${shells.join("|")}>`,
    "",
    `Prints a completion script for ${name}'s commands and flags. To install it:`,
    "",
    ...rows.map(([s, w, line]) => `  ${s.padEnd(shell)}  ${w.padEnd(where)}  ${line}`),
    "",
    "Open a new shell afterwards.",
  ]
}

// PowerShell single-quoted string: only quote characters need escaping (doubled), and PowerShell
// treats the typographic single quotes as quotes too.
function quote(text: string) {
  return `'${text.replace(/['‘’‚‛]/g, (match) => match + match)}'`
}

// Tooltips must be non-empty single-line text.
function tooltip(text: string, fallback: string) {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 0 ? line : fallback
}

interface Entry {
  readonly path: string
  readonly node: Tree
}

// Every command path a user can type, with aliases as their own paths to the same node.
function entries(tree: Tree): ReadonlyArray<Entry> {
  const result: Entry[] = []
  const visit = (node: Tree, path: string) => {
    result.push({ path, node })
    for (const child of node.commands) {
      for (const name of [child.name, ...child.aliases]) visit(child, path ? `${path} ${name}` : name)
    }
  }
  visit(tree, "")
  return result
}

// An array of (name, tooltip) pairs, one `,@(…)` statement per line so a single pair isn't flattened.
function pairs(items: ReadonlyArray<readonly [string, string]>, indent: string) {
  if (items.length === 0) return "@()"
  return ["@(", ...items.map(([key, value]) => `${indent}  ,@(${quote(key)}, ${quote(value)})`), `${indent})`].join("\n")
}

function list(items: ReadonlyArray<string>) {
  return `@(${items.map(quote).join(", ")})`
}

/**
 * A script that registers a native argument completer for `name` (and `name.exe`). It completes
 * subcommands at every level and, for a word starting with `-`, the current command's flags. Values
 * of flags that take one are skipped when finding the current command, and `--` ends it. Names are
 * matched case-sensitively, like the CLI's parser. Written for Windows PowerShell 5.1 and PowerShell 7.
 */
export function powershell(name: string, tree: Tree): string {
  const nodes = entries(tree).map(({ path, node }) => {
    const commands = node.commands.flatMap((child) =>
      [child.name, ...child.aliases].map((spelling) => [spelling, tooltip(child.description, spelling)] as const),
    )
    const flags = node.flags.flatMap((flag) =>
      flag.names.map((spelling) => [spelling, tooltip(flag.description, spelling)] as const),
    )
    const values = node.flags.filter((flag) => flag.value).flatMap((flag) => flag.names)
    return [
      `  $tree[${quote(path)}] = @{`,
      `    commands = ${pairs(commands, "    ")}`,
      `    flags = ${pairs(flags, "    ")}`,
      `    values = ${list(values)}`,
      "  }",
    ].join("\n")
  })
  return [
    `# ${name} completion for PowerShell (Windows PowerShell 5.1 and PowerShell 7).`,
    `# Install: add this line to $PROFILE:  ${name} completion powershell | Out-String | Invoke-Expression`,
    `Register-ArgumentCompleter -Native -CommandName ${list([name, `${name}.exe`])} -ScriptBlock {`,
    "  param($wordToComplete, $commandAst, $cursorPosition)",
    "  $ordinal = [System.StringComparison]::Ordinal",
    "  $tree = New-Object System.Collections.Hashtable ([System.StringComparer]::Ordinal)",
    ...nodes,
    "  $path = ''",
    "  $skip = $false",
    "  $elements = @($commandAst.CommandElements)",
    "  for ($i = 1; $i -lt $elements.Count; $i++) {",
    "    $element = $elements[$i]",
    "    # The word being completed (it ends at the cursor) and anything after it don't count.",
    "    if ($element.Extent.EndOffset -ge $cursorPosition) { break }",
    "    $text = $element.Extent.Text",
    "    if ($skip) { $skip = $false; continue }",
    "    if ($text -ceq '--') { return }",
    "    if ($text.StartsWith('-', $ordinal)) {",
    "      if (-not $text.Contains('=') -and $tree[$path]['values'] -ccontains $text) { $skip = $true }",
    "      continue",
    "    }",
    "    if ($path -eq '') { $next = $text } else { $next = $path + ' ' + $text }",
    "    if ($tree.ContainsKey($next)) { $path = $next }",
    "  }",
    "  if ($skip) { return }",
    "  $word = [string]$wordToComplete",
    "  if ($word.StartsWith('-', $ordinal)) {",
    "    $candidates = $tree[$path]['flags']",
    "    $kind = [System.Management.Automation.CompletionResultType]::ParameterName",
    "  } else {",
    "    $candidates = $tree[$path]['commands']",
    "    $kind = [System.Management.Automation.CompletionResultType]::ParameterValue",
    "  }",
    "  foreach ($candidate in $candidates) {",
    "    if ($candidate[0].StartsWith($word, $ordinal)) {",
    "      [System.Management.Automation.CompletionResult]::new($candidate[0], $candidate[0], $kind, $candidate[1])",
    "    }",
    "  }",
    "}",
  ].join("\n")
}

export * as KeteCompletion from "./completion"
