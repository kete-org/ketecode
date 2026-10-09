// A confined root over the in-memory kernel (util/test/kete/fixture/fake-syscalls.ts), for server
// tests that build a job-mode server where real openat2 isn't available (macOS) or isn't the
// subject. Its tree starts empty: in-process reads of the working tree find nothing, so tests that
// need real files use the Linux-only wiring test with the real syscalls instead.
import { realpathSync } from "node:fs"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { makeFake } from "../../../util/test/kete/fixture/fake-syscalls"
import type { KeteJobServer } from "../../src/kete/job-server"

export function fakeConfine(directory: string, files: Readonly<Record<string, string>> = {}): KeteJobServer.Confine {
  return () => {
    const real = realpathSync(directory)
    const fake = makeFake({ rootPath: real })
    // Optional root-relative files the in-process reads find (parent directories made as needed).
    for (const [rel, content] of Object.entries(files)) {
      const dir = rel.split("/").slice(0, -1).join("/")
      if (dir) fake.tree.dir(dir)
      fake.tree.file(rel, content)
    }
    return KeteConfinedFs.open(real, fake.sys, "linux")
  }
}
