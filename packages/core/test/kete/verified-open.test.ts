// KeteVerifiedOpen.read / write open a file and prove the descriptor is the file at the real path that was
// checked; any mismatch reads, truncates and writes nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { KeteVerifiedOpen } from "@opencode/core/kete/verified-open"

let root: string
let outside: string

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-vo-in-")))
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-vo-out-")))
  await fs.writeFile(path.join(outside, "secret"), "KEY")
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8")
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))
/** What FileAccess.resolve records at check time: the real path and an existing file's identity. */
const checked = async (real: string): Promise<KeteVerifiedOpen.Entry> => {
  const info = await fs.stat(real, { bigint: true }).catch(() => undefined)
  return info?.isFile() ? { real, id: { dev: info.dev, ino: info.ino } } : { real }
}

describe("KeteVerifiedOpen", () => {
  test("an unchanged file is read (whole and ranged) and written", async () => {
    const file = path.join(root, "a.txt")
    await fs.writeFile(file, "hello world", { mode: 0o640 })
    const entry = await checked(file)
    const whole = await Effect.runPromise(KeteVerifiedOpen.read(file, entry))
    expect(text(whole.bytes)).toBe("hello world")
    expect(whole.info).toMatchObject({ type: "file", size: 11 })
    const part = await Effect.runPromise(KeteVerifiedOpen.read(file, entry, { offset: 6, length: 5 }))
    expect(text(part.bytes)).toBe("world")
    await Effect.runPromise(KeteVerifiedOpen.write(file, entry, new TextEncoder().encode("hi")))
    expect(await fs.readFile(file, "utf8")).toBe("hi")
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o640)
  })

  test("a new file (and its missing folders) is created", async () => {
    const file = path.join(root, "x", "y", "new.txt")
    await Effect.runPromise(KeteVerifiedOpen.write(file, await checked(file), new TextEncoder().encode("created")))
    expect(await fs.readFile(file, "utf8")).toBe("created")
  })

  test("a hard link inside the workspace is accepted", async () => {
    const file = path.join(root, "a.txt")
    const link = path.join(root, "b.txt")
    await fs.writeFile(file, "one")
    await fs.link(file, link)
    expect(text((await Effect.runPromise(KeteVerifiedOpen.read(link, await checked(link)))).bytes)).toBe("one")
  })

  test("a missing file is NotFound", async () => {
    const file = path.join(root, "none.txt")
    expect(await failure(KeteVerifiedOpen.read(file, await checked(file)))).toMatchObject({ _tag: "Environment.NotFound" })
  })

  test("an expected path that never matches is refused for read and write", async () => {
    const file = path.join(root, "a.txt")
    await fs.writeFile(file, "inside")
    expect(await failure(KeteVerifiedOpen.read(file, { real: "never" }))).toMatchObject({ _tag: "Environment.Failed" })
    expect(await failure(KeteVerifiedOpen.write(file, { real: "never" }, new TextEncoder().encode("x")))).toMatchObject({
      _tag: "Environment.Failed",
    })
    expect(await fs.readFile(file, "utf8")).toBe("inside")
  })

  test("a file replaced by another file at the same path after the check is refused (identity, no path lookup)", async () => {
    const file = path.join(root, "a.txt")
    await fs.writeFile(file, "checked")
    const entry = await checked(file)
    // Moved aside, not deleted: a deleted file's inode number can be reused at once (Linux), and the threat is
    // a path redirected to another existing file, which always has its own inode.
    await fs.rename(file, path.join(root, "aside.txt"))
    await fs.writeFile(file, "replacement")
    expect(await failure(KeteVerifiedOpen.read(file, entry))).toMatchObject({ _tag: "Environment.Failed" })
    expect(await failure(KeteVerifiedOpen.write(file, entry, new TextEncoder().encode("X")))).toMatchObject({ _tag: "Environment.Failed" })
    expect(await fs.readFile(file, "utf8")).toBe("replacement")
  })

  describe.skipIf(process.platform === "win32")("symlinks", () => {
    test("a file swapped for a symlink to an outside file is refused for read and write", async () => {
      const file = path.join(root, "notes.txt")
      await fs.writeFile(file, "inside")
      const entry = await checked(file)
      await fs.rm(file)
      await fs.symlink(path.join(outside, "secret"), file)
      // expected is what the check saw before the swap: the file itself
      const read = await failure(KeteVerifiedOpen.read(file, entry))
      expect(read).toMatchObject({ _tag: "Environment.Failed" })
      const write = await failure(KeteVerifiedOpen.write(file, entry, new TextEncoder().encode("OVERWRITTEN")))
      expect(write).toMatchObject({ _tag: "Environment.Failed" })
      expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe("KEY")
    })

    test("a folder swapped for a symlink to an outside folder is refused", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const file = path.join(root, "dir", "secret")
      await fs.writeFile(file, "inside")
      const entry = await checked(file)
      await fs.rm(path.join(root, "dir"), { recursive: true })
      await fs.symlink(outside, path.join(root, "dir"))
      expect(await failure(KeteVerifiedOpen.read(file, entry))).toMatchObject({ _tag: "Environment.Failed" })
      expect(await failure(KeteVerifiedOpen.write(file, entry, new TextEncoder().encode("X")))).toMatchObject({
        _tag: "Environment.Failed",
      })
      expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe("KEY")
    })

    test("a dangling link inside the workspace has its target created", async () => {
      const target = path.join(root, "later.txt")
      const link = path.join(root, "link.txt")
      await fs.symlink(target, link)
      await Effect.runPromise(KeteVerifiedOpen.write(link, await checked(target), new TextEncoder().encode("made")))
      expect(await fs.readFile(target, "utf8")).toBe("made")
    })

    test("a new file behind a dangling link that now leads outside is not written outside", async () => {
      const link = path.join(root, "link.txt")
      await fs.symlink(path.join(outside, "later.txt"), link)
      const expected = path.join(root, "link.txt.real")
      expect(await failure(KeteVerifiedOpen.write(link, await checked(expected), new TextEncoder().encode("X")))).toMatchObject({
        _tag: "Environment.Failed",
      })
      await expect(fs.stat(path.join(outside, "later.txt"))).rejects.toThrow()
      await expect(fs.stat(expected)).rejects.toThrow()
    })
  })

  test("the registry keeps the first answer and refuses a conflicting second one", async () => {
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const file = path.join(root, "r.txt")
        const before = yield* KeteVerifiedOpen.expected(file)
        yield* KeteVerifiedOpen.record(file, "one")
        yield* KeteVerifiedOpen.record(file, "one")
        const same = yield* KeteVerifiedOpen.expected(file)
        yield* KeteVerifiedOpen.record(file, "two")
        return [before, same, yield* KeteVerifiedOpen.expected(file)]
      }).pipe(
        Effect.provideService(KeteVerifiedOpen.Expected, { paths: new Map(), changed: false }),
      ),
    )
    expect(answers[0]).toBeUndefined()
    expect(answers[1]).toEqual({ real: "one" })
    expect(answers[2]?.real).not.toBe("one")
    expect(answers[2]).not.toBeUndefined()
  })
})
