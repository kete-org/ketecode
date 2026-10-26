// The review panel asks the host to show a file's diff. The VS Code bridge (app/src/kete/vscode-host.tsx)
// listens; elsewhere nothing does. An event, so this package needs no import from the app.
export const OPEN_DIFF_EVENT = "kete:open-diff"

export function requestOpenDiff(path: string) {
  window.dispatchEvent(new CustomEvent(OPEN_DIFF_EVENT, { detail: path }))
}

/** The path a `kete:open-diff` event carries, or undefined for anything else. */
export function openDiffPath(event: Event) {
  return event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : undefined
}
