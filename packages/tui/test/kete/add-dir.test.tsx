import { describe, expect, test } from "bun:test"
import { apply, mergeKeteMetadata, metadataFor, refusals, withFolders } from "../../src/kete/add-dir"

describe("TUI extra folders", () => {
  test("the new session's metadata carries the folders, or nothing", () => {
    expect(metadataFor(undefined)).toBeUndefined()
    expect(metadataFor([])).toBeUndefined()
    expect(metadataFor(["/a", "/b"])).toEqual({ "kete.dirs": ["/a", "/b"] })
  })

  test("merging with the permission mode keeps both keys", () => {
    expect(mergeKeteMetadata(undefined, undefined)).toBeUndefined()
    expect(mergeKeteMetadata({ "kete.permissionMode": "plan" }, undefined)).toEqual({ "kete.permissionMode": "plan" })
    expect(mergeKeteMetadata({ "kete.permissionMode": "plan" }, { "kete.dirs": ["/a"] })).toEqual({
      "kete.permissionMode": "plan",
      "kete.dirs": ["/a"],
    })
  })

  test("refusals list each rejected folder with its reason", () => {
    expect(
      refusals([
        { path: "../lib", real: "/lib" },
        { path: "~/.ssh", reason: "~/.ssh is or contains a folder of credentials" },
      ]),
    ).toEqual(["~/.ssh: ~/.ssh is or contains a folder of credentials"])
  })

  test("adding to a resumed session keeps other keys and existing folders, once", async () => {
    expect(withFolders({ "kete.dirs": ["/a"] }, ["/a"])).toBeUndefined()
    let metadata: Record<string, unknown> | undefined = { other: 1, "kete.dirs": ["/a"] }
    const updates: unknown[] = []
    const api = {
      session: {
        get: async () => ({ metadata }),
        update: async (input: { metadata?: Record<string, unknown> }) => {
          updates.push(input.metadata)
          metadata = input.metadata
        },
      },
    }
    await apply(api as never, "ses_1", ["/a", "/b"])
    await apply(api as never, "ses_1", ["/a", "/b"])
    expect(updates).toEqual([{ other: 1, "kete.dirs": ["/a", "/b"] }])
  })
})
