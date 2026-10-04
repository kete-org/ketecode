// Replaces the upstream `upgrade` handler (ADR 0009). `kete upgrade [version]` installs the latest
// (or the given) public release over a directly installed binary, verified by ./updater.ts: signed
// SHA256SUMS (pinned Ed25519 key), archive checksum, no downgrade. Homebrew, npm and extension installs
// are told how they update instead; nothing here runs a package manager.
import { intro, log, outro, spinner } from "@clack/prompts"
import { Brand } from "@opencode/util/kete/brand"
import { Effect, Option } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { Updater } from "../services/updater"
import { handlePromptErrors } from "../ui/prompt"
import { OPENCODE_VERSION } from "../version"
import { ReleaseVerify } from "./release-verify"
import { KeteUpdater } from "./updater"

export default Runtime.handler(
  Commands.commands.upgrade,
  Effect.fn("cli.upgrade")(
    function* (input) {
      intro("Upgrade")
      const updater = yield* Updater.Service
      const detected = yield* updater.method()
      // --method is upstream's flag; here it can only confirm how this binary was installed.
      const requested = Option.getOrUndefined(input.method)
      const family = (method: string | undefined) => (method === "curl" || method === "brew" ? method : method && "npm")
      if (requested !== undefined && family(requested) !== family(detected))
        return yield* Effect.fail(
          new Error(
            `This ${Brand.cliName} wasn't installed with ${requested}; run \`${Brand.cliName} upgrade\` without --method.`,
          ),
        )
      // Homebrew, npm, the extension's copy or a source build: say how it updates, change nothing.
      if (detected === "brew") return yield* Effect.fail(new Error(KeteUpdater.managed.homebrew))
      if (detected !== "curl") {
        if (detected !== undefined) return yield* Effect.fail(new Error(KeteUpdater.managed.npm))
        const result = yield* updater.check()
        return yield* Effect.fail(
          new Error(result?.type === "unavailable" ? result.message : KeteUpdater.managed.source),
        )
      }

      const target = Option.getOrUndefined(input.target)?.trim().replace(/^v/, "") ?? (yield* updater.latest())
      if (!ReleaseVerify.isVersion(target)) return yield* Effect.fail(new Error(`Not a release version: ${target}`))
      const order = ReleaseVerify.compareVersions(target, OPENCODE_VERSION)
      if (order === 0) {
        log.info(`${Brand.displayName} ${target} is already installed.`)
        outro("Done")
        return
      }
      if (order < 0 && Option.isNone(input.target)) {
        log.info(`${Brand.displayName} ${OPENCODE_VERSION} is newer than the latest release (${target}).`)
        outro("Done")
        return
      }
      // The updater refuses downgrades too; saying so here avoids a download-and-fail spinner.
      if (order < 0)
        return yield* Effect.fail(
          new Error(
            `Refusing to downgrade from ${OPENCODE_VERSION} to ${target}. To install an older version, use the install script with --version.`,
          ),
        )

      log.info(`From ${OPENCODE_VERSION} → ${target}`)
      const progress = spinner()
      progress.start("Downloading and verifying...")
      yield* updater.upgrade("curl", target).pipe(
        Effect.tap(() => Effect.sync(() => progress.stop(`Installed ${Brand.displayName} ${target}`))),
        Effect.tapCause(() => Effect.sync(() => progress.stop("Upgrade failed", 1))),
      )
      outro("Done")
    },
    // Same user-facing error format as the upstream handlers: message only, exit code 1.
    handlePromptErrors,
  ),
)
