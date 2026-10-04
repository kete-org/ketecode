import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteAccount } from "../../src/kete/account.js"
import type { KeteSecretStore } from "../../src/kete/secret-store.js"
import { KeteSyncApprovals } from "../../src/kete/sync/approvals.js"
import { KeteSyncSkills } from "../../src/kete/sync/skills.js"
import { KeteSync } from "../../src/kete/sync/sync.js"

const org = "573b7e15-80c5-4db4-9e43-a8841b97f055"
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

type File = { path: string; content: string; executable?: boolean }
const skill = (slug: string, files: File[], overrides: Record<string, unknown> = {}) => ({
  id: slug === "release" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
  slug,
  name: slug,
  description: `The ${slug} skill.`,
  version: "1.0.0",
  instructions: `# ${slug}\n\nDo the ${slug} thing.`,
  requires_mcp: [],
  files: files.map((file) => ({
    path: file.path,
    size_bytes: file.content.length,
    sha256: sha(file.content),
    executable: file.executable ?? false,
  })),
  ...overrides,
})

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

/** A platform whose sync response and skill files the test controls. */
function platform() {
  const state = {
    skills: [] as ReturnType<typeof skill>[],
    contents: new Map<string, File[]>(),
    fileRequests: [] as string[],
    tamper: false,
    etag: 1,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      const match = /^\/api\/v1\/sync\/skills\/([^/]+)\/files$/.exec(url.pathname)
      if (match) {
        state.fileRequests.push(match[1]!)
        const found = state.skills.find((item) => item.id === match[1])
        const files = state.contents.get(found?.slug ?? "") ?? []
        return Response.json({
          skill: { id: match[1], slug: found?.slug ?? "x" },
          files: files.map((file) => ({
            path: file.path,
            size_bytes: file.content.length,
            sha256: sha(file.content),
            executable: file.executable ?? false,
            content: state.tamper ? `${file.content} (tampered)` : file.content,
          })),
        })
      }
      const etag = `"e${state.etag}"`
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } })
      return Response.json(
        {
          organization: { id: org, name: "Kete Labs" },
          generated_at: "2026-09-26T10:00:00Z",
          agents: [],
          mcp_servers: [],
          skills: state.skills,
        },
        { headers: { etag } },
      )
    },
  })
  cleanup.push(() => server.stop(true))
  const publish = (skills: ReturnType<typeof skill>[], contents: Record<string, File[]>) => {
    state.skills = skills
    state.contents = new Map(Object.entries(contents))
    state.etag++
  }
  return { url: `http://127.0.0.1:${server.port}`, state, publish }
}

function memoryStore(): KeteSecretStore.Store {
  const entries = new Map<string, string>()
  return {
    kind: "keychain",
    description: "test keychain",
    set: async (name, value) => void entries.set(name, value),
    get: async (name) => entries.get(name),
    remove: async (name) => void entries.delete(name),
  }
}

async function home(platformURL: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kete-skills-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { config: path.join(root, "config"), data: path.join(root, "data"), native: memoryStore() }
  await KeteAccount.save(
    options,
    {
      platform_url: platformURL,
      gateway_url: "https://gateway.example",
      organization: { id: org, name: "Kete Labs" },
      key_id: "3f1c2b7e-0000-4000-8000-000000000001",
      device_name: "test",
    },
    "kete_test_SKILLS0123456789abcd",
  )
  return options
}

const releaseFiles: File[] = [
  { path: "checklist.md", content: "- [ ] tag\n" },
  { path: "scripts/bump.sh", content: "#!/bin/sh\necho bump\n", executable: true },
]

describe("managed skills on disk", () => {
  test("writes SKILL.md and the files, verified, with scripts not executable", async () => {
    const fake = platform()
    fake.publish([skill("release", releaseFiles)], { release: releaseFiles })
    const options = await home(fake.url)
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind === "updated" && outcome.skills).toEqual({ written: ["release"], unchanged: [], removed: [], failed: [] })
    const folder = KeteSyncSkills.skillDirectory(options.config, org, "release")
    expect(folder).toBe(path.join(options.config, "managed", org, "skills", "release"))
    expect(await readFile(path.join(folder, "SKILL.md"), "utf8")).toBe("# release\n\nDo the release thing.")
    expect(await readFile(path.join(folder, "scripts", "bump.sh"), "utf8")).toBe("#!/bin/sh\necho bump\n")
    if (process.platform !== "win32")
      expect((await stat(path.join(folder, "scripts", "bump.sh"))).mode & 0o111).toBe(0)
    expect([...(await KeteSyncSkills.present(options.config, org))]).toEqual(["release"])
    // Nothing is left behind from staging.
    expect((await readdir(path.dirname(folder))).toSorted()).toEqual(["release"])
  })

  test("downloads only when files change; instructions-only changes need no request", async () => {
    const fake = platform()
    fake.publish([skill("release", releaseFiles)], { release: releaseFiles })
    const options = await home(fake.url)
    await KeteSync.sync(options)
    expect(fake.state.fileRequests).toHaveLength(1)

    // 304: nothing to do.
    const unchanged = await KeteSync.sync(options)
    expect(unchanged.kind === "unchanged" && unchanged.skills.unchanged).toEqual(["release"])
    expect(fake.state.fileRequests).toHaveLength(1)

    // New instructions, same files: rewritten without downloading.
    fake.publish([skill("release", releaseFiles, { instructions: "new", version: "1.0.1" })], { release: releaseFiles })
    await KeteSync.sync(options)
    expect(fake.state.fileRequests).toHaveLength(1)
    const folder = KeteSyncSkills.skillDirectory(options.config, org, "release")
    expect(await readFile(path.join(folder, "SKILL.md"), "utf8")).toBe("new")

    // A changed file: downloaded again.
    const changed: File[] = [{ path: "checklist.md", content: "- [ ] tag\n- [ ] notes\n" }]
    fake.publish([skill("release", changed, { version: "1.1.0" })], { release: changed })
    await KeteSync.sync(options)
    expect(fake.state.fileRequests).toHaveLength(2)
    expect(await readFile(path.join(folder, "checklist.md"), "utf8")).toBe("- [ ] tag\n- [ ] notes\n")
    await expect(stat(path.join(folder, "scripts", "bump.sh"))).rejects.toThrow()
  })

  test("a file that doesn't match its SHA-256 fails that skill and keeps the previous copy", async () => {
    const fake = platform()
    fake.publish([skill("release", releaseFiles)], { release: releaseFiles })
    const options = await home(fake.url)
    await KeteSync.sync(options)
    const changed: File[] = [{ path: "checklist.md", content: "v2\n" }]
    fake.publish([skill("release", changed, { version: "2.0.0" })], { release: changed })
    fake.state.tamper = true
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind === "updated" && outcome.skills.failed).toEqual([
      { slug: "release", error: "checklist.md does not match its SHA-256" },
    ])
    const folder = KeteSyncSkills.skillDirectory(options.config, org, "release")
    expect(await readFile(path.join(folder, "checklist.md"), "utf8")).toBe("- [ ] tag\n")

    // The next sync (a 304) retries, and succeeds once the platform sends the right bytes.
    fake.state.tamper = false
    const retried = await KeteSync.sync(options)
    expect(retried.kind === "unchanged" && retried.skills.written).toEqual(["release"])
    expect(await readFile(path.join(folder, "checklist.md"), "utf8")).toBe("v2\n")
  })

  test("paths that would leave the skill's folder are refused", async () => {
    for (const bad of ["../escape.md", "/etc/passwd", "C:\\Windows\\x.dll", "a/../../b", "a//b", "SKILL.md", ".kete-skill.json"])
      expect(KeteSyncSkills.safeRelative(bad), bad).toBeUndefined()
    expect(KeteSyncSkills.safeRelative("scripts\\bump.sh")).toBe(path.join("scripts", "bump.sh"))

    const fake = platform()
    const evil: File[] = [{ path: "../../../escape.md", content: "x" }]
    fake.publish([skill("release", evil)], { release: evil })
    const options = await home(fake.url)
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind === "updated" && outcome.skills.failed[0]?.error).toContain("unsafe file path")
    await expect(stat(path.join(options.config, "managed", "escape.md"))).rejects.toThrow()
    expect(fake.state.fileRequests).toEqual([])
  })

  test("a skill the platform stops sending is removed", async () => {
    const fake = platform()
    const plain: File[] = []
    fake.publish([skill("release", releaseFiles), skill("triage", plain)], { release: releaseFiles, triage: plain })
    const options = await home(fake.url)
    await KeteSync.sync(options)
    fake.publish([skill("triage", plain)], { triage: plain })
    const outcome = await KeteSync.sync(options)
    expect(outcome.kind === "updated" && outcome.skills.removed).toEqual(["release"])
    expect([...(await KeteSyncSkills.present(options.config, org))]).toEqual(["triage"])
  })

  test("Windows paths", () => {
    expect(KeteSyncSkills.directory("C:\\Users\\me\\.config\\kete", org, path.win32.join)).toBe(
      `C:\\Users\\me\\.config\\kete\\managed\\${org}\\skills`,
    )
  })
})

describe("stdio command approvals", () => {
  test("an approval is for the exact command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kete-approvals-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const command = "npx -y @modelcontextprotocol/server-github"
    expect(KeteSyncApprovals.approved(await KeteSyncApprovals.read(root, org), "github", command)).toBe(false)
    await KeteSyncApprovals.approve(root, org, "github", command)
    const approvals = await KeteSyncApprovals.read(root, org)
    expect(KeteSyncApprovals.approved(approvals, "github", command)).toBe(true)
    expect(KeteSyncApprovals.approved(approvals, "github", `${command} --evil`)).toBe(false)
    expect(KeteSyncApprovals.approved(approvals, "other", command)).toBe(false)
    if (process.platform !== "win32") expect((await stat(KeteSyncApprovals.file(root, org))).mode & 0o777).toBe(0o600)
  })
})
