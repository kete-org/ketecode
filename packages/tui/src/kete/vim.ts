// Vim mode for the prompt (parity C2, spec P5, docs/vim-mode.md): the pure editing engine. `press` takes the
// prompt's text and cursor and one key, and returns the new text and cursor; `vim-prompt.tsx` applies the
// difference to the textarea (so attachments' marks follow the edit) and owns no editing logic.
//
// Offsets are JavaScript string indices; single steps move by graphemes. Lines are logical (split on "\n");
// wrapping is ignored.
// Supported: normal and insert modes; motions h j k l w b e 0 ^ $ gg G (and the arrow keys); operators d c y
// with a motion or a text object (iw aw i" a" i' a' i( a( ib ab i[ a[ i{ a{), dd cc yy; x p P; i a I A o O;
// u and Ctrl+R; / and ? search with n N. No counts, registers, visual mode or dot-repeat.

export type Mode = "normal" | "insert"

export type Buffer = { readonly text: string; readonly cursor: number }

type Snapshot = Buffer

export type State = {
  readonly mode: Mode
  /** Keys of an unfinished command, e.g. "d", "g", "ci". */
  readonly pending: string
  /** A search being typed after `/` or `?`. */
  readonly typing?: { readonly forward: boolean; readonly text: string }
  readonly search?: { readonly forward: boolean; readonly text: string }
  readonly register: { readonly text: string; readonly linewise: boolean }
  readonly undo: readonly Snapshot[]
  readonly redo: readonly Snapshot[]
  /** The text before the current insert, so the whole insert (and a `c`'s deletion) undoes in one step. */
  readonly insertStart?: Snapshot
  /** A short note for the status line, e.g. "Pattern not found". */
  readonly message?: string
}

export type Key = {
  /** The key name as the terminal reports it ("a", "escape", "return", "left"). */
  readonly name: string
  /** The text the key types, if any ("A" for shift+a). */
  readonly char?: string
  readonly ctrl?: boolean
  readonly meta?: boolean
}

export type Result = {
  readonly state: State
  readonly buffer: Buffer
  /** False when the key should go on to the textarea and the app (insert mode, Enter, Ctrl/Alt keys). */
  readonly handled: boolean
}

const UNDO_LIMIT = 100

/** A new prompt's state; in insert mode, `buffer` is where its first change starts (for `u`). */
export function initial(mode: Mode = "insert", buffer?: Buffer): State {
  return {
    mode,
    pending: "",
    register: { text: "", linewise: false },
    undo: [],
    redo: [],
    ...(mode === "insert" && buffer ? { insertStart: buffer } : {}),
  }
}

/** The status line label: the mode, a search being typed, or the pending keys. */
export function label(state: State) {
  if (state.typing) return `${state.typing.forward ? "/" : "?"}${state.typing.text}`
  if (state.mode === "insert") return "INSERT"
  if (state.message) return `NORMAL · ${state.message}`
  return state.pending ? `NORMAL ${state.pending}` : "NORMAL"
}

// --- text helpers -----------------------------------------------------------------------------------

// One step is one grapheme (a flag, an emoji with a skin tone, a letter with its accent), as the textarea's
// cursor moves.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The grapheme around `at`: its start and end. */
function around(text: string, at: number) {
  for (const { index, segment } of graphemes.segment(text)) if (at < index + segment.length) return { start: index, end: index + segment.length }
  return { start: text.length, end: text.length }
}
/** The end of the grapheme at `at` (the next step). */
const forward = (text: string, at: number) => around(text, at).end
/** The start of the grapheme before `at` (the previous step). */
const backward = (text: string, at: number) => (at <= 0 ? 0 : around(text, at - 1).start)
/** `at` moved back to the start of the grapheme it falls inside. */
const startOf = (text: string, at: number) => (at >= text.length ? text.length : around(text, at).start)
/** `at` moved on to the end of the grapheme it falls inside (unchanged on a boundary). */
const endOf = (text: string, at: number) => (at <= 0 || at >= text.length || startOf(text, at) === at ? at : around(text, at).end)

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1
const lineEnd = (text: string, at: number) => {
  const end = text.indexOf("\n", at)
  return end === -1 ? text.length : end
}
/** The last character of the line (normal mode's cursor never sits on the newline), or the start of an empty line. */
const lineLast = (text: string, at: number) => Math.max(lineStart(text, at), backward(text, lineEnd(text, at)))
const clampNormal = (text: string, at: number) => Math.min(Math.max(0, at), lineLast(text, Math.min(Math.max(0, at), text.length)))

type Kind = 0 | 1 | 2 // blank, word, punctuation
const kind = (char: string | undefined): Kind =>
  char === undefined || /\s/.test(char) ? 0 : /[\p{L}\p{N}_]/u.test(char) ? 1 : 2

function wordForward(text: string, at: number) {
  let i = at
  const start = kind(text[i])
  if (start !== 0) while (i < text.length && kind(text[i]) === start) i++
  while (i < text.length && kind(text[i]) === 0) i++
  return i
}

function wordEnd(text: string, at: number) {
  let i = at + 1
  while (i < text.length && kind(text[i]) === 0) i++
  const k = kind(text[i])
  while (i + 1 < text.length && kind(text[i + 1]) === k) i++
  return Math.min(i, Math.max(0, text.length - 1))
}

function wordBackward(text: string, at: number) {
  let i = at - 1
  while (i > 0 && kind(text[i]) === 0) i--
  const k = kind(text[i])
  while (i > 0 && kind(text[i - 1]) === k) i--
  return Math.max(0, i)
}

const firstNonBlank = (text: string, at: number) => {
  let i = lineStart(text, at)
  const end = lineEnd(text, at)
  while (i < end && (text[i] === " " || text[i] === "\t")) i++
  return i
}

function vertical(text: string, at: number, direction: 1 | -1) {
  const start = lineStart(text, at)
  const column = at - start
  if (direction === -1) {
    if (start === 0) return at
    const previous = lineStart(text, start - 1)
    return Math.min(previous + column, lineLast(text, previous))
  }
  const end = lineEnd(text, at)
  if (end >= text.length) return at
  return Math.min(end + 1 + column, lineLast(text, end + 1))
}

// --- motions ----------------------------------------------------------------------------------------

type Motion = { readonly to: number; readonly type: "exclusive" | "inclusive" | "linewise" }

function motion(text: string, at: number, keys: string): Motion | "pending" | undefined {
  switch (keys) {
    case "h":
    case "left":
      return { to: Math.max(lineStart(text, at), backward(text, at)), type: "exclusive" }
    case "l":
    case "right":
      return { to: Math.min(lineEnd(text, at), forward(text, at)), type: "exclusive" }
    case "j":
    case "down":
      return { to: vertical(text, at, 1), type: "linewise" }
    case "k":
    case "up":
      return { to: vertical(text, at, -1), type: "linewise" }
    case "w":
      return { to: wordForward(text, at), type: "exclusive" }
    case "e":
      return { to: wordEnd(text, at), type: "inclusive" }
    case "b":
      return { to: wordBackward(text, at), type: "exclusive" }
    case "0":
    case "home":
      return { to: lineStart(text, at), type: "exclusive" }
    case "^":
      return { to: firstNonBlank(text, at), type: "exclusive" }
    case "$":
    case "end":
      return { to: lineLast(text, at), type: "inclusive" }
    case "g":
      return "pending"
    case "gg":
      return { to: 0, type: "linewise" }
    case "G":
      return { to: lineStart(text, text.length), type: "linewise" }
  }
  return undefined
}

// --- text objects -----------------------------------------------------------------------------------

type Range = { readonly start: number; readonly end: number }

function wordObject(text: string, at: number, around: boolean): Range | undefined {
  if (text.length === 0) return
  const i = Math.min(at, text.length - 1)
  if (text[i] === "\n") return
  const k = kind(text[i])
  let start = i
  let end = i + 1
  while (start > 0 && text[start - 1] !== "\n" && kind(text[start - 1]) === k) start--
  while (end < text.length && text[end] !== "\n" && kind(text[end]) === k) end++
  if (!around) return { start, end }
  // aw: the word and the blanks after it, or before it when there are none after.
  let after = end
  while (after < text.length && (text[after] === " " || text[after] === "\t")) after++
  if (after > end) return { start, end: after }
  let before = start
  while (before > lineStart(text, start) && (text[before - 1] === " " || text[before - 1] === "\t")) before--
  return { start: before, end }
}

function quoteObject(text: string, at: number, quote: string, around: boolean): Range | undefined {
  const start = lineStart(text, at)
  const line = text.slice(start, lineEnd(text, at))
  const positions: number[] = []
  for (let i = 0; i < line.length; i++) if (line[i] === quote && line[i - 1] !== "\\") positions.push(start + i)
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const open = positions[i]!
    const close = positions[i + 1]!
    // The pair around the cursor, or the first pair after it.
    if (at <= close) return around ? { start: open, end: close + 1 } : { start: open + 1, end: close }
  }
  return undefined
}

const PAIRS: Record<string, readonly [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
}

function bracketObject(text: string, at: number, key: string, around: boolean): Range | undefined {
  const [open, close] = PAIRS[key]!
  let depth = 0
  let start = -1
  for (let i = Math.min(at, text.length - 1); i >= 0; i--) {
    if (text[i] === close && i !== at) depth++
    else if (text[i] === open) {
      if (depth === 0) {
        start = i
        break
      }
      depth--
    }
  }
  if (start === -1) return
  depth = 0
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      if (depth === 0) return around ? { start, end: i + 1 } : { start: start + 1, end: i }
      depth--
    }
  }
  return undefined
}

function textObject(text: string, at: number, keys: string): Range | undefined | "pending" {
  if (keys === "i" || keys === "a") return "pending"
  const around = keys[0] === "a"
  const key = keys.slice(1)
  if (key === "w") return wordObject(text, at, around)
  if (key === '"' || key === "'" || key === "`") return quoteObject(text, at, key, around)
  if (key in PAIRS) return bracketObject(text, at, key, around)
  return undefined
}

// --- the engine -------------------------------------------------------------------------------------

const done = (state: State, buffer: Buffer): Result => ({ state, buffer, handled: true })

function change(state: State, before: Buffer): State {
  return { ...state, undo: [...state.undo, before].slice(-UNDO_LIMIT), redo: [] }
}

function enterInsert(state: State, before: Buffer, buffer: Buffer): Result {
  return done({ ...state, mode: "insert", pending: "", insertStart: before }, buffer)
}

/** The text a key types, or undefined for a non-printing key. */
const typed = (key: Key) => (key.ctrl || key.meta ? undefined : (key.char ?? (key.name.length === 1 ? key.name : undefined)))

function find(text: string, from: number, search: { forward: boolean; text: string }) {
  if (!search.text) return -1
  if (search.forward) {
    const next = text.indexOf(search.text, from + 1)
    return next !== -1 ? next : text.indexOf(search.text)
  }
  const previous = from > 0 ? text.lastIndexOf(search.text, from - 1) : -1
  return previous !== -1 ? previous : text.lastIndexOf(search.text)
}

/** Applies `d`, `c` or `y` to `[start, end)`; when `linewise`, to every line from `start`'s to `end`'s (both inclusive positions). */
function operate(state: State, buffer: Buffer, operator: string, range: Range, linewise: boolean): Result {
  const { text } = buffer
  const start = linewise ? lineStart(text, range.start) : range.start
  const end = linewise ? lineEnd(text, range.end) : range.end
  const content = text.slice(start, end)
  const register = { text: linewise ? `${content}\n` : content, linewise }
  if (operator === "y") return done({ ...state, pending: "", register }, { text, cursor: linewise ? buffer.cursor : start })
  if (operator === "c") {
    const next = { text: text.slice(0, start) + text.slice(end), cursor: start }
    return enterInsert({ ...state, register }, buffer, next)
  }
  // d: a linewise delete takes the line's newline too (the one before it on the last line).
  if (linewise) {
    const from = end < text.length ? start : Math.max(0, start - 1)
    const to = end < text.length ? end + 1 : end
    const rest = text.slice(0, from) + text.slice(to)
    // The line after the deleted ones moved up to `start`; after deleting the last lines, the new last line.
    const cursor = end < text.length ? firstNonBlank(rest, start) : firstNonBlank(rest, lineStart(rest, rest.length))
    return done(change({ ...state, pending: "", register }, buffer), { text: rest, cursor: clampNormal(rest, cursor) })
  }
  const rest = text.slice(0, start) + text.slice(end)
  return done(change({ ...state, pending: "", register }, buffer), { text: rest, cursor: clampNormal(rest, start) })
}

function normal(state: State, buffer: Buffer, key: Key): Result {
  const { text, cursor } = buffer
  const char = typed(key)
  // Enter submits and Ctrl/Alt keys reach the app, as in insert mode (Ctrl+R is redo).
  if (key.ctrl && key.name === "r") {
    const target = state.redo.at(-1)
    if (!target) return done({ ...state, pending: "" }, buffer)
    return done(
      { ...state, pending: "", undo: [...state.undo, buffer], redo: state.redo.slice(0, -1) },
      target,
    )
  }
  // Esc cancels a pending command; with nothing pending it goes on to the app (it interrupts a running turn).
  if (key.name === "escape") {
    if (!state.pending) return { state: { ...state, message: undefined }, buffer, handled: false }
    return done({ ...state, pending: "", message: undefined }, buffer)
  }
  const name = char ?? key.name
  if (key.ctrl || key.meta || name === "return" || name === "enter" || name === "tab") return { state, buffer, handled: false }

  const pending = state.pending
  const keys = pending + name
  const fresh = { ...state, message: undefined }

  // An operator waits for a motion or a text object.
  if (pending && "dcy".includes(pending[0]!)) {
    const operator = pending[0]!
    const rest = keys.slice(1)
    if (rest === operator) return operate(fresh, buffer, operator, { start: cursor, end: cursor }, true)
    if (rest[0] === "i" || rest[0] === "a") {
      const object = textObject(text, cursor, rest)
      if (object === "pending") return done({ ...fresh, pending: keys }, buffer)
      if (!object) return done({ ...fresh, pending: "" }, buffer)
      return operate(fresh, buffer, operator, object, false)
    }
    // cw on a word changes to the end of that word (its run of the same kind), like ce without the jump.
    const run = () => {
      let end = cursor
      while (end + 1 < text.length && text[end + 1] !== "\n" && kind(text[end + 1]) === kind(text[cursor])) end++
      return { to: end, type: "inclusive" as const }
    }
    const step = operator === "c" && rest === "w" && kind(text[cursor]) !== 0 ? run() : motion(text, cursor, rest)
    if (step === "pending") return done({ ...fresh, pending: keys }, buffer)
    if (!step) return done({ ...fresh, pending: "" }, buffer)
    // j or k past the first or last line fails, as in Vim, instead of acting on the current line.
    if ((rest === "j" || rest === "k" || rest === "up" || rest === "down") && step.to === cursor) return done({ ...fresh, pending: "" }, buffer)
    let to = step.to
    // dw on the last word of a line stops at the line's end.
    if (rest === "w" && to > lineEnd(text, cursor)) to = lineEnd(text, cursor)
    const start = Math.min(cursor, to)
    if (step.type === "linewise") return operate(fresh, buffer, operator, { start, end: Math.max(cursor, to) }, true)
    // An inclusive range never takes the line's newline (d$ on an empty line changes nothing).
    const last = Math.max(cursor, to)
    const end = step.type === "inclusive" ? Math.min(forward(text, last), lineEnd(text, last)) : last
    if (end <= start) return done({ ...fresh, pending: "" }, buffer)
    return operate(fresh, buffer, operator, { start, end: Math.min(end, text.length) }, false)
  }

  // A motion moves the cursor.
  const step = motion(text, cursor, keys)
  if (step === "pending") return done({ ...fresh, pending: keys }, buffer)
  if (step) return done({ ...fresh, pending: "" }, { text, cursor: clampNormal(text, step.type === "linewise" && (keys === "gg" || keys === "G") ? firstNonBlank(text, step.to) : step.to) })

  switch (keys) {
    case "d":
    case "c":
    case "y":
      return done({ ...fresh, pending: keys }, buffer)
    case "i":
      return enterInsert(fresh, buffer, buffer)
    case "a":
      return enterInsert(fresh, buffer, { text, cursor: Math.min(forward(text, cursor), lineEnd(text, cursor)) })
    case "I":
      return enterInsert(fresh, buffer, { text, cursor: firstNonBlank(text, cursor) })
    case "A":
      return enterInsert(fresh, buffer, { text, cursor: lineEnd(text, cursor) })
    case "o": {
      const end = lineEnd(text, cursor)
      return enterInsert(fresh, buffer, { text: `${text.slice(0, end)}\n${text.slice(end)}`, cursor: end + 1 })
    }
    case "O": {
      const start = lineStart(text, cursor)
      return enterInsert(fresh, buffer, { text: `${text.slice(0, start)}\n${text.slice(start)}`, cursor: start })
    }
    case "x": {
      if (cursor >= lineEnd(text, cursor)) return done(fresh, buffer)
      return operate(fresh, buffer, "d", { start: cursor, end: forward(text, cursor) }, false)
    }
    case "p":
    case "P": {
      const register = state.register
      if (!register.text) return done(fresh, buffer)
      if (register.linewise) {
        const body = register.text.replace(/\n$/, "")
        if (keys === "p") {
          const end = lineEnd(text, cursor)
          const next = `${text.slice(0, end)}\n${body}${text.slice(end)}`
          return done(change(fresh, buffer), { text: next, cursor: firstNonBlank(next, end + 1) })
        }
        const start = lineStart(text, cursor)
        const next = `${text.slice(0, start)}${body}\n${text.slice(start)}`
        return done(change(fresh, buffer), { text: next, cursor: firstNonBlank(next, start) })
      }
      const at = keys === "p" && cursor < lineEnd(text, cursor) ? forward(text, cursor) : cursor
      const next = text.slice(0, at) + register.text + text.slice(at)
      return done(change(fresh, buffer), { text: next, cursor: Math.max(at, backward(next, at + register.text.length)) })
    }
    case "u": {
      const target = state.undo.at(-1)
      if (!target) return done({ ...fresh, message: "Already at oldest change" }, buffer)
      return done({ ...fresh, undo: state.undo.slice(0, -1), redo: [...state.redo, buffer] }, { text: target.text, cursor: clampNormal(target.text, target.cursor) })
    }
    case "/":
    case "?":
      return done({ ...fresh, typing: { forward: keys === "/", text: "" } }, buffer)
    case "n":
    case "N": {
      const search = state.search
      if (!search) return done(fresh, buffer)
      const at = find(text, cursor, keys === "n" ? search : { ...search, forward: !search.forward })
      if (at === -1) return done({ ...fresh, message: "Pattern not found" }, buffer)
      return done(fresh, { text, cursor: at })
    }
  }
  // Every other printing key is swallowed in normal mode, as in Vim.
  return done({ ...fresh, pending: "" }, buffer)
}

function searching(state: State, buffer: Buffer, key: Key): Result {
  const typing = state.typing!
  if (key.ctrl || key.meta) return { state, buffer, handled: false }
  if (key.name === "escape") return done({ ...state, typing: undefined }, buffer)
  if (key.name === "return" || key.name === "enter") {
    const search = typing.text ? typing : state.search
    if (!search) return done({ ...state, typing: undefined }, buffer)
    const at = find(buffer.text, buffer.cursor, search)
    const next = { ...state, typing: undefined, search }
    if (at === -1) return done({ ...next, message: "Pattern not found" }, buffer)
    return done(next, { text: buffer.text, cursor: at })
  }
  if (key.name === "backspace") {
    if (!typing.text) return done({ ...state, typing: undefined }, buffer)
    return done({ ...state, typing: { ...typing, text: typing.text.slice(0, -1) } }, buffer)
  }
  const char = typed(key)
  if (char === undefined) return done(state, buffer)
  return done({ ...state, typing: { ...typing, text: typing.text + char } }, buffer)
}

/** One key. In insert mode only Esc is handled: everything else types into the textarea as usual. */
export function press(state: State, buffer: Buffer, key: Key): Result {
  if (state.mode === "insert") {
    if (key.name !== "escape") return { state, buffer, handled: false }
    const before = state.insertStart
    const changed = before !== undefined && before.text !== buffer.text
    const next: State = { ...state, mode: "normal", pending: "", insertStart: undefined }
    // Esc steps the cursor back onto the last typed character, as in Vim.
    const cursor = clampNormal(
      buffer.text,
      buffer.cursor > lineStart(buffer.text, buffer.cursor) ? backward(buffer.text, buffer.cursor) : buffer.cursor,
    )
    return done(changed ? change(next, before) : next, { text: buffer.text, cursor })
  }
  if (state.typing) return searching(state, buffer, key)
  return normal(state, buffer, key)
}

/**
 * The smallest single edit that turns `from` into `to`: replace `[start, end)` of `from` with `insert`. It is
 * widened to whole graphemes of `from`, so it never starts or ends inside an emoji or a flag.
 */
export function diff(from: string, to: string) {
  let start = 0
  while (start < from.length && start < to.length && from[start] === to[start]) start++
  let end = from.length
  let toEnd = to.length
  while (end > start && toEnd > start && from[end - 1] === to[toEnd - 1]) {
    end--
    toEnd--
  }
  // The common prefix and suffix are equal in both texts, so widening by the same amounts keeps them aligned.
  const wideStart = startOf(from, start)
  const wideEnd = Math.max(wideStart, endOf(from, end))
  return { start: wideStart, end: wideEnd, insert: to.slice(wideStart, toEnd + (wideEnd - end)) }
}
