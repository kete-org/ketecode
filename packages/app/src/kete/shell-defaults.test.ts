import { describe, expect, test } from "bun:test"
import { keteDefaultTabLayout } from "./shell-defaults"

describe("keteDefaultTabLayout", () => {
  test("is vertical outside an editor host", () => {
    expect(keteDefaultTabLayout(undefined)).toBe("vertical")
  })
  test("stays horizontal in the VS Code and JetBrains webviews", () => {
    expect(keteDefaultTabLayout("vscode")).toBe("horizontal")
    expect(keteDefaultTabLayout("jetbrains")).toBe("horizontal")
  })
})
