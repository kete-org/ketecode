import { expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// VS Code loads dist/extension.js on its own: every import has to be inside the bundle except
// `vscode`. A dependency that requires its own files at runtime (as jsonc-parser's UMD build does)
// breaks activation, so every command then fails with "command ... not found".
test("the bundled extension loads with only the vscode module provided", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kete-vscode-bundle-"))
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "../src/extension.ts")],
    target: "node",
    format: "cjs",
    external: ["vscode"],
    outdir: directory,
  })
  expect(result.success).toBe(true)

  mock.module("vscode", () => ({ ViewColumn: { Beside: -2 } }))
  const extension = require(path.join(directory, "extension.js"))
  expect(typeof extension.activate).toBe("function")
  expect(typeof extension.deactivate).toBe("function")
  fs.rmSync(directory, { recursive: true, force: true })
})
