// The release channel of a build made from a git branch. The channel is part of the version
// (`0.0.0-<channel>-<build>`) and becomes a folder name in the TUI's state directory, which accepts
// only letters, digits, ".", "_" and "-" and must start with a letter or digit. Kete's branch names
// carry a "/" (`feature/x`, `fix/y`), so a local build from one crashed the TUI at startup. A
// detached checkout (CI) has no branch name at all.

export const fallbackChannel = "local"

/** A channel name the version and the TUI's storage both accept, derived from a branch name. */
export function branchChannel(branch: string) {
  const name = branch
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[^a-zA-Z0-9]+$/, "")
  return name || fallbackChannel
}

export * as KeteChannel from "./channel.js"
