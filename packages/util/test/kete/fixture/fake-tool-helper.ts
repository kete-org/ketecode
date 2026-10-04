// A TS fake of the root helper (packages/kete-root-helper/README.md "Protocol v1"), for testing
// `tool-helper.ts`'s client against the wire protocol without the real Go binary, root, or a
// Linux cgroup. Listens on a real unix socket and speaks protocol v1 for real; spawns locally
// with `node:child_process` as the current (test) user — there is no privilege drop here, this is
// a test double, not a security boundary. Records every SPAWN request and supports configurable
// errors/delays for the edge cases job-mode's client tests exercise.

import { type ChildProcess, spawn as spawnProcess } from "node:child_process"
import net from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteToolHelperProtocol as Protocol } from "../../../src/kete/tool-helper-protocol.js"

/** "group" signals the child's whole process group (it's spawned detached); "process" only it. */
function signalChild(child: ChildProcess, signal: NodeJS.Signals, scope: "process" | "group") {
  if (child.pid === undefined) return
  try {
    if (scope === "group") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

export interface RecordedSpawn {
  readonly argv: ReadonlyArray<string>
  readonly env: ReadonlyArray<Protocol.EnvPair>
  readonly cwd: string
  readonly stdin: string
  readonly stdout: string
  readonly stderr: string
}

export interface FakeHelperOptions {
  /** Env names advertised in HELLO h→c (default: everything the fake ever receives — the client
   * still only sends what it decided to keep, so tests usually set this explicitly). */
  readonly envAllow?: ReadonlyArray<string>
  readonly maxFrame?: number
  readonly outputWindow?: number
  readonly stdinWindow?: number
  /** Protocol version to claim in HELLO h→c (default 1; set to something else to test version
   * mismatch handling). */
  readonly protocolVersion?: number
  /** Called for every SPAWN; returning an error code refuses it instead of actually spawning. */
  readonly onSpawn?: (spawn: RecordedSpawn) => { readonly code: Protocol.ErrorCode; readonly message: string } | undefined
  /** Delay (ms) before replying to HELLO — for connect-timeout tests. */
  readonly helloDelayMs?: number
  /** Delay (ms) before replying SPAWNED — for spawn-timeout tests. */
  readonly spawnDelayMs?: number
  /** Asserts credit is never exceeded; throws inside the connection handler (surfaces as the
   * connection dying) if the client ever sends more STDIN than granted, or the fake ever would
   * need to send more output than the client granted — belt and suspenders alongside the real
   * enforcement below. */
  readonly assertCreditNeverExceeded?: boolean
}

export interface FakeHelper {
  readonly socketPath: string
  readonly requests: Array<RecordedSpawn>
  /** Env names dropped by the fake's own allowlist check, for assertions on the client's filtering. */
  readonly close: () => Promise<void>
}

const defaultMaxFrame = 1024 * 1024
const defaultWindow = 262144

export async function startFakeHelper(options: FakeHelperOptions = {}): Promise<FakeHelper> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kete-fake-helper-"))
  const socketPath = path.join(dir, "helper.sock")
  const requests: Array<RecordedSpawn> = []

  const sockets = new Set<net.Socket>()
  const children = new Set<ChildProcess>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    handleConnection(socket, options, requests, children)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => resolve())
  })

  return {
    socketPath,
    requests,
    close: async () => {
      // server.close()'s callback only fires once every connection has closed on its own — for a
      // "drop the connection mid-stream" test, nothing ever does that, so force it here.
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // Also wait for every spawned child to actually be reaped — otherwise a still-exiting
      // process from this test can surface an event (and whatever it triggers) after the next
      // test has already started.
      await Promise.all(
        [...children].map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve()
                return
              }
              child.once("exit", () => resolve())
              signalChild(child, "SIGKILL", "group")
            }),
        ),
      )
      await rm(dir, { recursive: true, force: true })
    },
  }
}

function writeFrame(socket: net.Socket, type: number, body: Uint8Array): void {
  if (socket.destroyed) return
  socket.write(Buffer.from(Protocol.encodeFrame(type, body)))
}

function sendError(socket: net.Socket, code: Protocol.ErrorCode, message: string): void {
  writeFrame(socket, Protocol.Type.error, Protocol.encodeJson(Protocol.ErrorBody, { code, message }))
  socket.end()
}

function handleConnection(
  socket: net.Socket,
  options: FakeHelperOptions,
  requests: Array<RecordedSpawn>,
  children: Set<ChildProcess>,
): void {
  const maxFrame = options.maxFrame ?? defaultMaxFrame
  const outputWindow = options.outputWindow ?? defaultWindow
  const stdinWindow = options.stdinWindow ?? defaultWindow
  const decoder = new Protocol.FrameDecoder({ maxFrame })

  let stage: "hello" | "spawn" | "running" = "hello"
  let child: ChildProcess | undefined
  let stdoutCredit = 0
  let stderrCredit = 0
  let stdinGranted = 0
  let stdinConsumed = 0
  const pendingStdout: Array<Buffer> = []
  const pendingStderr: Array<Buffer> = []

  // Like the real helper's pumpOutput, EOF is sent only after every byte of that stream has
  // been flushed — never while output is still waiting for credit.
  const ended = { stdout: false, stderr: false }
  const eofSent = { stdout: false, stderr: false }
  const flushOutput = (which: "stdout" | "stderr") => {
    const pending = which === "stdout" ? pendingStdout : pendingStderr
    const type = which === "stdout" ? Protocol.Type.stdout : Protocol.Type.stderr
    const streamId = which === "stdout" ? Protocol.streamStdout : Protocol.streamStderr
    const maybeEof = () => {
      if (pending.length === 0 && ended[which] && !eofSent[which]) {
        eofSent[which] = true
        writeFrame(socket, Protocol.Type.eof, Protocol.encodeEOF(streamId))
      }
    }
    while (pending.length > 0) {
      const credit = which === "stdout" ? stdoutCredit : stderrCredit
      if (credit <= 0) return
      const chunk = pending[0]!
      const take = Math.min(chunk.length, credit, Protocol.dataFrameMax)
      if (take <= 0) return
      writeFrame(socket, type, chunk.subarray(0, take))
      if (which === "stdout") stdoutCredit -= take
      else stderrCredit -= take
      if (take === chunk.length) pending.shift()
      else pending[0] = chunk.subarray(take)
    }
    maybeEof()
  }

  socket.on("data", (chunk: Buffer) => {
    let frames
    try {
      frames = decoder.push(chunk)
    } catch {
      sendError(socket, "too_large", "frame exceeds the limit")
      return
    }
    for (const frame of frames) {
      if (stage === "hello") {
        if (frame.type !== Protocol.Type.helloC2H) {
          sendError(socket, "bad_request", "expected HELLO")
          return
        }
        const hello = Protocol.decodeJson(Protocol.HelloC2H, frame.body)
        const reply = () => {
          if (hello.protocol !== (options.protocolVersion ?? Protocol.protocolVersion) && options.protocolVersion !== undefined) {
            sendError(socket, "version", `fake helper speaks protocol ${options.protocolVersion}`)
            return
          }
          writeFrame(
            socket,
            Protocol.Type.helloH2C,
            Protocol.encodeJson(Protocol.HelloH2C, {
              protocol: options.protocolVersion ?? Protocol.protocolVersion,
              maxFrame,
              dataChunk: Protocol.dataFrameMax,
              stdinWindow,
              outputWindow,
              env: [...(options.envAllow ?? [])],
            }),
          )
          stage = "spawn"
        }
        if (options.helloDelayMs) setTimeout(reply, options.helloDelayMs)
        else reply()
        continue
      }
      if (stage === "spawn") {
        if (frame.type !== Protocol.Type.spawn) {
          sendError(socket, "bad_request", "expected SPAWN")
          return
        }
        const spawnMsg = Protocol.decodeJson(Protocol.Spawn, frame.body)
        const recorded: RecordedSpawn = { ...spawnMsg }
        requests.push(recorded)

        const refusal = options.onSpawn?.(recorded)
        const doSpawn = () => {
          if (refusal) {
            sendError(socket, refusal.code, refusal.message)
            return
          }
          const env: Record<string, string> = {}
          for (const [name, value] of spawnMsg.env) env[name] = value
          const [command, ...args] = spawnMsg.argv
          try {
            child = spawnProcess(command!, args, {
              cwd: spawnMsg.cwd,
              env,
              // Its own process group, so a "group" KILL reaches every descendant — the real helper
              // kills the spawn's whole cgroup (README, KILL).
              detached: true,
              stdio: [spawnMsg.stdin === "pipe" ? "pipe" : "ignore", spawnMsg.stdout === "pipe" ? "pipe" : "ignore", spawnMsg.stderr === "pipe" ? "pipe" : "ignore"],
            })
          } catch (error) {
            sendError(socket, "not_found", error instanceof Error ? error.message : String(error))
            return
          }
          const id = "p1"
          stage = "running"
          children.add(child)

          const proceedSpawned = () => {
            writeFrame(socket, Protocol.Type.spawned, Protocol.encodeJson(Protocol.Spawned, { pid: child!.pid ?? 0, id }))
            if (spawnMsg.stdin === "pipe") {
              stdinGranted = stdinWindow
              writeFrame(socket, Protocol.Type.stdinCredit, Protocol.encodeStdinCredit(stdinWindow))
            }
          }
          if (options.spawnDelayMs) setTimeout(proceedSpawned, options.spawnDelayMs)
          else proceedSpawned()

          const proc = child
          proc.stdout?.on("data", (data: Buffer) => {
            pendingStdout.push(data)
            flushOutput("stdout")
          })
          proc.stderr?.on("data", (data: Buffer) => {
            pendingStderr.push(data)
            flushOutput("stderr")
          })
          proc.stdout?.on("end", () => {
            ended.stdout = true
            flushOutput("stdout")
          })
          proc.stderr?.on("end", () => {
            ended.stderr = true
            flushOutput("stderr")
          })
          proc.on("error", () => {
            sendError(socket, "internal", "fake helper: process error")
          })
          proc.on("exit", (code, signal) => {
            children.delete(proc)
            writeFrame(socket, Protocol.Type.exit, Protocol.encodeJson(Protocol.Exit, { code: code, signal: signal }))
          })
        }
        doSpawn()
        continue
      }
      // stage === "running"
      switch (frame.type) {
        case Protocol.Type.stdin: {
          if (options.assertCreditNeverExceeded && stdinConsumed + frame.body.length > stdinGranted) {
            throw new Error("fake helper: client exceeded granted stdin credit")
          }
          stdinConsumed += frame.body.length
          child?.stdin?.write(frame.body, () => {
            // Real protocol: "initial window at SPAWNED, then as the helper writes to the pipe" —
            // without this, a client sending more than one window's worth of stdin blocks forever.
            stdinGranted += frame.body.length
            writeFrame(socket, Protocol.Type.stdinCredit, Protocol.encodeStdinCredit(frame.body.length))
          })
          break
        }
        case Protocol.Type.stdinEnd:
          child?.stdin?.end()
          break
        case Protocol.Type.credit: {
          const { stream, n } = Protocol.decodeCredit(frame.body)
          if (stream === Protocol.streamStdout) {
            stdoutCredit += n
            flushOutput("stdout")
          } else {
            stderrCredit += n
            flushOutput("stderr")
          }
          break
        }
        case Protocol.Type.kill: {
          const kill = Protocol.decodeJson(Protocol.Kill, frame.body)
          if (child) signalChild(child, kill.signal as NodeJS.Signals, kill.scope)
          break
        }
        default:
          sendError(socket, "bad_request", `unexpected frame type ${frame.type}`)
      }
    }
  })

  socket.on("close", () => {
    if (child) signalChild(child, "SIGKILL", "group")
  })
  socket.on("error", () => {
    // "close" always follows.
  })
}
