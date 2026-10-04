// A unix-socket listener for `kete serve --socket <path>` (job mode piece A1, kete-code-platform
// docs/jobs.md §8 item 3).
//
// In a cloud job, `kete`'s own server must not be a TCP port: every process in the container could
// reach a loopback port, and the egress firewall would need an exception for it. A unix socket in a
// directory only the `kete` user can enter is reachable by nothing else. `ServerProcess.start`
// (process.ts) uses `bind` instead of its TCP `listen` when `ServerOptions.socket` is set; `kete
// serve` only accepts `--socket` in job mode (cli/src/kete/job-serve.ts).
//
// The socket's permissions come from its directory: the caller creates it 0700, and `bind` refuses
// a directory another user could enter or a path it would have to follow through a symlink. A stale
// socket left by a crashed server is replaced; any other file at the path is left alone and refused.

export * as KeteSocketListen from "./socket-listen.js"

import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Exit, Scope } from "effect"
import { chmodSync, lstatSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"

/** sun_path is 108 bytes on Linux and 104 on macOS, including the NUL; 103 fits both. */
export const maxPathBytes = 103

export class SocketPathError extends Error {
  override readonly name = "KeteSocketListen.SocketPathError"
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

/** Checks `location` and its directory, and removes a stale socket there. Throws `SocketPathError`. */
export function prepare(location: string, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") throw new SocketPathError("--socket is not supported on Windows")
  if (!path.isAbsolute(location)) throw new SocketPathError("the socket path must be absolute")
  if (Buffer.byteLength(location, "utf8") > maxPathBytes)
    throw new SocketPathError(`the socket path is longer than ${maxPathBytes} bytes`)

  const directory = path.dirname(location)
  const parent = (() => {
    try {
      return lstatSync(directory)
    } catch {
      throw new SocketPathError("the socket's directory does not exist")
    }
  })()
  if (!parent.isDirectory()) throw new SocketPathError("the socket's directory is not a directory (or is a symlink)")
  if (typeof process.geteuid === "function" && parent.uid !== process.geteuid())
    throw new SocketPathError("the socket's directory is not owned by this user")
  if ((parent.mode & 0o077) !== 0) throw new SocketPathError("the socket's directory is accessible to other users")

  const existing = (() => {
    try {
      return lstatSync(location)
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
  })()
  if (existing === undefined) return
  if (!existing.isSocket()) throw new SocketPathError("a file that is not a socket already exists at the socket path")
  unlinkSync(location)
}

/** Listens on the unix socket `location`. Same shape as process.ts's TCP `bind`. */
export function bind(location: string) {
  return Effect.gen(function* () {
    yield* Effect.try({ try: () => prepare(location), catch: (error) => error })
    const parentScope = yield* Scope.Scope
    const serverScope = yield* Scope.fork(parentScope)
    const server = createServer()
    return yield* Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            unlinkSync(location)
          } catch (error) {
            if (!missing(error)) throw error
          }
        }),
      )
      const http = yield* NodeHttpServer.make(() => server, { path: location })
      yield* Effect.try({ try: () => chmodSync(location, 0o600), catch: (error) => error })
      yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
      return { http, server, scope: serverScope }
    }).pipe(
      Effect.provideService(Scope.Scope, serverScope),
      Effect.onError((cause) => Scope.close(serverScope, Exit.failCause(cause))),
    )
  })
}
