import { expect, test } from "bun:test"
import { branchChannel } from "../../src/kete/channel"

// The TUI's storage accepts a channel only when it matches this (tui/src/context/storage.tsx).
const segment = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

test("branch names with a slash become a valid channel", () => {
  expect(branchChannel("fix/tui-brand")).toBe("fix-tui-brand")
  expect(branchChannel("feature/wave1a-hooks")).toBe("feature-wave1a-hooks")
  expect(branchChannel("upstream/v2.0.16")).toBe("upstream-v2.0.16")
})

test("plain branch names are unchanged", () => {
  expect(branchChannel("main")).toBe("main")
  expect(branchChannel("dev")).toBe("dev")
})

test("a detached checkout or an odd name still yields a usable channel", () => {
  expect(branchChannel("")).toBe("local")
  expect(branchChannel("  \n")).toBe("local")
  expect(branchChannel("/")).toBe("local")
  expect(branchChannel("..")).toBe("local")
  expect(branchChannel("-x/../y ")).toBe("x-..-y")
})

test("every result is a valid storage segment and semver prerelease part", () => {
  for (const branch of ["fix/a", "a b", "x//y", "_lead", "trail/", "über/ß", "", "release/1.2"]) {
    const channel = branchChannel(branch)
    expect(channel).toMatch(segment)
    expect(channel).not.toBe("..")
    expect(`0.0.0-${channel}-202610101200`).toMatch(/^0\.0\.0-[0-9A-Za-z.-]+$/)
  }
})
