// End to end, with real processes: `kete job run` in job mode starts its server on a unix socket,
// passes the secrets by descriptor and runs a session against a fake gateway (job mode piece A1,
// AC1–AC3, AC5). Self-contained — only `bun:test` and `node:*` — so the same file runs in a plain
// Linux container against a built binary: set JOBSOCK_E2E_BIN to the binary's path. Without it, the
// CLI runs from source (`bun run src/index.ts`, with the package's bunfig via BUN_OPTIONS, since the
// job runs in its own cwd).
//
// Root-only checks (another process's /proc/<pid>/environ and /proc/<pid>/fd once it is
// non-dumpable) run only as root on Linux; otherwise the test says it skipped them.
//
// Piece A3: the job's audit log goes to a pipe on fd 4 (KETE_JOB_AUDIT_FD=4), never to a file, and
// job mode confines its file access with openat2 — so on macOS the job's server refuses to start
// (asserted), and the full run is Linux only.

import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const linux = process.platform === "linux"
const root = typeof process.getuid === "function" && process.getuid() === 0
// CAP_SYS_PTRACE (bit 19): reading a non-dumpable process's environ needs it, even as root.
const canTrace = (() => {
  if (!linux || !root) return false
  const capEff = /^CapEff:\s*([0-9a-f]+)$/m.exec(fs.readFileSync("/proc/self/status", "utf8"))?.[1]
  return capEff !== undefined && (BigInt(`0x${capEff}`) & (1n << 19n)) !== 0n
})()
const cliDir = path.resolve(import.meta.dir, "../..")
const binary = process.env.JOBSOCK_E2E_BIN
const command = binary ? [binary] : [process.execPath, "run", path.join(cliDir, "src/index.ts")]
const runtimeOptions: Record<string, string> = binary ? {} : { BUN_OPTIONS: `--config=${path.join(cliDir, "bunfig.toml")}` }

const fdKey = "kete_job_fd_key_0123456789abcdefABCDEF"
const envKey = "env-key-must-be-ignored"

const base = fs.mkdtempSync(path.join(os.tmpdir(), "kjsock-"))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

function completion(text: string) {
  const chunks = [
    { choices: [{ delta: { role: "assistant" }, finish_reason: null }], usage: null },
    { choices: [{ delta: { content: text }, finish_reason: null }], usage: null },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
}

// One catalog provider the gateway routes (`/compat/openrouter/v1`), with one model.
const models = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://openrouter.ai/api/v1",
    models: {
      "test-chat": {
        id: "test-chat",
        name: "Test Chat",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        tool_call: true,
        temperature: true,
        limit: { context: 100_000, output: 10_000 },
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0, output: 0 },
      },
    },
  },
}

const organization = { id: "573b7e15-80c5-4db4-9e43-a8841b97f055", name: "Kete Labs" }
const developer = {
  id: "3f1c2b7e-8a4d-4c1e-9b2f-5d6e7a8b9c01",
  slug: "developer",
  version: 3,
  name: "Developer",
  description: "The developer.",
  mode: "primary",
  model: { provider: "openrouter", model_id: "test-chat" },
  instructions: "You are the developer agent.",
  tools: { edit: true, shell: false, web: false, skills: [], subagents: [], mcp: {} },
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ],
  budget: { monthly_micros: null, spent_micros: 0, period: "2026-10" },
}

/** The fake serves both the gateway routes and the platform's `GET /api/v1/sync` (job mode piece A2). */
function fakeGateway(options: { sync?: "ok" | "unauthorized" } = {}) {
  const authorizations: string[] = []
  const syncAuthorizations: string[] = []
  const chatHeaders: Headers[] = []
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let held: () => void = () => undefined
  const holding = new Promise<void>((resolve) => {
    held = resolve
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      authorizations.push(request.headers.get("authorization") ?? "")
      if (request.method === "GET" && url.pathname === "/api/v1/sync") {
        syncAuthorizations.push(request.headers.get("authorization") ?? "")
        if (options.sync === "unauthorized")
          return Response.json({ error: { code: "invalid_key", message: "revoked", request_id: "r1" } }, { status: 401 })
        return Response.json(
          { organization, generated_at: "2026-10-01T10:00:00Z", agents: [developer] },
          { headers: { etag: '"j1"' } },
        )
      }
      if (request.method === "GET" && url.pathname === "/compat/openrouter/v1/models")
        return Response.json({ object: "list", data: [{ id: "test-chat" }] })
      if (request.method === "POST" && url.pathname === "/compat/openrouter/v1/chat/completions") {
        chatHeaders.push(request.headers)
        await request.text()
        held()
        await released
        return new Response(completion("done"), { headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({ error: { message: "not available" } }, { status: 404 })
    },
  })
  return { server, authorizations, syncAuthorizations, chatHeaders, release, holding }
}

function setup(name: string, agent: string | null = "developer") {
  const dir = path.join(base, name)
  const repo = path.join(dir, "repo")
  const xdg = path.join(dir, "home")
  const tmp = path.join(dir, "tmp")
  for (const item of [repo, xdg, tmp]) fs.mkdirSync(item, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      stdio: "ignore",
    })
  git("init", "-q", "-b", "main")
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n")
  git("add", ".")
  git("commit", "-q", "-m", "init")
  git("checkout", "-q", "-b", "kete/job/e2e")
  const spec = path.join(dir, "spec.json")
  fs.writeFileSync(
    spec,
    JSON.stringify({
      version: 1,
      prompt: "say done",
      ...(agent === null ? {} : { agent }),
      model: "kete/test-chat",
      branch: "kete/job/e2e",
      policy: { version: 1, budget: 5, timeout: 5 },
    }),
  )
  const modelsPath = path.join(dir, "models.json")
  fs.writeFileSync(modelsPath, JSON.stringify(models))
  return { dir, repo, xdg, tmp, spec, modelsPath }
}

function environment(s: ReturnType<typeof setup>, overrides: Record<string, string>) {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of Object.keys(env)) if (/^(KETE|OPENCODE|BUN_)/i.test(name) || /PROXY$/i.test(name)) delete env[name]
  delete env.XDG_RUNTIME_DIR
  return {
    ...env,
    ...runtimeOptions,
    HOME: s.xdg,
    USERPROFILE: s.xdg,
    XDG_CONFIG_HOME: path.join(s.xdg, "config"),
    XDG_DATA_HOME: path.join(s.xdg, "data"),
    XDG_CACHE_HOME: path.join(s.xdg, "cache"),
    XDG_STATE_HOME: path.join(s.xdg, "state"),
    TMPDIR: s.tmp,
    KETE_MODELS_PATH: s.modelsPath,
    KETE_DISABLE_MODELS_FETCH: "1",
    KETE_DISABLE_AUTOUPDATE: "true",
    ...overrides,
  }
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).flatMap((entry) => {
    const full = path.join(entry.parentPath, entry.name)
    return entry.isFile() ? [full] : []
  })
}

/** A named pipe standing in for the entrypoint's audit pipe: `fd` is the write end to pass as the
 * child's fd 4 (close it in the parent after spawning); `drain` collects what arrived so far. */
function auditPipe(dir: string) {
  const file = path.join(dir, "audit.fifo")
  execFileSync("mkfifo", [file])
  const reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  const fd = fs.openSync(file, fs.constants.O_WRONLY)
  const chunks: Buffer[] = []
  let closed = false
  const drain = () => {
    const buffer = Buffer.alloc(65536)
    while (!closed) {
      try {
        const count = fs.readSync(reader, buffer)
        if (count === 0) break
        chunks.push(Buffer.from(buffer.subarray(0, count)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") break
        throw error
      }
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  const timer = setInterval(drain, 50)
  return {
    fd,
    drain,
    close: () => {
      clearInterval(timer)
      drain()
      closed = true
      fs.closeSync(reader)
    },
  }
}

/** The pids whose parent is `parent` (Linux /proc; elsewhere `pgrep -P`). */
function children(parent: number): number[] {
  if (linux)
    return fs
      .readdirSync("/proc")
      .filter((name) => /^[0-9]+$/.test(name))
      .flatMap((name) => {
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8")
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
          return Number(fields[1]) === parent ? [Number(name)] : []
        } catch {
          return []
        }
      })
  const result = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" })
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map(Number)
}

/** LISTEN rows of /proc/net/tcp{,6}: `{inode, uid, port}`. */
function tcpListeners() {
  return ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((file) => {
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length > 9 && cols[3] === "0A")
      .map((cols) => ({ port: parseInt(cols[1]!.split(":")[1]!, 16), uid: Number(cols[7]), inode: cols[9]! }))
  })
}

/** Socket inodes a process holds, or `undefined` when its fd directory isn't readable. */
function socketInodes(pid: number): string[] | undefined {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))
        return match ? [match[1]!] : []
      } catch {
        return []
      }
    })
  } catch {
    return undefined
  }
}

describe.skipIf(process.platform === "win32")("kete job run in job mode, over a unix socket (AC1–AC3)", () => {
  test(
    "runs a session over the socket with the key by descriptor; no TCP listener, no secret in env or logs",
    async () => {
      const s = setup("run")
      const gateway = fakeGateway()
      const keyFile = path.join(s.dir, "key")
      fs.writeFileSync(keyFile, fdKey, { mode: 0o600 })
      const keyFd = fs.openSync(keyFile, "r")
      const audit = auditPipe(s.dir)
      const uid = typeof process.getuid === "function" ? process.getuid() : -1
      const before = linux ? tcpListeners().filter((row) => row.uid === uid) : []
      const env = environment(s, {
        KETE_JOB_MODE: "1",
        KETE_JOB_MAX_OUTPUT_TOKENS: "1000",
        KETE_JOB_GATEWAY_KEY_FD: "3",
        KETE_JOB_AUDIT_FD: "4",
        KETE_GATEWAY_URL: `http://127.0.0.1:${gateway.server.port}`,
        KETE_PLATFORM_URL: `http://127.0.0.1:${gateway.server.port}`,
        KETE_GATEWAY_KEY: envKey,
        KETE_PRINT_LOGS: "1",
        // A bogus proxy: the unix-socket client must still reach the server; the gateway is exempt.
        HTTP_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      })
      const child = Bun.spawn([...command, "job", "run", "--json", s.spec], {
        cwd: s.repo,
        env,
        stdio: ["ignore", "pipe", "pipe", keyFd, audit.fd],
      })
      fs.closeSync(keyFd)
      fs.closeSync(audit.fd)
      const stdout = new Response(child.stdout).text()
      const stderr = new Response(child.stderr).text()
      const notes: string[] = []
      if (!linux) {
        // Piece A3 (AC2): no openat2, so job mode's server refuses to start; never a fallback.
        const [out, exitCode] = await Promise.all([stdout, child.exited])
        audit.close()
        gateway.server.stop(true)
        const result = JSON.parse(out.trim().split("\n").at(-1)!)
        expect(exitCode).toBe(1)
        expect(result.outcome).toBe("error")
        expect(result.message).toContain("can't confine its file access")
        expect(gateway.chatHeaders).toEqual([])
        return
      }
      try {
        // Sample while the model call is held.
        const ready = await Promise.race([
          gateway.holding.then(() => true),
          child.exited.then(() => false),
          Bun.sleep(90_000).then(() => false),
        ])
        if (!ready) {
          gateway.release()
          throw new Error(`the job never reached the model: ${await stderr}\n${await stdout}`)
        }

        const servers = children(child.pid).filter((pid) => {
          if (!linux) return true
          return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("--socket")
        })
        expect(servers.length).toBe(1)
        const serve = servers[0]!

        const dirs = fs.readdirSync(s.tmp).filter((name) => name.startsWith("kete-"))
        expect(dirs.length).toBe(1)
        const socketDir = path.join(s.tmp, dirs[0]!)
        const socketDirStat = fs.lstatSync(socketDir)
        expect(socketDirStat.isDirectory()).toBe(true)
        expect(socketDirStat.mode & 0o777).toBe(0o700)
        if (uid >= 0) expect(socketDirStat.uid).toBe(uid)
        expect(fs.lstatSync(path.join(socketDir, "s")).isSocket()).toBe(true)

        if (linux) {
          const cmdline = fs.readFileSync(`/proc/${serve}/cmdline`, "utf8").split("\0")
          expect(cmdline).toContain("--socket")
          expect(cmdline[cmdline.indexOf("--socket") + 1]).toBe(path.join(socketDir, "s"))
          expect(cmdline).not.toContain("--port")
          // AC3: both processes are non-dumpable. Not root: their /proc/<pid> files belong to root
          // (proc(5)). Root without CAP_SYS_PTRACE: their environ is unreadable even to root, which
          // only non-dumpable makes so. Root with CAP_SYS_PTRACE: the processes' own PR_GET_DUMPABLE
          // read-back (they refuse to start otherwise) is the evidence.
          for (const pid of [child.pid, serve]) {
            if (!root) expect(fs.statSync(`/proc/${pid}/environ`).uid).toBe(0)
            else if (!canTrace) expect(() => fs.readFileSync(`/proc/${pid}/environ`)).toThrow("EACCES")
          }
          if (canTrace) notes.push("root with CAP_SYS_PTRACE: non-dumpable shown by the processes' own read-back")
          // AC1: no TCP listener.
          const listening = tcpListeners()
          if (root) {
            const inodes = new Set(listening.map((row) => row.inode))
            for (const pid of [child.pid, serve]) {
              const held = socketInodes(pid)
              expect(held).toBeDefined()
              expect(held!.filter((inode) => inodes.has(inode))).toEqual([])
            }
            // AC2: no secret in either environ.
            if (!canTrace) notes.push("root without CAP_SYS_PTRACE: skipped the /proc/<pid>/environ check")
            // /proc/<pid>/environ is the environment the process was exec'd with: the parent's still
            // shows what this test passed it (the ignored KETE_GATEWAY_KEY), so the parent is checked
            // for the real secrets only; the server child must have inherited none of them.
            for (const pid of canTrace ? [child.pid, serve] : []) {
              const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8")
              expect(environ).not.toContain(fdKey)
              expect(environ).not.toMatch(/(^|\0)(KETE|OPENCODE)_(PASSWORD|SERVER_PASSWORD)=/)
              if (pid === serve) {
                expect(environ).not.toContain(envKey)
                expect(environ).not.toMatch(/(^|\0)(KETE|OPENCODE)_GATEWAY_KEY=/)
                expect(environ).not.toMatch(/(^|\0)(KETE|OPENCODE)_JOB_GATEWAY_KEY_FD=/)
              }
            }
          } else {
            const ours = listening.filter((row) => row.uid === uid && row.port !== gateway.server.port)
            const known = new Set(before.map((row) => row.inode))
            expect(ours.filter((row) => !known.has(row.inode))).toEqual([])
            notes.push("not root: skipped the /proc/<pid>/environ and /proc/<pid>/fd checks")
          }
        } else if (process.platform === "darwin") {
          for (const pid of [child.pid, serve]) {
            const lsof = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" })
            expect(lsof.stdout.trim()).toBe("")
          }
        }
      } finally {
        gateway.release()
      }

      const exitCode = await child.exited
      const out = await stdout
      const err = await stderr
      audit.close()
      const auditText = audit.drain()
      gateway.server.stop(true)
      if (notes.length) console.log(notes.join("\n"))

      const result = JSON.parse(out.trim().split("\n").at(-1)!)
      if (result.outcome !== "completed") throw new Error(`job outcome ${result.outcome}: ${result.message}\n${err}`)
      expect(exitCode).toBe(0)
      expect(result.session_id).toMatch(/^ses_/)

      // The gateway saw the descriptor key, never the environment key.
      expect(gateway.authorizations).toContain(`Bearer ${fdKey}`)
      expect(gateway.authorizations.some((value) => value.includes(envKey))).toBe(false)
      // Piece A2: the managed agent came from a sync with the descriptor key, and its model call
      // carries the agent's id and version.
      expect(gateway.syncAuthorizations.length).toBeGreaterThan(0)
      expect(gateway.syncAuthorizations.every((value) => value === `Bearer ${fdKey}`)).toBe(true)
      expect(gateway.chatHeaders.length).toBeGreaterThan(0)
      expect(gateway.chatHeaders[0]!.get("x-kete-agent-id")).toBe(developer.id)
      expect(gateway.chatHeaders[0]!.get("x-kete-agent-version")).toBe("3")

      // AC2: the key in no output or file the run left behind.
      expect(out).not.toContain(fdKey)
      expect(err).not.toContain(fdKey)
      for (const file of [...filesUnder(s.xdg), ...filesUnder(s.tmp)])
        expect(fs.readFileSync(file).includes(fdKey)).toBe(false)

      // Piece A3 (AC3): the audit came through the pipe, and no audit file was written.
      const auditTypes = auditText
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; event?: string; root_id: string })
      expect(auditTypes[0]).toMatchObject({ type: "run", event: "started", root_id: result.session_id })
      expect(auditTypes.at(-1)).toMatchObject({ type: "run", event: "ended", root_id: result.session_id })
      expect(auditText).not.toContain(fdKey)
      expect(fs.existsSync(path.join(s.xdg, "data", "kete", "audit"))).toBe(false)
      expect(filesUnder(s.xdg).filter((file) => file.endsWith(".jsonl") && file.includes(`${path.sep}audit${path.sep}`))).toEqual([])
      expect(result.audit_log).toBeUndefined()
      expect(result.audit_local).toBe(true)

      // The socket directory is removed after the run.
      expect(fs.readdirSync(s.tmp).filter((name) => name.startsWith("kete-"))).toEqual([])
    },
    120_000,
  )

  test("an environment key alone is ignored: refused, exit 2", async () => {
    const s = setup("refused")
    const child = Bun.spawn([...command, "job", "run", "--json", s.spec], {
      cwd: s.repo,
      env: environment(s, {
        KETE_JOB_MODE: "1",
        KETE_JOB_MAX_OUTPUT_TOKENS: "1000",
        KETE_GATEWAY_URL: "http://127.0.0.1:9",
        KETE_GATEWAY_KEY: envKey,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    })
    const [out, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(2)
    const result = JSON.parse(out.trim())
    expect(result.outcome).toBe("refused")
    expect(result.message).toContain("KETE_JOB_GATEWAY_KEY_FD")
    expect(out).not.toContain(envKey)
  }, 60_000)
})

describe.skipIf(process.platform === "win32")("kete job run's first sync (piece A2)", () => {
  /** Runs the job to its result with the key on fd 3; nothing is expected to reach the model. */
  async function runRefused(name: string, gateway: ReturnType<typeof fakeGateway>, agent: string | null) {
    const s = setup(name, agent)
    const keyFile = path.join(s.dir, "key")
    fs.writeFileSync(keyFile, fdKey, { mode: 0o600 })
    const keyFd = fs.openSync(keyFile, "r")
    const audit = auditPipe(s.dir)
    const child = Bun.spawn([...command, "job", "run", "--json", s.spec], {
      cwd: s.repo,
      env: environment(s, {
        KETE_JOB_MODE: "1",
        KETE_JOB_MAX_OUTPUT_TOKENS: "1000",
        KETE_JOB_GATEWAY_KEY_FD: "3",
        KETE_JOB_AUDIT_FD: "4",
        KETE_GATEWAY_URL: `http://127.0.0.1:${gateway.server.port}`,
        KETE_PLATFORM_URL: `http://127.0.0.1:${gateway.server.port}`,
      }),
      stdio: ["ignore", "pipe", "pipe", keyFd, audit.fd],
    })
    fs.closeSync(keyFd)
    fs.closeSync(audit.fd)
    const [out, err, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    gateway.server.stop(true)
    audit.close()
    // No server was started: no socket directory, no chat request, no audit line.
    expect(audit.drain()).toBe("")
    expect(fs.readdirSync(s.tmp).filter((item) => item.startsWith("kete-"))).toEqual([])
    expect(gateway.chatHeaders).toEqual([])
    expect(out).not.toContain(fdKey)
    expect(err).not.toContain(fdKey)
    return { result: JSON.parse(out.trim().split("\n").at(-1)!), exitCode }
  }

  test("a platform that refuses the job's key is an error, exit 1", async () => {
    const gateway = fakeGateway({ sync: "unauthorized" })
    const { result, exitCode } = await runRefused("sync-401", gateway, "developer")
    expect(exitCode).toBe(1)
    expect(result.outcome).toBe("error")
    expect(result.message).toContain("refused the job's key")
    expect(gateway.syncAuthorizations).toEqual([`Bearer ${fdKey}`])
  }, 90_000)

  test("a spec.agent the platform did not sync is refused, exit 2", async () => {
    const { result, exitCode } = await runRefused("sync-unknown", fakeGateway(), "ghost")
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("refused")
    expect(result.message).toContain('spec.agent "ghost" is not among')
  }, 90_000)

  test("a spec without an agent is refused, exit 2", async () => {
    const { result, exitCode } = await runRefused("sync-no-agent", fakeGateway(), null)
    expect(exitCode).toBe(2)
    expect(result.outcome).toBe("refused")
    expect(result.message).toContain("must name an `agent`")
  }, 90_000)
})

describe.skipIf(process.platform === "win32")("kete serve outside job mode (AC5, D1)", () => {
  test("--socket is refused", async () => {
    const s = setup("serve")
    const child = Bun.spawn([...command, "serve", "--stdio", "--socket", path.join(s.tmp, "s")], {
      cwd: s.repo,
      env: environment(s, {}),
      stdio: ["pipe", "pipe", "pipe"],
    })
    const [out, err, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).not.toBe(0)
    expect(err).toContain("--socket is only available in job mode")
    expect(out).not.toContain("url")
    expect(fs.existsSync(path.join(s.tmp, "s"))).toBe(false)
  }, 60_000)
})
