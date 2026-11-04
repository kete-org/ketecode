// Sign-in from the TUI setup screen: runs `kete login` as a child process (the shared helper in
// util/src/kete/login-child.ts). Over SSH the browser can't open on this machine, so `--no-browser`.

export * as SetupLogin from "./setup-login"

import { KeteLoginChild } from "@opencode/util/kete/login-child"

export type Result = KeteLoginChild.Result
export type Spawn = KeteLoginChild.Spawn

export const TIMEOUT = KeteLoginChild.TIMEOUT

export function start(input: {
  onURL: (url: string) => void
  spawn?: Spawn
  command?: string[]
  timeout?: number
}): { result: Promise<Result>; cancel: () => void } {
  const ssh = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY)
  return KeteLoginChild.start({ ...input, args: ["login", ...(ssh ? ["--no-browser"] : [])] })
}
