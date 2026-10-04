// Worktree names are one path segment. Upstream joins the name onto the worktree directory as
// given, so a name like "../../x" (from the HTTP API or a plugin) created the worktree outside it.

export * as KeteWorktreeName from "./worktree-name.js"

/** Whether `name` is a single, ordinary path segment on every platform. */
export function valid(name: string) {
  return (
    name.trim() !== "" &&
    name === name.trim() &&
    name !== "." &&
    name !== ".." &&
    !/[/\\:\0]/.test(name) &&
    // Control characters, and names Windows reserves or strips (trailing dot or space).
    !/[\u0000-\u001f]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)
  )
}
