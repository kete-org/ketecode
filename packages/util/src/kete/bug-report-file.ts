// File helpers for problem reports (./bug-report.ts): read the end of the log file, and save a
// report where only its owner can read it.

export * as KeteBugReportFile from "./bug-report-file.js"

import { randomBytes } from "node:crypto"
import { realpathSync } from "node:fs"
import { open, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** How much of the end of the log file a report reads. */
export const TAIL_BYTES = 256 * 1024

/**
 * The last `maxBytes` of `file` as text, starting at a line boundary; `undefined` when the file
 * doesn't exist. Other read errors are thrown.
 */
export async function tail(file: string, maxBytes = TAIL_BYTES): Promise<string | undefined> {
  const handle = await open(file, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    if (length === size) return text
    // Started mid-file: drop the partial first line.
    const newline = text.indexOf("\n")
    return newline === -1 ? "" : text.slice(newline + 1)
  } finally {
    await handle.close()
  }
}

/**
 * Writes `text` to a new file in `directory` named `<prefix>-bug-<time>-<random>.md`, readable only by
 * its owner (mode 0600). Never overwrites or follows an existing path. Returns the file's path.
 */
export async function save(directory: string, prefix: string, text: string, now = new Date()): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-")
  const file = path.join(directory, `${prefix}-bug-${stamp}-${randomBytes(4).toString("hex")}.md`)
  await writeFile(file, text, { mode: 0o600, flag: "wx" })
  return file
}

function real(file: string): string | undefined {
  try {
    return realpathSync.native(file)
  } catch {
    // A path that can't be resolved has no other spelling to add.
    return undefined
  }
}

/**
 * Every spelling of the home directory a report should show as `~` (KeteBugReport.Home): `home` as
 * given, its real path (a symlinked home, a different case, an 8.3 short name resolved), and, when the
 * temp directory is inside the profile, the profile prefix the temp directory is spelt with (Windows'
 * `C:\Users\RUNNER~1\AppData\Local\Temp`).
 */
export function homes(home: string, tmp = os.tmpdir(), platform: NodeJS.Platform = process.platform): string[] {
  const spellings = [home]
  const realHome = real(home)
  if (realHome) spellings.push(realHome)
  const realTmp = real(tmp)
  if (realHome && realTmp) {
    const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value)
    const base = realHome.replace(/[\\/]+$/, "")
    if (fold(realTmp).startsWith(fold(base + path.sep))) {
      // The part of the temp directory below the profile; what's in front of it in `tmp` is the profile.
      const rest = realTmp.slice(base.length)
      const trimmed = tmp.replace(/[\\/]+$/, "")
      if (fold(trimmed).endsWith(fold(rest))) spellings.push(trimmed.slice(0, trimmed.length - rest.length))
    }
  }
  return [...new Set(spellings.filter((spelling) => spelling.length > 1))]
}
