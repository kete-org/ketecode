// Kete-owned test fixture runner for scripts/smoke.sh: starts the fake model endpoint or the fake
// platform on 127.0.0.1, prints its URL on one line and serves until it's stopped.
import { startFakeModel } from "./fake-model"
import { startFakePlatform } from "./fake-platform"

const kind = process.argv[2]
const server =
  kind === "model"
    ? startFakeModel()
    : kind === "platform"
      ? startFakePlatform({
          statuses: ["running", "succeeded"],
          outcome: "completed",
          pushStatus: "created",
          prURL: "https://github.com/acme/shop/pull/1",
          summary: "Done.",
        })
      : undefined
if (!server) {
  console.error("usage: serve.ts model|platform")
  process.exit(2)
}
console.log(server.url)
const stop = () => {
  server.stop()
  process.exit(0)
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
