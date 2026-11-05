/** @jsxImportSource @opentui/solid */
// The copy picker (parity C1, spec P4, docs/transcript-search.md): `/copy` (and `<leader>y`) and the message
// dialog's Copy ask what to copy: the whole response, one of its code blocks, or (from `/copy`) the whole
// transcript, which runs the existing `session.copy` command.

import { useClipboard } from "../context/clipboard"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

export type CodeBlock = { readonly language?: string; readonly code: string }

/** Fenced code blocks (``` or ~~~, CommonMark rules) in Markdown, in order. An unclosed fence runs to the end. */
export function codeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  let open: { char: string; length: number; indent: number; language?: string; lines: string[] } | undefined
  for (const line of markdown.split("\n")) {
    if (open) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
      if (close && close[1]![0] === open.char && close[1]!.length >= open.length) {
        blocks.push({ ...(open.language ? { language: open.language } : {}), code: open.lines.join("\n") })
        open = undefined
        continue
      }
      // Content lines lose up to the fence's own indentation.
      open.lines.push(line.replace(new RegExp(`^ {0,${open.indent}}`), ""))
      continue
    }
    const start = line.match(/^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)/)
    if (!start) continue
    // A backtick fence's info string can't contain a backtick.
    if (start[2]![0] === "`" && line.slice(start[0].length).includes("`")) continue
    open = { char: start[2]![0]!, length: start[2]!.length, indent: start[1]!.length, language: start[3] || undefined, lines: [] }
  }
  if (open) blocks.push({ ...(open.language ? { language: open.language } : {}), code: open.lines.join("\n") })
  return blocks
}

export type Choice = { readonly kind: "text"; readonly text: string; readonly what: string } | { readonly kind: "transcript" }

export type Option = { readonly title: string; readonly description?: string; readonly value: Choice }

/** The picker's rows: the response, each code block (with its language and first line), and the transcript. */
export function options(text: string, transcript: boolean): Option[] {
  const blocks = codeBlocks(text)
  return [
    { title: "Response", description: "the whole message", value: { kind: "text", text, what: "Response" } },
    ...blocks.map((block, index): Option => {
      const first = block.code.split("\n").find((line) => line.trim() !== "")?.trim() ?? "(empty)"
      const title = `Code block ${index + 1}${block.language ? ` · ${block.language}` : ""}`
      return { title, description: first, value: { kind: "text", text: block.code, what: title } }
    }),
    ...(transcript
      ? [{ title: "Transcript", description: "the whole session as Markdown", value: { kind: "transcript" } } as const]
      : []),
  ]
}

export function DialogKeteCopy(props: { readonly text: string; readonly transcript?: () => void }) {
  const clipboard = useClipboard()
  const toast = useToast()
  return (
    <DialogSelect
      title="Copy"
      options={options(props.text, props.transcript !== undefined).map((option) => ({
        ...option,
        onSelect: (dialog) => {
          const choice = option.value
          if (choice.kind === "transcript") {
            props.transcript?.()
            return
          }
          clipboard
            .write(choice.text)
            .then(() => toast.show({ message: `${choice.what} copied to clipboard`, variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
          dialog.clear()
        },
      }))}
    />
  )
}
