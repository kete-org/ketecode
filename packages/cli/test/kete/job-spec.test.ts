// AC1: a job spec that isn't valid is refused before anything starts, naming the field that's wrong.
import { describe, expect, test } from "bun:test"
import { JobSpec } from "../../src/kete/job-spec"

const specDir = "/spec-dir"

/** `realpaths` lets a test simulate a symlink: the file's *real* path differs from the path it's
 * opened at, the way a symlink inside `specDir` pointing outside it would. Every other path's real
 * path is itself. */
function deps(files: Record<string, string> = {}, realpaths: Record<string, string> = {}): JobSpec.Deps {
  return {
    stat: async (file) => {
      const content = files[file]
      if (content === undefined) throw new Error("ENOENT")
      return { size: Buffer.byteLength(content, "utf8"), isFile: () => true }
    },
    readFile: async (file) => {
      const content = files[file]
      if (content === undefined) throw new Error("ENOENT")
      return content
    },
    realpath: async (file) => realpaths[file] ?? file,
  }
}

const validPolicy = { budget: 5, timeout: 30 }

async function expectError(
  spec: unknown,
  message: string,
  files: Record<string, string> = {},
  realpaths: Record<string, string> = {},
) {
  await expect(JobSpec.parse(JSON.stringify(spec), { specDir, deps: deps(files, realpaths) })).rejects.toThrow(message)
}

describe("JobSpec.parse", () => {
  test("a minimal valid spec parses", async () => {
    const parsed = await JobSpec.parse(JSON.stringify({ version: 1, prompt: "do it", policy: validPolicy }), {
      specDir,
      deps: deps(),
    })
    expect(parsed).toEqual({
      version: 1,
      prompt: "do it",
      agent: undefined,
      model: undefined,
      policy: { version: 1, budget: 5, timeout: 30 },
      branch: undefined,
    })
  })

  test("missing policy.budget", () =>
    expectError({ version: 1, prompt: "x", policy: { timeout: 30 } }, "policy.budget: missing"))

  test("missing policy.timeout", () =>
    expectError({ version: 1, prompt: "x", policy: { budget: 5 } }, "policy.timeout: missing"))

  test("an unknown top-level field", () =>
    expectError({ version: 1, prompt: "x", policy: validPolicy, extra: true }, "extra: unknown field"))

  test("an unknown policy field", () =>
    expectError({ version: 1, prompt: "x", policy: { ...validPolicy, extra: true } }, "policy.extra: unknown field"))

  test("a bad allow rule: missing resource", () =>
    expectError(
      { version: 1, prompt: "x", policy: { ...validPolicy, allow: [{ action: "shell" }] } },
      "policy.allow[0].resource: must be a non-empty string",
    ))

  test("a question allow rule is refused", () =>
    expectError(
      { version: 1, prompt: "x", policy: { ...validPolicy, allow: [{ action: "question", resource: "*" }] } },
      "policy.allow[0].action:",
    ))

  test("a budget allow rule is refused", () =>
    expectError(
      { version: 1, prompt: "x", policy: { ...validPolicy, allow: [{ action: "budget", resource: "*" }] } },
      "policy.allow[0].action:",
    ))

  test("no prompt and no prompt_file", () =>
    expectError({ version: 1, policy: validPolicy }, "prompt: exactly one of prompt or prompt_file is required"))

  test("both prompt and prompt_file", () =>
    expectError(
      { version: 1, prompt: "x", prompt_file: "p.txt", policy: validPolicy },
      "prompt_file: exactly one of prompt or prompt_file is required",
    ))

  test("prompt_file that doesn't exist", () =>
    expectError({ version: 1, prompt_file: "missing.txt", policy: validPolicy }, "prompt_file: not found"))

  test("prompt_file over 256 KiB", () =>
    expectError({ version: 1, prompt_file: "big.txt", policy: validPolicy }, "prompt_file: too large", {
      "/spec-dir/big.txt": "x".repeat(256 * 1024 + 1),
    }))

  test("prompt_file resolves relative to the spec file's directory", async () => {
    const parsed = await JobSpec.parse(JSON.stringify({ version: 1, prompt_file: "p.txt", policy: validPolicy }), {
      specDir,
      deps: deps({ "/spec-dir/p.txt": "do the thing" }),
    })
    expect(parsed.prompt).toBe("do the thing")
  })

  test("prompt_file in a nested subdirectory is allowed", async () => {
    const parsed = await JobSpec.parse(
      JSON.stringify({ version: 1, prompt_file: "sub/dir/p.txt", policy: validPolicy }),
      { specDir, deps: deps({ "/spec-dir/sub/dir/p.txt": "nested prompt" }) },
    )
    expect(parsed.prompt).toBe("nested prompt")
  })

  test("prompt_file escaping the spec directory with .. is refused", () =>
    expectError(
      { version: 1, prompt_file: "../outside.txt", policy: validPolicy },
      "prompt_file: must be inside the job spec's directory",
      { "/outside.txt": "secret" },
    ))

  test("prompt_file as an absolute path outside the spec directory is refused", () =>
    expectError(
      { version: 1, prompt_file: "/etc/passwd", policy: validPolicy },
      "prompt_file: must be inside the job spec's directory",
      { "/etc/passwd": "root:x:0:0" },
    ))

  test("a symlink inside the spec directory pointing outside it is refused", () =>
    expectError(
      { version: 1, prompt_file: "link.txt", policy: validPolicy },
      "prompt_file: must be inside the job spec's directory",
      { "/spec-dir/link.txt": "whatever the symlink resolves to" },
      { "/spec-dir/link.txt": "/home/user/.ssh/id_rsa" },
    ))

  test("prompt_file is read at its checked real path, not the path it was named by", async () => {
    // If the read used the unresolved path, a symlink swapped after the check could redirect it.
    const parsed = await JobSpec.parse(JSON.stringify({ version: 1, prompt_file: "link.txt", policy: validPolicy }), {
      specDir,
      deps: deps(
        { "/spec-dir/link.txt": "swapped content", "/spec-dir/real/p.txt": "checked content" },
        { "/spec-dir/link.txt": "/spec-dir/real/p.txt" },
      ),
    })
    expect(parsed.prompt).toBe("checked content")
  })

  test("an empty prompt", () => expectError({ version: 1, prompt: "   ", policy: validPolicy }, "prompt: must not be empty"))

  test("a bad version", () => expectError({ version: 2, prompt: "x", policy: validPolicy }, "version: must be 1"))

  test("a bad branch name", () =>
    expectError({ version: 1, prompt: "x", policy: validPolicy, branch: "-bad" }, "branch: is not a valid git branch name"))

  test("malformed JSON", async () => {
    await expect(JobSpec.parse("{not json", { specDir, deps: deps() })).rejects.toThrow("invalid JSON")
  })

  test("a non-positive budget", () =>
    expectError({ version: 1, prompt: "x", policy: { budget: 0, timeout: 30 } }, "policy.budget: must be a number greater than 0"))

  test("a malformed model reference", () =>
    expectError({ version: 1, prompt: "x", policy: validPolicy, model: "not-a-model" }, "model:"))

  test("a valid model reference is accepted", async () => {
    const parsed = await JobSpec.parse(
      JSON.stringify({ version: 1, prompt: "x", policy: validPolicy, model: "anthropic/claude-sonnet-4-5" }),
      { specDir, deps: deps() },
    )
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5")
  })
})
