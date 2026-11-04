// Pure helpers behind the desktop sidebar (sidebar.tsx): which sessions to list, how projects group
// them, how a time reads, and what the account footer may show. No Solid, no network, so each is
// unit-testable with a fixed clock.

import type { KeteAccountRpc } from "@opencode/schema/kete/account"
import { getFilename } from "@opencode/util/path"

/** The part of a home session record the sidebar reads (home/sessions/records.ts's HomeSessionRecord). */
export type SidebarRecord = {
  readonly session: { readonly id: string; readonly time: { readonly created: number; readonly updated?: number } }
  readonly project: { readonly worktree: string }
}

export type SidebarProject = { readonly worktree: string; readonly name?: string }

/** The newest `limit` records (callers pass them newest first, as buildHomeSessionRecords sorts them),
 *  and whether more exist, for "View more". */
export function recentSessions<T>(records: readonly T[], limit: number): { items: T[]; more: boolean } {
  return { items: records.slice(0, Math.max(0, limit)), more: records.length > limit }
}

export type ProjectGroup<T> = {
  readonly project: SidebarProject
  readonly name: string
  /** Every session of the project, not only the ones listed. */
  readonly count: number
  readonly sessions: T[]
}

/** One group per project, in the given project order, each with up to `perProject` of its sessions. */
export function projectGroups<T extends SidebarRecord>(
  records: readonly T[],
  projects: readonly SidebarProject[],
  perProject: number,
): ProjectGroup<T>[] {
  return projects.map((project) => {
    const own = records.filter((record) => record.project.worktree === project.worktree)
    return {
      project,
      name: project.name || getFilename(project.worktree) || project.worktree,
      count: own.length,
      sessions: own.slice(0, Math.max(0, perProject)),
    }
  })
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (n: number) => String(n).padStart(2, "0")

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** "Just now" / "N min ago" within the hour, "HH:MM" later the same day, "Yesterday", else "Mon D". Local time. */
export function relativeTime(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes} min ago`
  const then = new Date(ms)
  const today = startOfDay(new Date(now))
  if (ms >= today) return `${pad(then.getHours())}:${pad(then.getMinutes())}`
  if (ms >= startOfDay(new Date(today - 1))) return "Yesterday"
  return `${MONTHS[then.getMonth()]} ${then.getDate()}`
}

export type AccountLabel =
  | { readonly kind: "signed-in"; readonly organization?: string; readonly host?: string }
  | { readonly kind: "signed-out" }
  | { readonly kind: "offline" }

/** What the footer shows. Reads only `organization` and `platform` (a bare host); never a key or key id. */
export function accountLabel(status: KeteAccountRpc.Status | undefined): AccountLabel | undefined {
  if (!status) return undefined
  if (status.offline) return { kind: "offline" }
  if (!status.signedIn) return { kind: "signed-out" }
  return { kind: "signed-in", organization: status.organization, host: status.platform }
}
