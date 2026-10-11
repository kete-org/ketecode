// The home screen's one-line tip (docs/home-notices.md). One tip per launch, picked by
// home-notices.tsx; shown only when no notice is visible, and off with `"tips": false` in cli.json.
// Each tip names only commands and keys that exist: `/statusline` (statusline.tsx), `/mode`
// (permission-mode.tsx), `!` shell mode and `@` attachments (component/prompt), Ctrl+R history
// search (history-search.ts), `/help` (app.tsx).

export const TIPS: readonly string[] = [
  "Type /statusline to choose what the status line shows.",
  "Type /mode to change which actions ask for your approval.",
  "Start a prompt with ! to run a shell command.",
  "Type @ to attach a file to your prompt.",
  "Press Ctrl+R in the prompt to search your prompt history.",
  "Type /help to see every command and its keys.",
]

/** The tip for `index`, wrapping around (and never negative). Undefined only for an empty list. */
export function pickTip(index: number, tips: readonly string[] = TIPS): string | undefined {
  if (tips.length === 0) return undefined
  const whole = Number.isFinite(index) ? Math.trunc(index) : 0
  return tips[((whole % tips.length) + tips.length) % tips.length]
}
