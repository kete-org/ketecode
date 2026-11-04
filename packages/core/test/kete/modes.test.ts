import { describe, expect, test } from "bun:test"
import path from "node:path"
import { type ParseError, parse } from "jsonc-parser"

// Mode profiles (src/kete/modes): nothing reads them yet, so this only keeps them well-formed.
const directory = path.join(import.meta.dir, "../../src/kete/modes")

describe("mode profiles", () => {
  for (const id of ["code", "work"])
    test(`${id}.jsonc is valid JSONC with its own id`, async () => {
      const errors: ParseError[] = []
      const profile = parse(await Bun.file(path.join(directory, `${id}.jsonc`)).text(), errors, { allowTrailingComma: true })
      expect(errors).toEqual([])
      expect(profile.id).toBe(id)
      expect(typeof profile.name).toBe("string")
    })
})
