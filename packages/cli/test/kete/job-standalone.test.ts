import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KeteJobStandalone } from "../../src/kete/job-standalone"

const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"
const unix = process.platform !== "win32"
const base = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "kjs-"))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

describe("KeteJobStandalone.command (AC1, AC2)", () => {
  const cmd = KeteJobStandalone.command({
    password: "the-password",
    gatewayKey: "the-gateway-key",
    organization: org,
    socket: "/run/kete-abc/s",
    command: ["/opt/kete/kete"],
    cwd: "/work",
  })

  test("runs `serve --stdio --socket <path>` and never --port", () => {
    expect(cmd._tag).toBe("StandardCommand")
    if (cmd._tag !== "StandardCommand") return
    expect(cmd.command).toBe("/opt/kete/kete")
    expect(cmd.args).toEqual(["serve", "--stdio", "--socket", "/run/kete-abc/s"])
    expect(cmd.args).not.toContain("--port")
    expect(cmd.args).not.toContain("--hostname")
  })

  test("the environment names only the descriptor; secrets travel on fd 3", () => {
    if (cmd._tag !== "StandardCommand") throw new Error("expected a standard command")
    expect(cmd.options.env).toEqual({ KETE_JOB_SECRETS_FD: "3", KETE_JOB_AUDIT_FD: "4" })
    const serialized = JSON.stringify(cmd.options.env)
    expect(serialized).not.toContain("the-password")
    expect(serialized).not.toContain("the-gateway-key")
    expect(serialized).not.toMatch(/PASSWORD|GATEWAY_KEY"/)
    expect(Object.keys(cmd.options.additionalFds ?? {})).toEqual(["fd3", "fd4"])
    expect(cmd.options.additionalFds?.fd4).toEqual({ type: "output" })
    expect(cmd.args.join(" ")).not.toContain("the-password")
    expect(cmd.args.join(" ")).not.toContain("the-gateway-key")
  })

  test("the secrets message", () => {
    expect(JSON.parse(KeteJobStandalone.secretsMessage({ password: "p", gatewayKey: "k", organization: org }))).toEqual({
      v: 1,
      password: "p",
      gateway_key: "k",
      organization: org,
    })
  })
})

describe("KeteJobStandalone.runtimeBase (D3)", () => {
  test("XDG_RUNTIME_DIR when set and absolute, else tmpdir", () => {
    const tmp = () => "/tmp-dir"
    expect(KeteJobStandalone.runtimeBase({ XDG_RUNTIME_DIR: "/run/user/1000" }, tmp)).toBe("/run/user/1000")
    expect(KeteJobStandalone.runtimeBase({ XDG_RUNTIME_DIR: "relative" }, tmp)).toBe("/tmp-dir")
    expect(KeteJobStandalone.runtimeBase({ XDG_RUNTIME_DIR: "" }, tmp)).toBe("/tmp-dir")
    expect(KeteJobStandalone.runtimeBase({}, tmp)).toBe("/tmp-dir")
  })
})

describe.skipIf(!unix)("KeteJobStandalone socket directory", () => {
  test("is a fresh 0700 directory with a short socket path, and is removed", () => {
    const { directory, socket } = KeteJobStandalone.makeSocketDirectory(base)
    expect(path.dirname(directory)).toBe(base)
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
    expect(socket).toBe(path.join(directory, "s"))
    KeteJobStandalone.removeSocketDirectory(directory, socket)
    expect(fs.existsSync(directory)).toBe(false)
  })

  test("removes a socket left behind with the directory", () => {
    const { directory, socket } = KeteJobStandalone.makeSocketDirectory(base)
    fs.writeFileSync(socket, "")
    KeteJobStandalone.removeSocketDirectory(directory, socket)
    expect(fs.existsSync(directory)).toBe(false)
  })

  test("refuses a base writable by others without the sticky bit; accepts sticky and private ones", () => {
    const open = path.join(base, "open")
    fs.mkdirSync(open)
    fs.chmodSync(open, 0o777)
    expect(() => KeteJobStandalone.makeSocketDirectory(open)).toThrow("writable by other users without the sticky bit")
    expect(fs.readdirSync(open)).toEqual([])
    fs.chmodSync(open, 0o775)
    expect(() => KeteJobStandalone.checkRuntimeBase(open)).toThrow("without the sticky bit")
    fs.chmodSync(open, 0o1777)
    expect(() => KeteJobStandalone.checkRuntimeBase(open)).not.toThrow()
    fs.chmodSync(open, 0o755)
    expect(() => KeteJobStandalone.checkRuntimeBase(open)).not.toThrow()
    expect(() => KeteJobStandalone.checkRuntimeBase(path.join(base, "missing"))).toThrow("does not exist")
  })

  test("refuses a base too long for a unix socket path, creating nothing", () => {
    const long = path.join(base, "x".repeat(100))
    expect(() => KeteJobStandalone.makeSocketDirectory(long)).toThrow("too long for a unix socket path")
  })
})

describe("KeteJobStandalone.readyUrl", () => {
  test("accepts exactly unix://<socket>", () => {
    expect(KeteJobStandalone.readyUrl('{"url":"unix:///run/k/s"}', "/run/k/s")).toBe("unix:///run/k/s")
  })

  test("refuses another URL or an invalid line", () => {
    expect(() => KeteJobStandalone.readyUrl('{"url":"http://127.0.0.1:4096"}', "/run/k/s")).toThrow(
      "did not report listening on its socket",
    )
    expect(() => KeteJobStandalone.readyUrl('{"url":"unix:///other/s"}', "/run/k/s")).toThrow()
    expect(() => KeteJobStandalone.readyUrl("server listening", "/run/k/s")).toThrow("not valid")
  })
})

describe.skipIf(!unix)("KeteJobStandalone.start", () => {
  test("a child that refuses to start reports its last stderr line, and its directory is removed", async () => {
    const runtime = path.join(base, "start")
    fs.mkdirSync(runtime, { mode: 0o700 })
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        KeteJobStandalone.start({
          gatewayKey: "the-gateway-key",
          organization: org,
          auditFd: 99,
          env: { XDG_RUNTIME_DIR: runtime },
          command: [
            process.execPath,
            "-e",
            `console.error("starting"); console.error("Job mode: could not make the process non-dumpable"); process.exit(1)`,
          ],
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const message = Exit.isFailure(exit) ? String(exit.cause) : ""
    expect(message).toContain("exited before reporting readiness: Job mode: could not make the process non-dumpable")
    expect(message).not.toContain("the-gateway-key")
    expect(fs.readdirSync(runtime)).toEqual([])
  })
})
