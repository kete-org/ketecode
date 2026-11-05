import { describe, expect, test } from "bun:test"
import { diff, initial, label, press, type Buffer, type Key, type State } from "../../src/kete/vim"

/** `text` with `|` at the cursor. */
const at = (marked: string): Buffer => ({ text: marked.replace("|", ""), cursor: marked.indexOf("|") })
const show = (buffer: Buffer) => buffer.text.slice(0, buffer.cursor) + "|" + buffer.text.slice(buffer.cursor)

const NAMED = new Set(["escape", "return", "backspace", "left", "right", "up", "down"])

/** Keys as typed: single characters, `<escape>`-style names, `<c-r>` for Ctrl+R. */
function keys(input: string): Key[] {
  const out: Key[] = []
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "<") {
      const end = input.indexOf(">", i)
      const name = input.slice(i + 1, end)
      if (name.startsWith("c-")) {
        out.push({ name: name.slice(2), ctrl: true })
        i = end
        continue
      }
      if (NAMED.has(name)) {
        out.push({ name })
        i = end
        continue
      }
    }
    const char = input[i]!
    out.push({ name: char.toLowerCase(), char })
  }
  return out
}

function run(marked: string, input: string, state: State = initial("normal")) {
  let buffer = at(marked)
  let current = state
  for (const key of keys(input)) {
    const result = press(current, buffer, key)
    current = result.state
    buffer = result.buffer
    // Insert mode passes text on: the textarea types it.
    if (!result.handled && current.mode === "insert" && key.char)
      buffer = { text: buffer.text.slice(0, buffer.cursor) + key.char + buffer.text.slice(buffer.cursor), cursor: buffer.cursor + 1 }
  }
  return { text: show(buffer), state: current }
}

const expectKeys = (marked: string, input: string, expected: string) => expect(run(marked, input).text).toBe(expected)

describe("motions", () => {
  test("h l stop at the line's ends; the cursor never sits on the newline", () => {
    expectKeys("a|bc\nd", "h", "|abc\nd")
    expectKeys("|abc\nd", "h", "|abc\nd")
    expectKeys("a|bc\nd", "ll", "ab|c\nd")
  })

  test("j k keep the column, clamped to the shorter line", () => {
    expectKeys("abc|d\nxy\nlonger", "j", "abcd\nx|y\nlonger")
    expectKeys("abcd\nxy\nlon|ger", "k", "abcd\nx|y\nlonger")
    expectKeys("ab|c", "j", "ab|c")
  })

  test("w b e move by words and punctuation runs", () => {
    expectKeys("|foo.bar baz", "w", "foo|.bar baz")
    expectKeys("|foo.bar baz", "ww", "foo.|bar baz")
    expectKeys("|foo.bar baz", "www", "foo.bar |baz")
    expectKeys("foo.bar |baz", "b", "foo.|bar baz")
    expectKeys("|foo bar", "e", "fo|o bar")
    expectKeys("fo|o bar", "e", "foo ba|r")
    expectKeys("|one\ntwo", "w", "one\n|two")
  })

  test("0 ^ $ gg G", () => {
    expectKeys("  ab|cd", "0", "|  abcd")
    expectKeys("  ab|cd", "^", "  |abcd")
    expectKeys("ab|cd\nx", "$", "abc|d\nx")
    expectKeys("one\ntw|o\n  three", "G", "one\ntwo\n  |three")
    expectKeys("  one\ntw|o", "gg", "  |one\ntwo")
  })
})

describe("operators", () => {
  test("dw cw yw, and dw at a line's last word stops at the line's end", () => {
    expectKeys("|foo bar", "dw", "|bar")
    expectKeys("foo |bar\nnext", "dw", "foo| \nnext")
    const changed = run("|foo bar", "cwxy<escape>")
    expect(changed.text).toBe("x|y bar")
    const yanked = run("|foo bar", "ywP")
    expect(yanked.text).toBe("foo| foo bar")
  })

  test("d with e $ 0 b h l", () => {
    expectKeys("|foo bar", "de", "| bar")
    expectKeys("fo|o bar", "d$", "f|o")
    expectKeys("foo b|ar", "d0", "|ar")
    expectKeys("foo b|ar", "db", "foo |ar")
    expectKeys("ab|c", "dh", "a|c")
    expectKeys("a|bc", "dl", "a|c")
  })

  test("dd cc yy, and linewise j k G gg", () => {
    expectKeys("one\nt|wo\nthree", "dd", "one\n|three")
    expectKeys("one\ntwo\nthr|ee", "dd", "one\n|two")
    expectKeys("o|nly", "dd", "|")
    expectKeys("one\nt|wo\nthree", "ccX<escape>", "one\n|X\nthree")
    expectKeys("o|ne\ntwo", "yyp", "one\n|one\ntwo")
    expectKeys("o|ne\ntwo\nthree", "dj", "|three")
    expectKeys("one\ntwo\nth|ree", "dk", "|one")
    expectKeys("one\nt|wo\nthree", "dG", "|one")
    expectKeys("one\nt|wo\nthree", "dgg", "|three")
  })

  test("x p P", () => {
    expectKeys("a|bc", "x", "a|c")
    expectKeys("a|bc", "xp", "ac|b")
    expectKeys("a|bc", "xP", "a|bc")
    expectKeys("|\nx", "x", "|\nx")
  })
})

describe("text objects", () => {
  test("iw aw", () => {
    expectKeys("foo b|ar baz", "diw", "foo | baz")
    expectKeys("foo b|ar baz", "daw", "foo |baz")
    expectKeys("foo b|ar", "daw", "fo|o")
    expectKeys("foo b|ar baz", "ciwX<escape>", "foo |X baz")
  })

  test('i" a" and the first pair after the cursor', () => {
    expectKeys('say "he|llo" now', 'di"', 'say "|" now')
    expectKeys('say "he|llo" now', 'da"', "say | now")
    expectKeys('s|ay "hello"', 'ci"x<escape>', 'say "|x"')
  })

  test("i( a( with nesting, and ib / i{", () => {
    expectKeys("f(a, g(|b), c)", "di(", "f(a, g(|), c)")
    expectKeys("f(a, |g(b), c)", "di(", "f(|)")
    expectKeys("f(a, g(|b), c)", "da(", "f(a, g|, c)")
    expectKeys("x = {a: |1}", "diB", "x = {|}")
    expectKeys("call(ar|g)", "yibP", "call(ar|garg)")
  })

  test("an object that isn't there changes nothing", () => {
    expectKeys("no |quotes", 'di"', "no |quotes")
    expectKeys("no |parens", "di(", "no |parens")
  })
})

describe("undo, redo and search", () => {
  test("u undoes a whole change, Ctrl+R redoes it", () => {
    expectKeys("|foo bar", "dwu", "|foo bar")
    expectKeys("|foo bar", "dwu<c-r>", "|bar")
    // An insert (with c's deletion) is one change.
    expectKeys("|foo bar", "cwnew<escape>u", "|foo bar")
    expect(run("|x", "u").state.message).toBe("Already at oldest change")
  })

  test("typing from the start of insert mode undoes to the starting text", () => {
    const start = at("|")
    const state = initial("insert", start)
    const typed = { ...start, text: "hello", cursor: 5 }
    const escaped = press(state, typed, { name: "escape" })
    expect(show(escaped.buffer)).toBe("hell|o")
    expect(show(press(escaped.state, escaped.buffer, { name: "u", char: "u" }).buffer)).toBe("|")
  })

  test("/ and ? search, n and N repeat, wrapping around", () => {
    expectKeys("|a foo b foo", "/foo<return>", "a |foo b foo")
    expectKeys("|a foo b foo", "/foo<return>n", "a foo b |foo")
    expectKeys("|a foo b foo", "/foo<return>nn", "a |foo b foo")
    expectKeys("a foo b foo|.", "?foo<return>", "a foo b |foo.")
    expectKeys("a foo b foo|.", "?foo<return>N", "a |foo b foo.")
    expect(run("|abc", "/zz<return>").state.message).toBe("Pattern not found")
    expect(label(run("|abc", "/zz").state)).toBe("/zz")
    expectKeys("|abc", "/zz<escape>l", "a|bc")
  })
})

describe("modes and passing keys on", () => {
  test("i a I A o O enter insert mode at the right place", () => {
    expect(run("a|bc", "i").state.mode).toBe("insert")
    expectKeys("a|bc", "i", "a|bc")
    expectKeys("a|bc", "a", "ab|c")
    expectKeys("  a|bc", "I", "  |abc")
    expectKeys("a|bc\nd", "A", "abc|\nd")
    expectKeys("a|bc\nd", "o", "abc\n|\nd")
    expectKeys("a|bc\nd", "O", "|\nabc\nd")
  })

  test("Esc leaves insert mode one character back", () => {
    expect(press(initial("insert"), at("abc|"), { name: "escape" }).buffer.cursor).toBe(2)
    expect(press(initial("insert"), at("|abc"), { name: "escape" }).buffer.cursor).toBe(0)
  })

  test("insert mode handles only Esc; normal mode passes Enter and Ctrl keys on and swallows other text", () => {
    expect(press(initial("insert"), at("|"), { name: "x", char: "x" }).handled).toBe(false)
    expect(press(initial("normal"), at("|a"), { name: "return" }).handled).toBe(false)
    expect(press(initial("normal"), at("|a"), { name: "p", ctrl: true }).handled).toBe(false)
    const swallowed = press(initial("normal"), at("|a"), { name: "z", char: "z" })
    expect(swallowed.handled).toBe(true)
    expect(swallowed.buffer.text).toBe("a")
  })

  test("labels", () => {
    expect(label(initial("insert"))).toBe("INSERT")
    expect(label(initial("normal"))).toBe("NORMAL")
    expect(label(run("|a", "d").state)).toBe("NORMAL d")
  })
})

test("diff finds the one replacement between two texts", () => {
  expect(diff("hello world", "hello there world")).toEqual({ start: 6, end: 6, insert: "there " })
  expect(diff("abc", "ac")).toEqual({ start: 1, end: 2, insert: "" })
  expect(diff("same", "same")).toEqual({ start: 4, end: 4, insert: "" })
  expect(diff("aaa", "aa")).toEqual({ start: 2, end: 3, insert: "" })
})

test("steps move by whole graphemes: emoji, flags, skin tones, accents", () => {
  expectKeys("a|😀b", "l", "a😀|b")
  expectKeys("a😀|b", "h", "a|😀b")
  expectKeys("a|😀b", "x", "a|b")
  expectKeys("a|😀", "$", "a|😀")
  expectKeys("a|🇬🇭", "$", "a|🇬🇭")
  expectKeys("a🇬🇭|", "<escape>", "a🇬🇭|")
  expectKeys("|🇬🇭a", "x", "|a")
  expectKeys("|👍🏽k", "l", "👍🏽|k")
  expectKeys("|e\u0301z", "x", "|z")
})

test("diff is widened to whole graphemes", () => {
  expect(diff("x😃y", "x😀y")).toEqual({ start: 1, end: 3, insert: "😀" })
  expect(diff("🇬🇧", "🇬🇭")).toEqual({ start: 0, end: 4, insert: "🇬🇭" })
})

test("review cases: cw inside a word, d$ on an empty line, j/k past the ends, Ctrl keys while searching", () => {
  expectKeys("fo|o bar", "cwX<escape>", "fo|X bar")
  expectKeys("|a b", "cwX<escape>", "|X b")
  expectKeys("a\n|\nb", "d$", "a\n|\nb")
  expectKeys("a\n|b", "dj", "a\n|b")
  expectKeys("|a\nb", "dk", "|a\nb")
  expect(press(run("|abc", "/x").state, at("|abc"), { name: "c", ctrl: true }).handled).toBe(false)
  // A note in the status line doesn't keep Esc from the app.
  const noted = run("|abc", "/zz<return>").state
  expect(noted.message).toBe("Pattern not found")
  const escaped = press(noted, at("|abc"), { name: "escape" })
  expect(escaped.handled).toBe(false)
  expect(escaped.state.message).toBeUndefined()
})

test("Esc in normal mode with nothing pending goes on to the app", () => {
  expect(press(initial("normal"), at("|a"), { name: "escape" }).handled).toBe(false)
  expect(press(run("|a", "d").state, at("|a"), { name: "escape" }).handled).toBe(true)
})
