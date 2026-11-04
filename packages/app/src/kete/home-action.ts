// What `/` does in the desktop/web app (home.tsx acts on it): see the decision order in `homeAction`.

export type HomeAction<T, S extends string = string> =
  /** Show upstream's Home (the session and project browser). */
  | { readonly kind: "home" }
  /** Tabs are still loading; show nothing yet. */
  | { readonly kind: "wait" }
  /** Open this existing draft. */
  | { readonly kind: "reuse"; readonly tab: T }
  /** Open a new draft in this project. */
  | { readonly kind: "new"; readonly server: S; readonly directory: string }

export function homeAction<S extends string, T extends { readonly type: string; readonly server: S }>(input: {
  /** The `view` query parameter. */
  view?: string
  ready: boolean
  /** The focused server's key and the directory a new session would open in; absent when there is none. */
  server?: S
  directory?: string
  /** Open tabs, oldest first. */
  tabs: readonly T[]
}): HomeAction<T, S> {
  if (input.view === "sessions") return { kind: "home" }
  if (!input.server || !input.directory) return { kind: "home" }
  if (!input.ready) return { kind: "wait" }
  const draft = input.tabs.findLast((tab) => tab.type === "draft" && tab.server === input.server)
  return draft ? { kind: "reuse", tab: draft } : { kind: "new", server: input.server, directory: input.directory }
}
