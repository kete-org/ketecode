import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { it } from "../../../core/test/lib/effect"
import { KeteSocketListen } from "../../src/kete/socket-listen"
import { ServerProcess } from "../../src/process"

const unix = process.platform !== "win32"
// A short base: macOS's tmpdir is long, and sun_path is ~104 bytes.
const base = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "kss-"))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

let counter = 0
const privateDir = () => {
  const dir = path.join(base, `d${counter++}`)
  fs.mkdirSync(dir, { mode: 0o700 })
  return dir
}

// A socket file left behind by a crashed process: the child listens, then dies by SIGKILL, so nothing
// unlinks the path.
const staleSocket = async (location: string) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(location)}, () => process.kill(process.pid, "SIGKILL"))`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  )
  await child.exited
}

describe.skipIf(!unix)("KeteSocketListen.prepare", () => {
  test("refuses a relative path", () => {
    expect(() => KeteSocketListen.prepare("relative/s")).toThrow("must be absolute")
  })

  test(`refuses a path longer than ${KeteSocketListen.maxPathBytes} bytes`, () => {
    const dir = privateDir()
    expect(() => KeteSocketListen.prepare(path.join(dir, "x".repeat(120)))).toThrow("longer than 103 bytes")
  })

  test("refuses Windows", () => {
    expect(() => KeteSocketListen.prepare("/tmp/x/s", "win32")).toThrow("not supported on Windows")
  })

  test("refuses a directory other users can enter", () => {
    const dir = privateDir()
    fs.chmodSync(dir, 0o755)
    expect(() => KeteSocketListen.prepare(path.join(dir, "s"))).toThrow("accessible to other users")
  })

  test("refuses a missing directory and a symlinked directory", () => {
    expect(() => KeteSocketListen.prepare(path.join(base, "missing", "s"))).toThrow("does not exist")
    const dir = privateDir()
    const link = path.join(base, `link${counter++}`)
    fs.symlinkSync(dir, link)
    expect(() => KeteSocketListen.prepare(path.join(link, "s"))).toThrow("not a directory")
  })

  test("refuses a regular file at the path and leaves it intact", () => {
    const dir = privateDir()
    const location = path.join(dir, "s")
    fs.writeFileSync(location, "keep me")
    expect(() => KeteSocketListen.prepare(location)).toThrow("not a socket")
    expect(fs.readFileSync(location, "utf8")).toBe("keep me")
  })
})

const serve = (location: string, init: RequestInit = {}) =>
  fetch("http://localhost/api/info", { ...init, unix: location } as RequestInit)

describe.skipIf(!unix)("ServerProcess.start with a socket (AC1)", () => {
  it.live("serves over the socket only, with the password, as unix://<path>, mode 0600", () =>
    Effect.gen(function* () {
      const dir = privateDir()
      const location = path.join(dir, "s")
      const server = yield* ServerProcess.start<never, never>({
        socket: location,
        password: "secret",
        app: { version: "socket-version" },
        database: { path: ":memory:" },
        config: { directory: dir },
        fs: { filewatcher: false },
        models: { fetch: false },
      })
      expect(HttpServer.formatAddress(server.address)).toBe(`unix://${location}`)
      expect(fs.lstatSync(location).isSocket()).toBe(true)
      expect(fs.statSync(location).mode & 0o777).toBe(0o600)

      const denied = yield* Effect.promise(() => serve(location))
      expect(denied.status).toBe(401)
      const ok = yield* Effect.promise(() =>
        serve(location, { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }),
      )
      expect(ok.status).toBe(200)
      expect(yield* Effect.promise(() => ok.json())).toMatchObject({ version: "socket-version", urls: [] })
    }),
  )

  it.live("replaces a stale socket at the path", () =>
    Effect.gen(function* () {
      const dir = privateDir()
      const location = path.join(dir, "s")
      yield* Effect.promise(() => staleSocket(location))
      expect(fs.lstatSync(location).isSocket()).toBe(true)
      yield* ServerProcess.start<never, never>({
        socket: location,
        password: "secret",
        database: { path: ":memory:" },
        config: { directory: dir },
        fs: { filewatcher: false },
        models: { fetch: false },
      })
      const ok = yield* Effect.promise(() =>
        serve(location, { headers: { authorization: `Basic ${btoa("opencode:secret")}` } }),
      )
      expect(ok.status).toBe(200)
    }),
  )

  it.live("fails to start when the directory is not private", () =>
    Effect.gen(function* () {
      const dir = privateDir()
      fs.chmodSync(dir, 0o755)
      const exit = yield* ServerProcess.start<never, never>({
        socket: path.join(dir, "s"),
        password: "secret",
        database: { path: ":memory:" },
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(fs.existsSync(path.join(dir, "s"))).toBe(false)
    }),
  )
})

test.skipIf(!unix)("the socket is removed when the server's scope closes", async () => {
  const dir = privateDir()
  const location = path.join(dir, "s")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* KeteSocketListen.bind(location)
        expect(fs.existsSync(location)).toBe(true)
      }),
    ),
  )
  expect(fs.existsSync(location)).toBe(false)
})
