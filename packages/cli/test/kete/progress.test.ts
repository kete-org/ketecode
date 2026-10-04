import { describe, expect, test } from "bun:test"
import { progress } from "../../src/kete/progress"

function fakeUi() {
  const calls: string[] = []
  return {
    calls,
    ui: {
      spinner: () => ({
        start: (m: string) => calls.push(`spinner.start ${m}`),
        stop: (m: string, code?: number) => calls.push(`spinner.stop ${m} ${code ?? 0}`),
      }),
      log: {
        step: (m: string) => calls.push(`step ${m}`),
        success: (m: string) => calls.push(`success ${m}`),
        error: (m: string) => calls.push(`error ${m}`),
      },
    },
  }
}

describe("progress", () => {
  test("animates on an interactive terminal", () => {
    const { calls, ui } = fakeUi()
    const p = progress(true, ui)
    p.start("Downloading")
    p.stop("Installed")
    expect(calls).toEqual(["spinner.start Downloading", "spinner.stop Installed 0"])
  })

  test("prints one line at the start and one at the end otherwise, never frames", () => {
    const { calls, ui } = fakeUi()
    const ok = progress(false, ui)
    ok.start("Downloading")
    ok.stop("Installed")
    const failed = progress(false, ui)
    failed.stop("Upgrade failed", 1)
    expect(calls).toEqual(["step Downloading", "success Installed", "error Upgrade failed"])
  })
})
