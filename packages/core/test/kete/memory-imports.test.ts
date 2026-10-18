import { describe, expect, test } from "bun:test"
import path from "path"
import { KeteMemoryImports } from "@opencode/core/kete/memory-imports"

const home = path.resolve("/home/u")
const project = path.join(home, "proj")
const roots: KeteMemoryImports.Root[] = [
  { path: project, markdownOnly: false },
  { path: path.join(home, ".claude"), markdownOnly: true, sensitive: true },
  { path: path.join(home, ".config", "kete"), markdownOnly: true, sensitive: true },
]
const check = (real: string) => KeteMemoryImports.denied(real, roots, home)

describe("KeteMemoryImports.importTokens", () => {
  test("finds path tokens, skipping code, email and trailing punctuation", () => {
    const text = [
      "See @./a.md, and @../b.md. Also @~/c.md) and @/abs/d.md; @docs/e.md",
      "mail me@example.com or `@./inline.md` please",
      "```",
      "@./fenced.md",
      "```",
      "~~~",
      "@./tilde.md",
      "~~~",
      "@./after.md",
    ].join("\n")
    expect(KeteMemoryImports.importTokens(text)).toEqual([
      "./a.md",
      "../b.md",
      "~/c.md",
      "/abs/d.md",
      "docs/e.md",
      "./after.md",
    ])
  })

  test("target expands ~ and resolves relative to the importer", () => {
    expect(KeteMemoryImports.target("~/x.md", project, home)).toBe(path.join(home, "x.md"))
    expect(KeteMemoryImports.target("../x.md", path.join(project, "sub"), home)).toBe(path.join(project, "x.md"))
    expect(KeteMemoryImports.target("/abs/x.md", project, home)).toBe(path.resolve("/abs/x.md"))
  })
})

describe("KeteMemoryImports.denied", () => {
  test("allows project files and markdown in the user folders", () => {
    expect(check(path.join(project, "docs", "a.md"))).toBeUndefined()
    expect(check(path.join(project, "src", "a.ts"))).toBeUndefined()
    expect(check(path.join(home, ".claude", "notes.md"))).toBeUndefined()
    expect(check(path.join(home, ".config", "kete", "notes.md"))).toBeUndefined()
  })

  test("denies paths outside every root", () => {
    expect(check(path.resolve("/etc/passwd"))).toBe("outside")
    expect(check(path.resolve(project, "../../../etc/passwd"))).toBe("outside")
    expect(check(path.join(home, "other", "a.md"))).toBe("outside")
  })

  test("denies secrets", () => {
    expect(check(path.join(home, ".ssh", "id_ed25519"))).toBe("outside")
    expect(check(path.join(project, ".env.local"))).toBe("secret")
    expect(check(path.join(project, "server.pem"))).toBe("secret")
    expect(check(path.join(project, "id_rsa"))).toBe("secret")
    expect(check(path.join(project, ".npmrc"))).toBe("secret")
    expect(check(path.join(home, ".claude", ".credentials.json"))).toBe("secret")
  })

  test("denies ssh, aws and gnupg even when a root covers home", () => {
    const wide = [{ path: home, markdownOnly: false }]
    for (const dir of [".ssh", ".aws", ".gnupg"])
      expect(KeteMemoryImports.denied(path.join(home, dir, "notes.md"), wide, home)).toBe("secret")
  })

  test("only markdown in the user folders", () => {
    expect(check(path.join(home, ".config", "kete", "kete.json"))).toBe("not-markdown")
    expect(check(path.join(home, ".claude", "settings.json"))).toBe("not-markdown")
  })
})

describe("KeteMemoryImports.note", () => {
  test("names the import and the reason", () => {
    expect(KeteMemoryImports.note("@x", "outside")).toBe("(import of @x skipped: outside the allowed folders)")
  })
})

describe("KeteMemoryImports sensitive roots", () => {
  test("a project root that contains ~/.claude still can't import its non-markdown files", () => {
    const wide: KeteMemoryImports.Root[] = [
      { path: home, markdownOnly: false },
      { path: path.join(home, ".claude"), markdownOnly: true, sensitive: true },
    ]
    expect(KeteMemoryImports.denied(path.join(home, ".claude", "settings.json"), wide, home)).toBe("not-markdown")
    expect(KeteMemoryImports.denied(path.join(home, ".claude", "notes.md"), wide, home)).toBeUndefined()
  })
  test("a markdown-only outer root doesn't stop a more specific root from serving other files", () => {
    const nested: KeteMemoryImports.Root[] = [
      { path: path.join(project, "lib"), markdownOnly: false },
      { path: project, markdownOnly: true },
    ]
    expect(KeteMemoryImports.denied(path.join(project, "lib", "notes.txt"), nested, home)).toBeUndefined()
    expect(KeteMemoryImports.denied(path.join(project, "config.yml"), nested, home)).toBe("not-markdown")
  })
})
