// Progress for a long step in a CLI command: an animated spinner on an interactive terminal, and
// plain start and end lines otherwise. A spinner writing to a pipe or a log (CI, `ssh` without a
// TTY) prints every animation frame as text, which once turned one `kete upgrade` into 135 KB.
import { log, spinner } from "@clack/prompts"

export interface Progress {
  start(message: string): void
  stop(message: string, code?: number): void
}

type Ui = { spinner: () => Progress; log: { step(m: string): void; success(m: string): void; error(m: string): void } }

export function progress(interactive: boolean = process.stdout.isTTY === true, ui: Ui = { spinner, log }): Progress {
  if (interactive) return ui.spinner()
  return {
    start: (message) => ui.log.step(message),
    stop: (message, code) => (code ? ui.log.error(message) : ui.log.success(message)),
  }
}
