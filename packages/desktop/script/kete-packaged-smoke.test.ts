import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appConnected, connectedLine, executable, freePort, writeServiceConfig, findApp, handshake, handshakeRequest, readRegistration, redact, registrationDir, findRegistration, smokeEnv } from "./kete-packaged-smoke"

const password = "s3cret-pass"
const dirs: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(async () => {
  servers.splice(0).forEach((server) => void server.stop(true))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kete-smoke-test-"))
  dirs.push(dir)
  return dir
}

function fake(output: unknown, status = 200) {
  const server = Bun.serve({ port: 0, fetch: () => (status === 200 ? Response.json({ output }) : new Response("no", { status })) })
  servers.push(server)
  return server.url.toString()
}

describe("kete-packaged-smoke", () => {
  test("findApp resolves the mac tarball and the windows exe by channel", () => {
    const mac = findApp({ dir: "/d", platform: "darwin", channel: "dev" })
    expect(mac.kind).toBe("tar")
    if (mac.kind === "tar") {
      expect(mac.tar).toMatch(/kete-desktop-mac-(arm64|x64)\.app\.tar$/)
      expect(mac.bundle).toBe("Kete Code Dev.app")
    }
    expect(findApp({ dir: "/d", platform: "win32", channel: "prod" })).toEqual({ kind: "exe", exe: path.join("/d", "app", "Kete Code.exe") })
  })

  test("findApp honours --app and rejects an unknown channel or platform", () => {
    expect(findApp({ dir: "/d", platform: "linux", channel: "dev", app: "/x/Y.app" })).toEqual({ kind: "bundle", bundle: "/x/Y.app" })
    expect(findApp({ dir: "/d", platform: "linux", channel: "dev", app: "/x/Y.app.tar" })).toEqual({ kind: "tar", tar: "/x/Y.app.tar", bundle: "Y.app" })
    expect(() => findApp({ dir: "/d", platform: "darwin", channel: "nope" })).toThrow("Unknown channel")
    expect(() => findApp({ dir: "/d", platform: "linux", channel: "dev" })).toThrow("linux")
  })

  test("executable is inside Contents/MacOS", () => {
    expect(executable("/b/Kete Code Dev.app")).toBe(path.join("/b/Kete Code Dev.app", "Contents", "MacOS", "Kete Code Dev"))
  })

  test("smokeEnv isolates every state dir and keeps the base env", () => {
    const env = smokeEnv("/r", { PATH: "/bin" })
    expect(env.PATH).toBe("/bin")
    expect(env.HOME).toBe("/r")
    expect(env.USERPROFILE).toBe("/r")
    for (const name of ["CONFIG", "DATA", "CACHE", "STATE"]) expect(env[`XDG_${name}_HOME`]?.startsWith(path.join("/r"))).toBe(true)
    expect(env.OPENCODE_DESKTOP_TEST_ROOT).toBe(path.join("/r", "app"))
    expect(registrationDir(env)).toBe(path.join("/r", "app", "state", "kete"))
  })

  test("readRegistration reads a valid file, and treats missing or partial files as not yet there", async () => {
    const dir = await temp()
    const file = path.join(dir, "service.json")
    expect(await readRegistration(file)).toBeUndefined()
    await Bun.write(file, '{"url":"http://127')
    expect(await readRegistration(file)).toBeUndefined()
    await Bun.write(file, JSON.stringify({ url: "http://127.0.0.1:1", pid: 7, password }))
    expect(await readRegistration(file)).toEqual({ url: "http://127.0.0.1:1", pid: 7, password })
  })

  test("findRegistration finds a channel-named file and nothing in an empty or missing dir", async () => {
    const dir = await temp()
    expect(await findRegistration(path.join(dir, "missing"))).toBeUndefined()
    expect(await findRegistration(dir)).toBeUndefined()
    await Bun.write(path.join(dir, "service-local.json"), "{}")
    expect(await findRegistration(dir)).toBe(path.join(dir, "service-local.json"))
  })

  test("appConnected waits for the app's first-connection log line", async () => {
    const root = await temp()
    expect(await appConnected(root)).toBeUndefined()
    await Bun.write(path.join(root, "desktop", "logs", "20261104T000000", "main.log"), "starting v2 background service\n")
    expect(await appConnected(root)).toBeUndefined()
    await Bun.write(path.join(root, "desktop", "logs", "20261104T000000", "main.log"), `${connectedLine} {\n`)
    expect(await appConnected(root)).toBe(true)
  })

  test("writeServiceConfig pins the runtime to a free port under the test root", async () => {
    const root = await temp()
    const port = freePort()
    expect(port).toBeGreaterThan(0)
    await writeServiceConfig(root, port)
    expect(await Bun.file(path.join(root, "config", "kete", "service.json")).json()).toEqual({ port })
  })

  test("readRegistration throws when the registration has no password", async () => {
    const file = path.join(await temp(), "service.json")
    await Bun.write(file, JSON.stringify({ url: "http://127.0.0.1:1", pid: 7 }))
    await expect(readRegistration(file)).rejects.toThrow("no password")
  })

  test("handshakeRequest is a Basic-auth JSON POST and never shows the password in its text", () => {
    const request = handshakeRequest("http://127.0.0.1:9", password)
    expect(request.url).toBe("http://127.0.0.1:9/api/rpc/kete.handshake/get")
    expect(request.method).toBe("POST")
    expect(request.headers.get("authorization")).toBe("Basic " + btoa("opencode:" + password))
    expect(String(request)).not.toContain(password)
  })

  test("handshake passes against a correct service", async () => {
    const result = await handshake(fake({ protocol: 1, runtime: "kete", modes: ["code"] }), password)
    expect(result.modes).toEqual(["code"])
  })

  test("handshake rejects a wrong protocol, a missing code mode and a 401", async () => {
    await expect(handshake(fake({ protocol: 99, runtime: "k", modes: ["code"] }), password)).rejects.toThrow("protocol 99, expected 1")
    await expect(handshake(fake({ protocol: 1, runtime: "k", modes: ["work"] }), password)).rejects.toThrow('lacks "code"')
    await expect(handshake(fake(null, 401), password)).rejects.toThrow("handshake HTTP 401")
  })

  test("handshake reports a stopped server without leaking the password", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("") })
    const url = server.url.toString()
    await server.stop(true)
    const error = await handshake(url, password).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    )
    expect(error?.message).toBe(`no service at ${url}`)
    expect(error?.message).not.toContain(password)
  })

  test("redact removes the password and its Basic credential", () => {
    const text = `a ${password} b ${btoa("opencode:" + password)} c`
    expect(redact(text, [password])).toBe("a [redacted] b [redacted] c")
  })
})
