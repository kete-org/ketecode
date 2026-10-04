// Stands in for `kete serve --stdio` in the server lifecycle tests. Behaviour comes from FAKE_KETE_MODE:
// - "ok": listen on a random 127.0.0.1 port, print {"url"}, require the KETE_PASSWORD per request, exit
//   when stdin closes (as the real server does).
// - "crash-after-start": as "ok", then exit with code 3 after FAKE_KETE_DELAY ms.
// - "exit-early": exit with code 2 before printing anything.
// - "hang": never print the start line.
// Each start appends a line to FAKE_KETE_LOG, so tests can count starts.
import { appendFileSync } from "node:fs"

const mode = process.env.FAKE_KETE_MODE ?? "ok"
if (process.env.FAKE_KETE_LOG) appendFileSync(process.env.FAKE_KETE_LOG, `${process.argv.slice(2).join(" ")}\n`)
if (mode === "exit-early") process.exit(2)
if (mode === "hang") setInterval(() => undefined, 1_000)
else {
  const password = process.env.KETE_PASSWORD
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      request.headers.get("authorization") === `Basic ${btoa(`opencode:${password}`)}`
        ? new Response("ok")
        : new Response("unauthorized", { status: 401 }),
  })
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }))
  process.stdin.on("end", () => process.exit(0))
  process.stdin.resume()
  if (mode === "crash-after-start") setTimeout(() => process.exit(3), Number(process.env.FAKE_KETE_DELAY ?? 50))
}
