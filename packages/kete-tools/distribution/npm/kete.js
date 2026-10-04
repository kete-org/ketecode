#!/usr/bin/env node
// Launcher for the @ketecode/cli npm package (ADR 0009). npm installs exactly one of the
// platform packages (@ketecode/cli-<os>-<arch>[-musl]) as an optional dependency, selected by its
// os, cpu and libc fields; this runs that package's kete binary with the same arguments, stdio and
// exit status. It downloads nothing and has no dependencies.
"use strict"

const { spawn } = require("node:child_process")
const path = require("node:path")

function isMusl() {
  if (process.platform !== "linux") return false
  try {
    const report = process.report && process.report.getReport()
    return !(report && report.header && report.header.glibcVersionRuntime)
  } catch {
    return false
  }
}

function platformPackage() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform]
  const arch = { x64: "x64", arm64: "arm64" }[process.arch]
  if (!os || !arch) return undefined
  return `@ketecode/cli-${os}-${arch}${isMusl() ? "-musl" : ""}`
}

function binary() {
  const name = platformPackage()
  if (!name) {
    console.error(`kete: Kete Code has no build for ${process.platform}-${process.arch}.`)
    process.exit(1)
  }
  try {
    const directory = path.dirname(require.resolve(`${name}/package.json`))
    return path.join(directory, "bin", process.platform === "win32" ? "kete.exe" : "kete")
  } catch {
    console.error(
      `kete: the ${name} package is missing. Reinstall with optional dependencies enabled ` +
        "(npm install -g @ketecode/cli), or use the install script: https://github.com/kete-org/kete-releases",
    )
    process.exit(1)
  }
}

const child = spawn(binary(), process.argv.slice(2), { stdio: "inherit", windowsHide: false })
const forward = ["SIGINT", "SIGTERM", "SIGHUP"]
const handlers = forward.map((signal) => {
  const handler = () => child.kill(signal)
  process.on(signal, handler)
  return [signal, handler]
})
child.on("error", (error) => {
  console.error(`kete: could not start ${error.path || "the binary"}: ${error.message}`)
  process.exit(1)
})
child.on("exit", (code, signal) => {
  for (const [name, handler] of handlers) process.off(name, handler)
  if (signal) {
    // Exit the way the binary did, so shells and scripts see the same signal.
    process.kill(process.pid, signal)
    return
  }
  process.exit(code === null ? 1 : code)
})
