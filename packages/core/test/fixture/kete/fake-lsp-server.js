// A fake language server for the LSP tests (core/test/kete/lsp*.test.ts): speaks LSP over stdio and
// publishes one error per line containing "BAD" in every document it is given. With
// FAKE_LSP_LOG set it appends each method it receives (and its environment's variable names on
// initialize) to that file. FAKE_LSP_MODE=silent never publishes; =crash exits on initialize.
const fs = require("fs")

const log = (line) => {
  if (process.env.FAKE_LSP_LOG) fs.appendFileSync(process.env.FAKE_LSP_LOG, line + "\n")
}

let buffer = Buffer.alloc(0)
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }))
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

const publish = (uri, text) => {
  if (process.env.FAKE_LSP_MODE === "silent") return
  const diagnostics = []
  text.split("\n").forEach((line, index) => {
    const column = line.indexOf("BAD")
    if (column >= 0)
      diagnostics.push({
        range: { start: { line: index, character: column }, end: { line: index, character: column + 3 } },
        severity: 1,
        source: "fake",
        message: `bad thing: ${line.trim()}`,
      })
    const warn = line.indexOf("MEH")
    if (warn >= 0)
      diagnostics.push({
        range: { start: { line: index, character: warn }, end: { line: index, character: warn + 3 } },
        severity: 2,
        message: "a warning",
      })
  })
  // Like real servers: an early (empty) publish first, the full one shortly after.
  send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } })
  setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } }), 50)
}

const handle = (message) => {
  log(message.method ?? "response")
  if (message.method === "initialize") {
    if (process.env.FAKE_LSP_MODE === "crash") process.exit(3)
    log(
      "env:" +
        Object.keys(process.env)
          .filter((name) => !name.startsWith("FAKE_LSP_") && !name.startsWith("__CF") && name !== "PWD" && name !== "SHLVL" && name !== "_")
          .sort()
          .join(","),
    )
    send({ id: message.id, result: { capabilities: { textDocumentSync: 1 } } })
    // Ask the client something it must answer.
    send({ id: "cfg-1", method: "workspace/configuration", params: { items: [{ section: "fake" }] } })
    return
  }
  if (message.method === "textDocument/didOpen") return publish(message.params.textDocument.uri, message.params.textDocument.text)
  if (message.method === "textDocument/didChange")
    return publish(message.params.textDocument.uri, message.params.contentChanges[0].text)
  if (message.method === "shutdown") return send({ id: message.id, result: null })
  if (message.method === "exit") process.exit(0)
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end === -1) return
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())
    if (!match) process.exit(2)
    const length = Number(match[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body))
  }
})
process.stdin.on("end", () => process.exit(0))
