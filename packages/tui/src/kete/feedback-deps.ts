// The side effects of `/feedback` (./feedback.tsx), in one module so tests replace them all
// (`mock.module`) and never open a browser, read the person's account or log, or write a file.

import os from "node:os"
import open from "open"
import { Global } from "@opencode/util/global"
import { KeteAccount } from "@opencode/util/kete/account"
import { Brand } from "@opencode/util/kete/brand"
import { KeteBugReportFile } from "@opencode/util/kete/bug-report-file"
import { Logging } from "@opencode/util/observability/logging"

/** Opens `url` in the platform's browser. */
export async function openURL(url: string): Promise<void> {
  await open(url)
}

/** Whether a Kete account is signed in (account.json only, never the key). */
export async function signedIn(): Promise<boolean> {
  return (await KeteAccount.read({ config: Global.Path.config })) !== undefined
}

/** The end of this channel's log file (util/observability/logging.ts names it). */
export function logTail(channel: string): Promise<string | undefined> {
  return KeteBugReportFile.tail(Logging.file(channel === "local", channel))
}

/** Saves a report in the temp directory, mode 0600; returns its path. */
export function save(text: string): Promise<string> {
  return KeteBugReportFile.save(os.tmpdir(), Brand.filePrefix, text)
}
