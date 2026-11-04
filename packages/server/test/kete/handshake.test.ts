import { expect } from "bun:test"
import { KeteHandshakeRpc } from "@opencode/schema/kete/handshake"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tmpdirScoped } from "../../../core/test/fixture/tmpdir"
import { it } from "../../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../../src/routes"

it.live("kete.handshake answers with the protocol and runtime version, with no location and no project", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const context = yield* Layer.build(
      createEmbeddedRoutes({
        database: { path: ":memory:" },
        models: { fetch: false },
        config: { directory: directory.path, project: false, content: "{}" },
        fs: { filewatcher: false },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const info = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/info")))
    const version = ((yield* Effect.promise(() => info.json())) as { version: string }).version
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/rpc/kete.handshake/get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        }),
      ),
    )
    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => response.json())).toEqual({
      output: { protocol: KeteHandshakeRpc.PROTOCOL, runtime: version, modes: ["code"] },
    })
  }),
)
