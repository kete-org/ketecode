// Progress for a long step in a CLI command: an animated spinner on an interactive terminal, and
// plain start and end lines otherwise. A spinner writing to a pipe or a log (CI, `ssh` without a
// TTY) prints every animation frame as text, which once turned one `kete upgrade` into 135 KB.
import { log, spinner } from "@clack/prompts"

export interface Progress {
  start(message: string): void
  /** Replaces the spinner's text; without a TTY, prints the message as its own line, so callers send
   * only the updates worth a line (a new phase, not every percent). */
  update(message: string): void
  stop(message: string, code?: number): void
}

type Spinner = { start(m: string): void; stop(m: string, code?: number): void; message?(m: string): void }
type Ui = { spinner: () => Spinner; log: { step(m: string): void; success(m: string): void; error(m: string): void } }

export function progress(interactive: boolean = process.stdout.isTTY === true, ui: Ui = { spinner, log }): Progress {
  if (interactive) {
    const animated = ui.spinner()
    return {
      start: (message) => animated.start(message),
      update: (message) => animated.message?.(message),
      stop: (message, code) => animated.stop(message, code),
    }
  }
  return {
    start: (message) => ui.log.step(message),
    update: (message) => ui.log.step(message),
    stop: (message, code) => (code ? ui.log.error(message) : ui.log.success(message)),
  }
}
