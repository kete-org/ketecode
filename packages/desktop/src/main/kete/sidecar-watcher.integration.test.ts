import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Service } from "../../../../client/src/promise/service"
import { serviceFixture } from "../../../../client/test/fixture/service-fixture"
import { accelerate } from "../../../../client/test/fixture/service-timing"
import { SidecarCredentials } from "../service/sidecar-credentials"
import { healthy, make, type Event } from "./sidecar-watcher"

const ensure = accelerate(Service.ensure)

// A real child service answering /api/info with the fixture's Basic credential; the watcher must notice a
// SIGKILL and bring a new one up through Service.ensure.
test("a killed service is restarted and announced", async () => {
  await using fixture = await serviceFixture()
  const connect = async (): Promise<SidecarCredentials.Data> => {
    const endpoint = await ensure({ file: fixture.registration, version: "test", command: fixture.command("graceful") })
    const info = await Bun.file(fixture.registration).json()
    fixture.track(info.pid)

    if (endpoint.auth?.type !== "basic") throw new Error("fixture service has no basic auth")
    const data = { url: new URL(endpoint.url).origin, password: endpoint.auth.password }
    SidecarCredentials.set(data)

    return data
  }

  const initial = await connect()
  expect(await Effect.runPromise(healthy(SidecarCredentials.get, 1_000))).toBe(true)

  const events: Event[] = []
  const watcher = make({
    connection: Effect.void,
    check: healthy(SidecarCredentials.get, 500),
    restart: Effect.promise(connect),
    emit: (event) => events.push(event),
    interval: 200,
  })
  Effect.runFork(watcher.run)

  try {
    const { pid } = await Bun.file(fixture.registration).json()
    process.kill(pid, "SIGKILL")

    for (let attempt = 0; attempt < 250 && !events.some((event) => event._tag === "KeteSidecarReady"); attempt++)
      await Bun.sleep(20)

    expect(events.map((event) => event._tag)).toEqual(["KeteSidecarRestarting", "KeteSidecarReady"])
    expect(SidecarCredentials.get()?.url).not.toBe(initial.url)
    expect(await Effect.runPromise(healthy(SidecarCredentials.get, 1_000))).toBe(true)
  } finally {
    watcher.stop() // the loop exits at its next wake-up
  }
})
