// Job mode's replacement list (D3, D4; docs/jobs.md "Job mode"): repository configuration and disk
// plugins are ignored, every process spawn goes through the real root-helper client
// (KeteToolHelper.runner, packages/util/src/kete/tool-helper.ts) when KETE_JOB_TOOL_SOCKET is set,
// else the fail-closed KeteToolRunner stub; interactive PTYs and the persistent-PTY daemon are
// refused, formatters never run, and every model HTTP request is checked and rewritten
// (kete/job-request.ts). Since piece A3, `kete`'s own in-process access to the working tree is
// confined: the root (the server's cwd, the prepared worktree) is opened once with openat2, and the
// Environment driver (core/src/kete/job-files.ts) and an FSUtil wrapper (util/src/kete/job-fs-util.ts)
// do every working-tree open beneath it with RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
// RESOLVE_NO_MAGICLINKS; file search uses ripgrep through the tool runner instead of the in-process
// fff indexer. Wired into routes.ts's `build`, after every other replacement — job mode always wins
// (the workerd profile is the precedent, server/src/workerd.ts). An invalid KETE_JOB_MODE or
// KETE_JOB_TOOL_SOCKET value, or a kernel without openat2 (or a non-Linux host), fails closed at
// server start, not silently.
//
// A pull request review job (KeteJobSecrets.review(), from `kete job run`'s secrets message) adds
// review mode's server half (jobs-v1 "Pull request review": no shell or other subprocess on the
// checkout, whose content may be a fork's): every spawn is refused (the fail-closed stub, whatever
// KETE_JOB_TOOL_SOCKET says), and the repository's AGENTS.md files are never loaded as instructions,
// neither at session start nor beside a file the agent reads. The tool and permission half is
// core/src/kete/review-mode.ts.

export * as KeteJobServer from "./job-server.js"

import { Effect, Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import { RequestExecutor } from "@opencode/ai/route"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FileSystemSearch } from "@opencode/core/filesystem/search"
import { KeteJobFiles } from "@opencode/core/kete/job-files"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Formatter } from "@opencode/core/formatter"
import { KeteJobRequest } from "@opencode/core/kete/job-request"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Pty } from "@opencode/core/pty"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { filesystem, httpClient } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import type { LayerNode } from "@opencode/util/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { KeteJobFsUtil } from "@opencode/util/kete/job-fs-util"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { KeteJobSecrets } from "@opencode/util/kete/job-secrets"
import type { KeteReview } from "@opencode/util/kete/review"
import { KeteLinuxFfi } from "@opencode/util/kete/linux-ffi"
import { KeteToolHelper } from "@opencode/util/kete/tool-helper"
import { KeteToolRunner } from "@opencode/util/kete/tool-runner"
import type { ServerOptions } from "../options.js"

const ptyLayer = Layer.succeed(
  Pty.Service,
  Pty.Service.of({
    list: () => Effect.succeed([]),
    get: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    create: () => Effect.die(new Error(KeteJobMode.message("pty"))),
    update: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    remove: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    write: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
    attach: (ptyID) => Effect.fail(new Pty.NotFoundError({ ptyID })),
  }),
)

const persistentPtyUnavailable = new PersistentPty.UnavailableError({ message: KeteJobMode.message("persistent terminal") })
const persistentPtyLayer = Layer.succeed(
  PersistentPty.Service,
  PersistentPty.Service.of({
    list: () => Effect.fail(persistentPtyUnavailable),
    get: () => Effect.fail(persistentPtyUnavailable),
    create: () => Effect.fail(persistentPtyUnavailable),
    write: () => Effect.fail(persistentPtyUnavailable),
    resize: () => Effect.fail(persistentPtyUnavailable),
    control: () => Effect.fail(persistentPtyUnavailable),
    input: () => Effect.fail(persistentPtyUnavailable),
    snapshot: () => Effect.fail(persistentPtyUnavailable),
    read: () => Effect.fail(persistentPtyUnavailable),
    remove: () => Effect.fail(persistentPtyUnavailable),
    shutdown: () => Effect.fail(persistentPtyUnavailable),
    handoff: () => Effect.fail(persistentPtyUnavailable),
    attach: () => Effect.fail(persistentPtyUnavailable),
  }),
)

// Never started, not merely refused: the plugin-based ConfigFormatterPlugin never gets a chance to
// register a formatter, since ConfigPluginSource is empty and project config is ignored — this
// covers the built-in defaults too.
const formatterLayer = Layer.succeed(
  Formatter.Service,
  Formatter.Service.of({
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
    file: () => Effect.succeed(false),
  }),
)

const webSocketConstructorLayer = Layer.succeed(Socket.WebSocketConstructor, () => {
  throw new Error(KeteJobMode.message("websocket"))
})

/** Opens the working tree's root for confined access (KeteConfinedFs.open over the real
 * syscalls); throws when that isn't possible. Tests pass their own. */
export type Confine = (root: string) => KeteConfinedFs.Root

export const confineReal: Confine = (root) => KeteConfinedFs.open(root, KeteLinuxFfi.linux())

/** `[]` when job mode is off. Throws when `KETE_JOB_MODE` is set but not `"1"`, when
 * `KETE_JOB_TOOL_SOCKET` is set but isn't an absolute path, or when the working tree (cwd) can't be
 * opened for confined access (no openat2, not Linux), so the server stops at boot rather than
 * silently running unrestricted, unisolated or unconfined. `env` is read for
 * `KETE_JOB_TOOL_SOCKET` only (via its bridged `OPENCODE_` name); `mode` still comes from the
 * caller, as before. `review` (default: the job's, KeteJobSecrets.review()) adds review mode's
 * replacements (reviewReplacements). */
export function replacements(
  options: Pick<ServerOptions, "config">,
  mode: KeteJobMode.Flag = KeteJobMode.read(),
  env: KeteJobMode.Environment = process.env,
  confine: Confine = confineReal,
  review: KeteReview.Spec | undefined = KeteJobSecrets.review(),
): LayerNode.Replacements {
  if (mode.kind === "off") return []
  if (mode.kind === "invalid") throw new Error(`${KeteJobMode.publicName} must be "1" or unset (got "${mode.value}")`)

  const socket = KeteJobMode.toolSocket(env)
  if (socket.kind === "invalid")
    throw new Error(`${KeteJobMode.toolSocketPublicName} must be an absolute path (got "${socket.value}")`)
  // Review mode: nothing spawns, not even through the helper (the entrypoint gives kete no socket
  // for a review job either, internal/entry KeteEnvList).
  const toolRunner =
    socket.kind === "path" && review === undefined
      ? KeteToolHelper.runner({ socket: socket.path })
      : KeteToolRunner.unavailable

  // The prepared worktree is the server's cwd (contracts.md §6d); never a fallback to plain open.
  const root = confine(process.cwd())

  const limits: KeteJobRequest.Limits = { maxOutputTokens: KeteJobMode.maxOutputTokens() }
  return [
    Config.node.replace(
      Config.configured({ project: false, file: options.config?.file, content: options.config?.content }),
    ),
    ConfigPluginSource.node.replace(ConfigPluginSource.empty),
    CrossSpawnSpawner.node.replace(KeteToolRunner.layer(toolRunner)),
    Pty.node.replace(ptyLayer),
    PersistentPty.node.replace(persistentPtyLayer),
    Formatter.node.replace(formatterLayer),
    LayerNodePlatform.requestExecutor.replace(
      makeGlobalNode({ service: RequestExecutor.Service, layer: KeteJobRequest.layer(limits), deps: [httpClient] }),
    ),
    LayerNodePlatform.webSocketConstructor.replace(webSocketConstructorLayer),
    // Piece A3: confined in-process access to the working tree.
    Environment.node.replace(KeteJobFiles.node(root)),
    FSUtil.node.replace(makeGlobalNode({ service: FSUtil.Service, layer: KeteJobFsUtil.layer(root), deps: [filesystem] })),
    FileSystemSearch.node.replace(FileSystemSearch.configured({ fff: false })),
    ...(review === undefined ? [] : reviewReplacements()),
  ]
}

/** Review mode's server half: the repository's AGENTS.md files are never instructions. Project
 * instruction discovery is off (routes.ts's own replacement comes first; the later one wins), and
 * the read tool's nearby-AGENTS.md injection (SessionInstructions.load) does nothing. The agent still
 * reads such a file as data when it chooses to. */
export function reviewReplacements(): LayerNode.Replacements {
  return [
    InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: false })),
    SessionInstructions.node.replace(
      Layer.succeed(SessionInstructions.Service, SessionInstructions.Service.of({ load: () => Effect.void })),
    ),
  ]
}
