// A confined root over the in-memory kernel (util/test/kete/fixture/fake-syscalls.ts), for server
// tests that build a job-mode server where real openat2 isn't available (macOS) or isn't the
// subject. Its tree starts empty: in-process reads of the working tree find nothing, so tests that
// need real files use the Linux-only wiring test with the real syscalls instead.
import { realpathSync } from "node:fs"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { makeFake } from "../../../util/test/kete/fixture/fake-syscalls"
import type { KeteJobServer } from "../../src/kete/job-server"

export function fakeConfine(directory: string): KeteJobServer.Confine {
  return () => {
    const real = realpathSync(directory)
    return KeteConfinedFs.open(real, makeFake({ rootPath: real }).sys, "linux")
  }
}
