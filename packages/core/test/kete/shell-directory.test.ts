import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { KeteShellDirectory } from "@opencode/core/kete/shell-directory"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
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
  })

  for (const portable of [false, true])
    test(`${portable ? "portable" : "legacy"} scanner: cd inside compound syntax reaches the directory check`, async () => {
      for (const command of ["cd; cat Documents/x", "(cd; cat Documents/x)", "{ cd; cat Documents/x; }", "if true; then cd; fi; cat x", "for d in x; do cd; done", "! cd", "x=$(cd; pwd)", "f() { cd; }; f", "true && cd"]) {
        const result = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/w", { portable }))
        expect([command, result.directories]).toEqual([command, [os.homedir()]])
      }
      for (const command of ["cd -", "cd ~+", "cd \"$OLDPWD\"", "pushd +1"]) {
        const result = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/w", { portable }))
        expect([command, result.directories.includes(root)]).toEqual([command, true])
      }
    })
})

describe("realTarget", () => {
  test("resolves through the deepest existing parent", async () => {
    const files = {
      existsSafe: (value: string) => Effect.succeed(value === "/w" || value === "/w/cfg"),
      resolve: (value: string) => Effect.succeed(value === "/w/cfg" ? "/w/.git" : value),
    }
    expect(await Effect.runPromise(KetePermissionMode.realTarget(files, "/w", "cfg/hooks/pre-commit"))).toBe(".git/hooks/pre-commit")
    expect(await Effect.runPromise(KetePermissionMode.realTarget(files, "/w", "src/a.ts"))).toBe("src/a.ts")
  })
})
