import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { KeteShellDirectory } from "@opencode/core/kete/shell-directory"
import { ShellParse } from "@opencode/core/shell/parse"

const root = path.parse(process.cwd()).root

describe("KeteShellDirectory", () => {
  test("cd with no or unknown target stands for home or the filesystem root", () => {
    expect(KeteShellDirectory.implicit(["cd"], "/w")).toEqual([os.homedir()])
    expect(KeteShellDirectory.implicit(["cd", "-P"], "/w")).toEqual([os.homedir()])
    expect(KeteShellDirectory.implicit(["cd", "-"], "/w")).toEqual([path.parse("/w").root])
    expect(KeteShellDirectory.implicit(["pushd", "+1"], "/w")).toEqual([path.parse("/w").root])
    expect(KeteShellDirectory.implicit(["cd", "$OLDPWD"], "/w")).toEqual([path.parse("/w").root])
    expect(KeteShellDirectory.implicit(["cd", "sub"], "/w")).toEqual([])
    expect(KeteShellDirectory.implicit(["popd"], "/w")).toEqual([])
    // A literal `$` (single quotes, a backslash) is a folder name; an expansion in double quotes isn't known.
    expect(KeteShellDirectory.implicitText("cd '$HOME'", "/w")).toEqual([])
    expect(KeteShellDirectory.implicitText("cd ../\\$x", "/w")).toEqual([])
    expect(KeteShellDirectory.implicitText('cd "$HOME"', "/w")).toEqual([path.parse("/w").root])
    expect(KeteShellDirectory.implicitText("cd $HOME", "/w")).toEqual([path.parse("/w").root])
    expect(KeteShellDirectory.implicitText('cd "$(pwd)"', "/w")).toEqual([path.parse("/w").root])
  })

  // Upstream v2.2 removed the legacy scanner; these ran under both.
  test("cd inside compound syntax reaches the directory check", async () => {
    for (const command of [
      "cd; cat Documents/x",
      "(cd; cat Documents/x)",
      "{ cd; cat Documents/x; }",
      "if true; then cd; fi; cat x",
      "for d in x; do cd; done",
      "! cd",
      "x=$(cd; pwd)",
      "f() { cd; }; f",
      "true && cd",
    ]) {
      const result = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/w"))
      expect([command, result.directories]).toEqual([command, [os.homedir()]])
    }
    for (const command of ["cd -", "cd ~+", 'cd "$OLDPWD"', "pushd +1"]) {
      const result = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/w"))
      expect([command, result.directories.includes(root)]).toEqual([command, true])
    }
  })
})

describe("PR #20 follow-up: cd targets that can't be known", () => {
  test("the shell scanner", async () => {
    for (const command of [
      "if :; then cd {~,}; fi; cat Documents/x",
      "{ cd ~root; }",
      "cd .?",
      "cd s*",
      "CDPATH=/ cd etc",
      "cd ~+/x",
    ]) {
      const result = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/w"))
      expect([command, result.directories.includes(root)]).toEqual([command, true])
    }
    for (const command of ["cd sub", "cd ~/x", "cd 'a{b,c}'", "cd '~root'", "x=1 cd sub"]) {
      const result = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/w"))
      expect([command, result.directories.includes(root)]).toEqual([command, false])
    }
  })

  test("PowerShell Set-Location with no path or `-` ", async () => {
    for (const command of ["Set-Location", "Set-Location -", "Push-Location"]) {
      const result = await Effect.runPromise(ShellParse.scan(command, "pwsh", "/w"))
      expect([command, result.directories.includes(root)]).toEqual([command, true])
    }
    const named = await Effect.runPromise(ShellParse.scan("Set-Location src", "pwsh", "/w"))
    expect(named.directories.includes(root)).toBe(false)
  })

  test("implicit and implicitPowerShell directly", () => {
    expect(KeteShellDirectory.implicit([{ value: "cd" }, { value: "x", glob: true }], "/w")).toEqual([
      path.parse("/w").root,
    ])
    expect(KeteShellDirectory.implicit(["cd", "~root"], "/w")).toEqual([path.parse("/w").root])
    expect(KeteShellDirectory.implicit(["cd", "etc"], "/w", { cdpath: true })).toEqual([path.parse("/w").root])
    expect(KeteShellDirectory.implicit(["cd", "./etc"], "/w", { cdpath: true })).toEqual([])
    expect(KeteShellDirectory.implicitPowerShell(["Set-Location"], "/w")).toEqual([path.parse("/w").root])
    expect(KeteShellDirectory.implicitPowerShell(["Set-Location", "-Path", "src"], "/w")).toEqual([])
    expect(KeteShellDirectory.implicitPowerShell(["Pop-Location"], "/w")).toEqual([])
  })
})

describe("KeteShellDirectory.implicitPowerShell parameter forms", () => {
  const cwd = "/workspace"
  test("a parameter with a colon-bound value, or a value after --, is an explicit target", () => {
    for (const words of [
      ["Set-Location", "-p:/x"],
      ["Set-Location", "-PSPath:/x"],
      ["Set-Location", "--", "-x"],
      ["Set-Location", "-/../x"],
    ])
      expect(KeteShellDirectory.implicitPowerShell(words, cwd)).toEqual([])
  })

  test("no target, or a history move, still stands for anywhere", () => {
    for (const words of [["Set-Location"], ["Set-Location", "-"], ["Set-Location", "+"], ["Set-Location", "-PassThru"]])
      expect(KeteShellDirectory.implicitPowerShell(words, cwd)).toEqual(["/"])
  })
})
