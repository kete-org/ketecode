import { app } from "electron"
import { Effect, Layer } from "effect"
import { emitIpcEvent } from "../ipc-events"
import { BackgroundService } from "../service/background-service"
import { SidecarCredentials } from "../service/sidecar-credentials"
import { getMainWindows } from "../windows"
import * as SidecarWatcher from "./sidecar-watcher"

export * as KeteSidecarSupervision from "./sidecar-supervision"

// Wraps the BackgroundService below it: its reconnect becomes single-flight (the renderer's stream retry and
// this watcher both call it), and a watcher restarts the service when it stops answering. Provide it
// directly above BackgroundService.layer.
export const layer = Layer.effect(
  BackgroundService.Service,
  Effect.gen(function* () {
    const inner = yield* BackgroundService.Service
    const reconnect = SidecarWatcher.singleFlight(inner.reconnect)
    const watcher = SidecarWatcher.make({
      connection: inner.connection,
      check: SidecarWatcher.healthy(SidecarCredentials.get, 1_500),
      // A local GET twice a second is cheap and finds a dead service within about 1 s (two failures).
      interval: 500,
      restart: reconnect,
      emit: (event) => {
        for (const win of getMainWindows()) emitIpcEvent(win.webContents, event)
      },
    })

    // shortcut: a cancelled quit leaves supervision off for the session; re-arm on `will-quit` if quits get cancellable.
    app.once("before-quit", watcher.stop)
    yield* Effect.forkScoped(watcher.run)

    return BackgroundService.Service.of({ connection: inner.connection, reconnect })
  }),
)
