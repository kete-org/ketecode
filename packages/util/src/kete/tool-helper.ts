// The real job-mode tool runner: a `KeteToolRunner.Interface` that speaks the root helper's
// protocol (packages/kete-root-helper/README.md) over a unix socket and returns a full
// `ChildProcessHandle` — the client half of the boundary `tool-helper-protocol.ts` defines and
// the Go helper implements. Wired in by `job-server.ts` when `KETE_JOB_TOOL_SOCKET` is set;
// `job-mode.ts`'s stub stays the fallback when it isn't (see tool-runner.ts).

export * as KeteToolHelper from "./tool-helper.js"

import { isArrayNonEmpty } from "effect/Array"
import { Cause, Deferred, Duration, Effect, Exit, PlatformError, Predicate, Queue, Sink, Stream } from "effect"
import type { Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ExitCode, makeHandle, ProcessId, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import net from "node:net"
import path from "node:path"
import { KeteToolHelperProtocol as Protocol } from "./tool-helper-protocol.js"
import type { Interface } from "./tool-runner.js"

export interface Options {
  readonly socket: string
  /** Max time to connect and complete the HELLO handshake. Default 5s. */
  readonly connectTimeout?: Duration.Input | undefined
  /** Max time to wait for SPAWNED or ERROR after sending SPAWN. Default 15s. */
  readonly spawnTimeout?: Duration.Input | undefined
}

const defaultConnectTimeout = Duration.seconds(5)
const defaultSpawnTimeout = Duration.seconds(15)

// Errors never carry argv or env values — only a command's basename and the helper's own message
// (which the protocol guarantees is value-free too).

function firstStandard(command: ChildProcess.Command): ChildProcess.StandardCommand {
  return command._tag === "StandardCommand" ? command : firstStandard(command.left)
}

function basename(command: ChildProcess.Command): string {
  const parts = firstStandard(command).command.split(/[\\/]/)
  return parts[parts.length - 1] || firstStandard(command).command
}

function refuse(command: ChildProcess.Command, description: string): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: "Unknown",
    module: "KeteToolHelper",
    method: "spawn",
    description: `Job tool runner refused to start \`${basename(command)}\`: ${description}`,
  })
}

function toError(err: unknown): Error {
  return err instanceof globalThis.Error ? err : new globalThis.Error(String(err))
}

const errorTag = (code: Protocol.ErrorCode): PlatformError.SystemErrorTag => {
  switch (code) {
    case "not_found":
      return "NotFound"
    case "busy":
      return "Busy"
    case "too_large":
      return "InvalidData"
    default:
      return "Unknown"
  }
}

function helperError(
  command: ChildProcess.Command,
  method: string,
  code: Protocol.ErrorCode,
  message: string,
): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: errorTag(code),
    module: "KeteToolHelper",
    method,
    description: `Job tool runner refused to start \`${basename(command)}\`: ${code}${message ? ` (${message})` : ""}`,
  })
}

function ioError(command: ChildProcess.Command, method: string, cause: unknown): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: "Unknown",
    module: "KeteToolHelper",
    method,
    description: `Job tool runner connection failed while running \`${basename(command)}\`: ${toError(cause).message}`,
    cause,
  })
}

const flatten = (command: ChildProcess.Command) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const opts: Array<ChildProcess.PipeOptions> = []
  const walk = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand":
        commands.push(cmd)
        return
      case "PipedCommand":
        walk(cmd.left)
        opts.push(cmd.options)
        walk(cmd.right)
        return
    }
  }
  walk(command)
  if (!isArrayNonEmpty(commands)) throw new Error("flatten produced empty commands array")
  return { commands, opts }
}

// --- env / stdio normalization (mirrors cross-spawn-spawner.ts's semantics) -----------------

function effectiveEnv(opts: ChildProcess.CommandOptions): Record<string, string | undefined> {
  if (opts.extendEnv) return { ...globalThis.process.env, ...opts.env }
  return opts.env ?? globalThis.process.env
}

/** Keeps only names the helper's HELLO reply allows (D6); the helper refuses any stray name too. */
function filterEnv(env: Record<string, string | undefined>, allow: ReadonlySet<string>): Array<Protocol.EnvPair> {
  const pairs: Array<Protocol.EnvPair> = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!allow.has(name)) continue
    pairs.push([name, value])
  }
  return pairs
}

type StdioMode = "pipe" | "null"

function stdinMode(opts: ChildProcess.CommandOptions): { readonly mode: StdioMode; readonly config: ChildProcess.StdinConfig } {
  const config: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
  if (Predicate.isUndefined(opts.stdin)) return { mode: "pipe", config }
  if (typeof opts.stdin === "string") {
    if (opts.stdin === "ignore") return { mode: "null", config: { ...config, stream: "ignore" } }
    if (opts.stdin === "pipe" || opts.stdin === "overlapped") return { mode: "pipe", config: { ...config, stream: opts.stdin } }
    throw new Error(`stdio "${opts.stdin}" is refused in job mode`)
  }
  if (Stream.isStream(opts.stdin)) return { mode: "pipe", config: { ...config, stream: opts.stdin } }
  const stream = opts.stdin.stream
  if (stream === "ignore") return { mode: "null", config: { ...config, ...opts.stdin } }
  if (typeof stream === "string" && stream !== "pipe" && stream !== "overlapped") throw new Error(`stdio "${stream}" is refused in job mode`)
  return {
    mode: "pipe",
    config: { stream, encoding: opts.stdin.encoding ?? config.encoding, endOnDone: opts.stdin.endOnDone ?? config.endOnDone },
  }
}

function outputMode(
  opts: ChildProcess.CommandOptions,
  key: "stdout" | "stderr",
): { readonly mode: StdioMode; readonly sink: Sink.Sink<Uint8Array, Uint8Array, never, PlatformError.PlatformError> | undefined } {
  const cfg = opts[key]
  if (Predicate.isUndefined(cfg)) return { mode: "pipe", sink: undefined }
  if (typeof cfg === "string") {
    if (cfg === "ignore") return { mode: "null", sink: undefined }
    if (cfg === "pipe" || cfg === "overlapped") return { mode: "pipe", sink: undefined }
    throw new Error(`stdio "${cfg}" is refused in job mode`)
  }
  if (Sink.isSink(cfg)) return { mode: "pipe", sink: cfg }
  throw new Error(`stdio "${String(cfg)}" is refused in job mode`)
}

// --- the connection: one socket, one decoder, one "data" listener for its whole life ----------
//
// Swapping decoders/listeners mid-stream (a separate connect phase, then a separate spawn-wait
// phase, then the session) can silently drop a frame that arrives bundled with an earlier one in
// the same chunk — Node hands over whatever the kernel gave it in one "data" event, with no
// guarantee that a frame boundary lines up with a protocol-stage boundary. A fast command's
// SPAWNED and its STDIN_CREDIT (or even EXIT, for something like `true`) can easily arrive
// together. So the whole connection — HELLO, SPAWN, and the running session — is one state
// machine over one decoder and one listener, attached once.

interface SpawnedResult {
  readonly pid: number
  readonly id: string
}

type ExitResult = { readonly code: number | null; readonly signal: string | null }

interface Session {
  readonly socket: net.Socket
  readonly helloReply: Protocol.HelloH2C
  readonly spawned: SpawnedResult
  readonly stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  readonly stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  readonly stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>
  readonly endStdin: Effect.Effect<void>
  readonly exited: Deferred.Deferred<ExitResult, PlatformError.PlatformError>
  /** Switches stdout/stderr to discard mode: incoming frames are credited and dropped instead of
   * queued (module README "the client switches to discard mode: keeps granting credit, drops
   * data"). Safe to call from outside any Effect fiber — it only flips a flag the socket's own
   * dispatch reads, never a second consumer racing the caller's own read of `stdout`/`stderr`
   * (Queue is single-consumer; a second reader would silently steal chunks from the first). */
  readonly discardOutputUnsafe: () => void
  /** Tears the connection down: marks it released (every socket listener becomes a no-op —
   * including the one this itself installs to detect the close, so a leftover chunk delivered in
   * the same tick can never be dispatched), destroys the socket, and waits for it to actually
   * close. Idempotent — safe to run more than once, always exactly-once in effect. Must only be
   * called once `exited` is settled (or the caller has given up waiting for it); it does not kill
   * anything itself. */
  readonly teardown: Effect.Effect<void>
}

function writeFrame(socket: net.Socket, type: number, body: Uint8Array): void {
  socket.write(Buffer.from(Protocol.encodeFrame(type, body)))
}

/** Splits a chunk into ≤64 KiB pieces (the data-frame cap), for both stdin sends and output reads. */
function splitChunks(data: Uint8Array): Array<Uint8Array> {
  if (data.length <= Protocol.dataFrameMax) return [data]
  const out: Array<Uint8Array> = []
  for (let offset = 0; offset < data.length; offset += Protocol.dataFrameMax) out.push(data.subarray(offset, offset + Protocol.dataFrameMax))
  return out
}

/** Connects, completes HELLO, sends SPAWN (built from the negotiated HELLO reply — env filtering
 * needs its `env` allowlist), and waits for SPAWNED. Resolves once SPAWNED arrives, with the
 * session already wired for everything after (module README "Protocol v1", "State machine"). */
function connectSpawnAndRun(
  command: ChildProcess.Command,
  socketPath: string,
  buildSpawn: (helloReply: Protocol.HelloH2C) => Protocol.Spawn,
  stdinMode: StdioMode,
  stdoutMode: StdioMode,
  stderrMode: StdioMode,
  connectTimeoutMs: number,
  spawnTimeoutMs: number,
): Effect.Effect<Session, PlatformError.PlatformError> {
  return Effect.callback<Session, PlatformError.PlatformError>((resume) => {
    const socket = net.createConnection(socketPath)
    // A generous, fixed cap: this is the client's own memory-safety limit, not the security
    // boundary — the helper is what enforces limits against a peer it can't otherwise trust.
    const decoder = new Protocol.FrameDecoder({ maxFrame: 16 * 1024 * 1024 })

    let stage: "hello" | "spawn" | "running" = "hello"
    let settled = false
    let helloReply: Protocol.HelloH2C | undefined
    // Set exactly once, by `teardown` below. Every persistent listener checks this first and
    // does nothing once it's true — a socket event (even one already queued in Node's event loop
    // before `destroy()` ran) can never reach a Deferred/Queue after the handle has been
    // released, so nothing here can construct or surface a failure for code that has already
    // stopped listening for one.
    let torndown = false

    const exited = Deferred.makeUnsafe<ExitResult, PlatformError.PlatformError>()
    const stdoutQueue = Effect.runSync(Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>())
    const stderrQueue = Effect.runSync(Queue.unbounded<Uint8Array, PlatformError.PlatformError | Cause.Done>())
    const stdinSignal = Effect.runSync(Queue.unbounded<void>())
    let stdinGranted = 0
    let stdinConsumed = 0
    let discardOutput = false

    const grantCredit = (streamId: number, n: number) => {
      if (torndown || n <= 0) return
      writeFrame(socket, Protocol.Type.credit, Protocol.encodeCredit(streamId, n))
    }

    const failConnect = (err: PlatformError.PlatformError) => {
      if (settled || torndown) return
      settled = true
      clearTimeout(handshakeTimer)
      socket.destroy()
      resume(Exit.fail(err))
    }
    const failSession = (err: PlatformError.PlatformError) => {
      if (torndown) return
      Queue.failCauseUnsafe(stdoutQueue, Cause.fail(err))
      Queue.failCauseUnsafe(stderrQueue, Cause.fail(err))
      Deferred.doneUnsafe(exited, Exit.fail(err))
      Queue.offerUnsafe(stdinSignal, undefined)
    }

    let teardownStarted = false
    // Idempotent, exactly-once: destroys the socket, removes every listener this function
    // installed (so a chunk Node already queued before `destroy()` can't reach a now-removed
    // "data" listener either), and resolves once the socket has actually finished closing.
    const teardown = Effect.callback<void>((teardownResume) => {
      if (teardownStarted) {
        teardownResume(Effect.void)
        return
      }
      teardownStarted = true
      torndown = true
      const finish = () => {
        socket.removeAllListeners("data")
        socket.removeAllListeners("close")
        socket.removeAllListeners("error")
        socket.removeAllListeners("connect")
        teardownResume(Effect.void)
      }
      if (socket.destroyed) {
        finish()
        return
      }
      socket.once("close", finish)
      socket.destroy()
      return Effect.sync(() => {
        // If this callback effect is itself interrupted while waiting, still leave the socket torn
        // down rather than resuming with a dangling "close" listener.
        socket.removeAllListeners("data")
        socket.removeAllListeners("error")
      })
    })

    const handshakeTimer = setTimeout(
      () => failConnect(ioError(command, "connect", new Error("timed out during the HELLO/SPAWN handshake"))),
      connectTimeoutMs + spawnTimeoutMs,
    )

    socket.once("connect", () => {
      if (torndown) return
      writeFrame(socket, Protocol.Type.helloC2H, Protocol.encodeJson(Protocol.HelloC2H, { protocol: Protocol.protocolVersion }))
    })

    socket.on("data", (chunk: Buffer) => {
      // A chunk Node already had queued for this listener before `teardown` ran (e.g. delivered
      // in the same tick as `destroy()`) is intentionally ignored, not processed into a failure —
      // once released, nothing this connection does is this handle's problem any more.
      if (torndown) return
      let frames
      try {
        frames = decoder.push(chunk)
      } catch (error) {
        const err = ioError(command, stage, error)
        if (stage === "running") failSession(err)
        else failConnect(err)
        return
      }
      for (const frame of frames) {
        if (stage === "hello") {
          if (frame.type === Protocol.Type.error) {
            const body = Protocol.decodeJson(Protocol.ErrorBody, frame.body)
            failConnect(helperError(command, "connect", body.code as Protocol.ErrorCode, body.message))
            return
          }
          if (frame.type !== Protocol.Type.helloH2C) {
            failConnect(ioError(command, "connect", new Error(`unexpected frame type ${frame.type} during HELLO`)))
            return
          }
          helloReply = Protocol.decodeJson(Protocol.HelloH2C, frame.body)
          if (helloReply.protocol !== Protocol.protocolVersion) {
            failConnect(helperError(command, "connect", "version", `helper speaks protocol ${helloReply.protocol}`))
            return
          }
          writeFrame(socket, Protocol.Type.spawn, Protocol.encodeJson(Protocol.Spawn, buildSpawn(helloReply)))
          stage = "spawn"
          continue
        }
        if (stage === "spawn") {
          if (frame.type === Protocol.Type.error) {
            const body = Protocol.decodeJson(Protocol.ErrorBody, frame.body)
            failConnect(helperError(command, "spawn", body.code as Protocol.ErrorCode, body.message))
            return
          }
          if (frame.type !== Protocol.Type.spawned) {
            failConnect(ioError(command, "spawn", new Error(`unexpected frame type ${frame.type} while waiting for SPAWNED`)))
            return
          }
          const spawnedBody = Protocol.decodeJson(Protocol.Spawned, frame.body)
          stage = "running"
          if (settled) continue
          settled = true
          clearTimeout(handshakeTimer)

          // Credit is granted as each element is *pulled* downstream, so an unread stream really
          // does block only itself.
          const stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError> =
            stdoutMode === "pipe"
              ? Stream.fromQueue(stdoutQueue).pipe(
                  Stream.mapEffect((c) => Effect.as(Effect.sync(() => grantCredit(Protocol.streamStdout, c.length)), c)),
                )
              : Stream.empty
          const stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError> =
            stderrMode === "pipe"
              ? Stream.fromQueue(stderrQueue).pipe(
                  Stream.mapEffect((c) => Effect.as(Effect.sync(() => grantCredit(Protocol.streamStderr, c.length)), c)),
                )
              : Stream.empty
          // The initial output credit window: without this, the helper never starts reading the
          // tool's stdout/stderr pipe at all (it "only reads a pipe while that stream has
          // credit") — symmetric to the helper granting the client an initial STDIN_CREDIT
          // window right here too.
          if (stdoutMode === "pipe") grantCredit(Protocol.streamStdout, helloReply!.outputWindow)
          if (stderrMode === "pipe") grantCredit(Protocol.streamStderr, helloReply!.outputWindow)

          const waitForStdinCredit = (need: number): Effect.Effect<number> =>
            Effect.suspend((): Effect.Effect<number> => {
              const available = stdinGranted - stdinConsumed
              if (available > 0) {
                const grant = Math.min(available, need)
                stdinConsumed += grant
                return Effect.succeed(grant)
              }
              return Effect.andThen(Queue.take(stdinSignal), waitForStdinCredit(need))
            })
          const stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> =
            stdinMode === "null"
              ? Sink.forEach(() => Effect.void)
              : Sink.forEach((c: Uint8Array) =>
                  Effect.gen(function* () {
                    for (const piece of splitChunks(c)) {
                      let remaining = piece
                      while (remaining.length > 0) {
                        const grant = yield* waitForStdinCredit(remaining.length)
                        writeFrame(socket, Protocol.Type.stdin, remaining.subarray(0, grant))
                        remaining = remaining.subarray(grant)
                      }
                    }
                  }),
                )
          const endStdin = Effect.sync(() => {
            if (stdinMode === "pipe") writeFrame(socket, Protocol.Type.stdinEnd, new Uint8Array())
          })

          resume(
            Effect.succeed({
              socket,
              helloReply: helloReply!,
              spawned: { pid: spawnedBody.pid, id: spawnedBody.id },
              stdout,
              stderr,
              stdin,
              endStdin,
              exited,
              discardOutputUnsafe: () => {
                discardOutput = true
              },
              teardown,
            }),
          )
          continue
        }
        // stage === "running"
        switch (frame.type) {
          case Protocol.Type.stdout:
            if (discardOutput) grantCredit(Protocol.streamStdout, frame.body.length)
            else Queue.offerUnsafe(stdoutQueue, frame.body)
            break
          case Protocol.Type.stderr:
            if (discardOutput) grantCredit(Protocol.streamStderr, frame.body.length)
            else Queue.offerUnsafe(stderrQueue, frame.body)
            break
          case Protocol.Type.eof: {
            const streamId = Protocol.decodeEOF(frame.body)
            if (streamId === Protocol.streamStdout) Queue.endUnsafe(stdoutQueue)
            else Queue.endUnsafe(stderrQueue)
            break
          }
          case Protocol.Type.stdinCredit:
            stdinGranted += Protocol.decodeStdinCredit(frame.body)
            Queue.offerUnsafe(stdinSignal, undefined)
            break
          case Protocol.Type.exit: {
            const body = Protocol.decodeJson(Protocol.Exit, frame.body)
            Deferred.doneUnsafe(exited, Exit.succeed({ code: body.code, signal: body.signal }))
            break
          }
          case Protocol.Type.error: {
            const body = Protocol.decodeJson(Protocol.ErrorBody, frame.body)
            failSession(helperError(command, "session", body.code as Protocol.ErrorCode, body.message))
            break
          }
        }
      }
    })

    socket.once("error", (error) => {
      if (torndown) return
      if (!settled) failConnect(ioError(command, "connect", error))
    })
    socket.once("close", () => {
      // `teardown` sets `torndown` synchronously before it ever calls `destroy()`, so by the time
      // a close it caused actually fires, this check is already true — this listener (registered
      // at connection start, so it still runs; Node calls every listener for an event, in
      // registration order) becomes a no-op for a close the handle itself asked for, and only a
      // genuinely unexpected close (the helper process died, the socket errored) reaches the
      // logic below.
      if (torndown) return
      if (!settled) {
        failConnect(ioError(command, "connect", new Error("connection closed during the handshake")))
        return
      }
      failSession(ioError(command, "session", new Error("the job tool runner connection closed")))
    })

    return Effect.sync(() => {
      clearTimeout(handshakeTimer)
      if (!settled) socket.destroy()
    })
  })
}

// --- KILL / stop ------------------------------------------------------------------------------

function sendKill(socket: net.Socket, signal: string, scope: "process" | "group"): void {
  writeFrame(socket, Protocol.Type.kill, Protocol.encodeJson(Protocol.Kill, { signal, scope }))
}

const stop = (
  command: ChildProcess.Command,
  socket: net.Socket,
  exited: Deferred.Deferred<ExitResult, PlatformError.PlatformError>,
  scope: "process" | "group",
  opts: ChildProcess.KillOptions | undefined,
) => {
  const terminate = (signal: string) =>
    Effect.gen(function* () {
      sendKill(socket, signal, scope)
      yield* Effect.ignore(Deferred.await(exited))
    })
  const attempt = terminate(opts?.killSignal ?? "SIGTERM")
  if (opts?.forceKillAfter === undefined) return attempt
  return Effect.timeoutOrElse(attempt, {
    duration: opts.forceKillAfter,
    orElse: () => terminate("SIGKILL"),
  })
}

// --- one StandardCommand stage ----------------------------------------------------------------

const spawnStandard = Effect.fnUntraced(function* (
  command: ChildProcess.StandardCommand,
  options: Options,
  argv: { readonly command: string; readonly args: ReadonlyArray<string> },
  stdinOverride: ChildProcess.StdinConfig | undefined,
) {
  const opts = command.options

  if (opts.additionalFds !== undefined && Object.keys(opts.additionalFds).length > 0) {
    return yield* Effect.fail(refuse(command, "additional file descriptors are refused in job mode"))
  }

  // stdinMode/outputMode throw a plain Error for a refused stdio config — never let that escape
  // as an uncaught defect; convert it into the same typed refusal every other check here uses.
  let sin: ReturnType<typeof stdinMode>
  let sout: ReturnType<typeof outputMode>
  let serr: ReturnType<typeof outputMode>
  try {
    sin = stdinMode(opts)
    sout = outputMode(opts, "stdout")
    serr = outputMode(opts, "stderr")
  } catch (error) {
    return yield* Effect.fail(refuse(command, error instanceof Error ? error.message : String(error)))
  }
  const effectiveStdinConfig = stdinOverride ?? sin.config

  if (opts.shell !== undefined && opts.shell !== false && typeof opts.shell === "string" && opts.shell !== "/bin/sh") {
    return yield* Effect.fail(refuse(command, `shell "${opts.shell}" is refused in job mode (only /bin/sh is allowed)`))
  }

  const cwd = path.resolve(opts.cwd ?? globalThis.process.cwd())
  const env = effectiveEnv(opts)

  // One finalizer, exactly once, in order: if the process hasn't exited, kill it and wait for
  // `exited` to actually settle (real per the protocol's EXIT frame, or `stop`'s own timeout
  // fallback) — *then* tear the connection down. Never the other way around: closing the socket
  // first would mean the KILL never reaches the helper. `session.teardown` is itself idempotent,
  // so nothing here depends on this being the *only* path that can call it.
  const session = yield* Effect.acquireRelease(
    connectSpawnAndRun(
      command,
      options.socket,
      (helloReply) => ({
        argv: [argv.command, ...argv.args],
        env: filterEnv(env, new Set(helloReply.env)),
        cwd,
        stdin: sin.mode,
        stdout: sout.mode,
        stderr: serr.mode,
      }),
      sin.mode,
      sout.mode,
      serr.mode,
      Duration.toMillis(options.connectTimeout ?? defaultConnectTimeout),
      Duration.toMillis(options.spawnTimeout ?? defaultSpawnTimeout),
    ),
    (session) =>
      Effect.gen(function* () {
        const done = yield* Deferred.isDone(session.exited)
        if (!done) {
          const scope = opts.detached === false ? "process" : "group"
          yield* Effect.ignore(stop(command, session.socket, session.exited, scope, opts))
        }
        yield* session.teardown
      }),
  )

  const stdout = sout.sink ? Stream.transduce(session.stdout, sout.sink) : session.stdout
  const stderr = serr.sink ? Stream.transduce(session.stderr, serr.sink) : session.stderr
  // STDIN_END is part of the sink's own completion, like upstream's NodeSink.fromWritable
  // `endOnDone`: it fires whenever whatever is running the sink to completion finishes — a
  // config-supplied Stream forked below, or a caller driving `handle.stdin` directly (e.g.
  // `Stream.run(callerStream, handle.stdin)`) — not only the former.
  const stdin: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> =
    effectiveStdinConfig.endOnDone === false ? session.stdin : Sink.mapEffect(session.stdin, () => session.endStdin)

  // The 1s post-exit output deadline: after EXIT, give a caller reading stdout/stderr one more
  // second, then switch to discard mode — this only flips a flag the socket's own dispatch reads
  // (never a second Queue consumer, which would race the caller's own read: module README's
  // "PipedCommand"/Queue is single-consumer).
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      yield* Effect.ignore(Deferred.await(session.exited))
      yield* Effect.sleep("1 second")
      session.discardOutputUnsafe()
    }),
  )

  if (Stream.isStream(effectiveStdinConfig.stream)) {
    yield* Effect.forkScoped(Stream.run(effectiveStdinConfig.stream, stdin))
  }

  return makeHandle({
    pid: ProcessId(session.spawned.pid),
    stdin,
    stdout,
    stderr,
    all: Stream.merge(stdout, stderr),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.map(Deferred.isDone(session.exited), (done) => !done),
    exitCode: Effect.flatMap(Deferred.await(session.exited), (result) => {
      if (Predicate.isNotNull(result.code)) return Effect.succeed(ExitCode(result.code))
      return Effect.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "KeteToolHelper",
          method: "exitCode",
          description: `Process interrupted due to receipt of signal: '${result.signal}'`,
        }),
      )
    }),
    kill: (opts?: ChildProcess.KillOptions) => stop(command, session.socket, session.exited, "group", opts),
    unref: Effect.fail(
      PlatformError.systemError({
        _tag: "Unknown",
        module: "KeteToolHelper",
        method: "unref",
        description: "unref is refused in job mode",
      }),
    ),
  })
})

// --- Command dispatch (piped commands get one connection per stage) ---------------------------

const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
  const opt = from ?? "stdout"
  switch (opt) {
    case "stdout":
      return handle.stdout
    case "stderr":
      return handle.stderr
    case "all":
      return handle.all
    default:
      return handle.stdout // an fdN target is unreachable: additionalFds is always refused.
  }
}

function shellArgv(opts: ChildProcess.CommandOptions, command: string, args: ReadonlyArray<string>) {
  if (opts.shell !== true) return { command, args }
  return { command: "/bin/sh", args: ["-c", [command, ...args].join(" ")] }
}

/** Builds the `KeteToolRunner.Interface` that speaks the root helper protocol at `options.socket`. */
export function runner(options: Options): Interface {
  const spawnCommand: (command: ChildProcess.Command) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> =
    Effect.fnUntraced(function* (command) {
      switch (command._tag) {
        case "StandardCommand": {
          const argv = shellArgv(command.options, command.command, command.args)
          return yield* spawnStandard(command, options, argv, undefined)
        }
        case "PipedCommand": {
          const flat = flatten(command)
          const [head, ...tail] = flat.commands
          let handle = spawnCommand(head)
          for (let i = 0; i < tail.length; i++) {
            const next = tail[i]!
            const opt = flat.opts[i] ?? {}
            if (opt.to !== undefined && opt.to !== "stdin") {
              return yield* Effect.fail(refuse(command, `piping to "${opt.to}" is refused in job mode`))
            }
            // `stream` embeds `handle` (the previous stage's Effect); running it — which happens
            // when the next stage's stdin sink actually consumes this stream — spawns the
            // previous stage. Don't also `yield*` `handle` directly here: Effects aren't
            // memoized, so that would spawn the previous stage a second time.
            const stream = Stream.unwrap(Effect.map(handle, (h) => source(h, opt.from)))
            const argv = shellArgv(next.options, next.command, next.args)
            const config: ChildProcess.StdinConfig = { stream, encoding: "utf-8", endOnDone: true }
            handle = spawnStandard(next, options, argv, config)
          }
          return yield* handle
        }
      }
    })

  return { spawn: spawnCommand }
}
