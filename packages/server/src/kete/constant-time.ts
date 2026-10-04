// Constant-time password comparison for the server's Basic auth (job mode piece A1).
//
// Upstream compared the password with `===`, which returns as soon as a byte differs; the time it
// takes leaks how long a guessed prefix is. This compares every byte of the expected value whatever
// the input, and folds the length difference in rather than returning early. Pure JS over UTF-8
// bytes — no `node:crypto` — so the workerd profile keeps working.

export * as KeteConstantTime from "./constant-time.js"

const encoder = new TextEncoder()

/** Whether `given` equals `expected`, in time that depends only on `expected`'s length. */
export function equal(given: string, expected: string): boolean {
  const g = encoder.encode(given)
  const e = encoder.encode(expected)
  let diff = g.length ^ e.length
  for (let i = 0; i < e.length; i++) diff |= e[i] ^ (g[i] ?? 0)
  return diff === 0
}
