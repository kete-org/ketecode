// Stand-in for `kete login --no-browser` / `kete logout` in tests (the real ones would write the
// developer's OS keychain). Run as `bun fake-login.ts <login|logout> [--no-browser]` with
// FAKE_LOGIN_CONFIG set to the directory that holds account.json.
//
// login: prints the approval URL (state + S256 code_challenge, like the real CLI) and listens on
// 127.0.0.1; a request to /cli/callback writes a file-storage account.json and exits 0. SIGTERM closes the
// listener and exits non-zero. FAKE_LOGIN_URL overrides the printed URL (to test URL validation).
// logout: removes account.json and exits 0.
import { createServer } from "node:http"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const config = process.env.FAKE_LOGIN_CONFIG
if (!config) throw new Error("FAKE_LOGIN_CONFIG is not set")
const file = path.join(config, "account.json")

if (process.argv[2] === "logout") {
  rmSync(file, { force: true })
  process.exit(0)
}

const server = createServer((request, response) => {
  if (!request.url?.startsWith("/cli/callback")) {
    response.writeHead(404).end()
    return
  }
  mkdirSync(config, { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      platform_url: "https://platform.example",
      gateway_url: "https://gateway.example",
      organization: { id: "org_1", name: "Acme" },
      key_id: "key_1",
      device_name: "test",
      storage: "file",
      created_at: new Date().toISOString(),
    }),
  )
  response.writeHead(200).end("ok", () => process.exit(0))
})
process.on("SIGTERM", () => {
  server.close()
  process.exit(1)
})
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port
  console.log("Signing in to Kete Code at https://platform.example")
  console.log()
  console.log("Open this URL in your browser:")
  console.log(
    process.env.FAKE_LOGIN_URL ??
      `http://127.0.0.1:${port}/cli/authorize?state=abc&code_challenge=xyz&code_challenge_method=S256&callback=${port}`,
  )
})
