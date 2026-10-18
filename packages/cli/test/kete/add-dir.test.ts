import { describe, expect, test } from "bun:test"
import path from "node:path"
import { KeteAddDirCli } from "../../src/kete/add-dir"

describe("--add-dir", () => {
  test("normalizes to absolute paths: ~ expanded, relative ones from the working directory", () => {
    const cwd = path.resolve("/work/project")
    const home = path.resolve("/home/me")
    expect(KeteAddDirCli.normalize(cwd, home, ["../lib", "~/code/x", "~", "/abs/dir"])).toEqual([
      path.resolve("/work/lib"),
      path.join(home, "code", "x"),
      home,
      path.resolve("/abs/dir"),
    ])
  })

  test("is refused in a job, before anything starts", () => {
    expect(() => KeteAddDirCli.prepare(["../lib"], { OPENCODE_JOB_MODE: "1" })).toThrow(/isn't available in a job/)
    expect(KeteAddDirCli.prepare([], { OPENCODE_JOB_MODE: "1" })).toEqual([])
    expect(KeteAddDirCli.prepare(["/abs"], {})).toEqual([path.resolve("/abs")])
  })

  test("refusals name each folder and the reason", () => {
    expect(
      KeteAddDirCli.refusals([
        { path: "a", real: "/a" },
        { path: "~/.ssh", reason: "is or contains a folder of credentials" },
        { path: "b" },
      ]),
    ).toEqual(["~/.ssh: is or contains a folder of credentials", "b: can't be added"])
  })

  test("applying keeps the session's other metadata, adds only new folders, and reads the result back", async () => {
    let metadata: Record<string, unknown> | undefined = { "kete.permissionMode": "plan", "kete.dirs": ["/a"] }
    const updates: unknown[] = []
    const sessions = {
      get: async () => ({ metadata }),
      update: async (input: { metadata?: Record<string, unknown> }) => {
        updates.push(input.metadata)
        metadata = input.metadata
      },
    }
    await KeteAddDirCli.apply(sessions as never, "ses_1", ["/a", "/b"])
    await KeteAddDirCli.apply(sessions as never, "ses_1", ["/a", "/b"])
    expect(updates).toEqual([{ "kete.permissionMode": "plan", "kete.dirs": ["/a", "/b"] }])
  })

  test("applying fails when the runtime didn't keep the folders", async () => {
    const sessions = { get: async () => ({ metadata: {} as Record<string, unknown> }), update: async () => {} }
    await expect(KeteAddDirCli.apply(sessions as never, "ses_1", ["/a"])).rejects.toThrow(/didn't keep/)
  })
})
