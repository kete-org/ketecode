import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KeteJobSecrets } from "../../src/kete/job-secrets.js"

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kete-job-secrets-"))
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

const closed = (fd: number) => {
  try {
    fs.fstatSync(fd)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EBADF"
  }
}

const file = (name: string, content: string | Uint8Array) => {
  const location = path.join(directory, name)
  fs.writeFileSync(location, content, { mode: 0o600 })
  return fs.openSync(location, "r")
}

const options = { maxBytes: 16, timeoutMs: 2_000 }

describe("KeteJobSecrets names", () => {
  test("public names", () => {
    expect(KeteJobSecrets.gatewayKeyFdPublicName).toBe("KETE_JOB_GATEWAY_KEY_FD")
    expect(KeteJobSecrets.secretsFdPublicName).toBe("KETE_JOB_SECRETS_FD")
  })
})

describe("KeteJobSecrets.parseDescriptor", () => {
  test("accepts 3..1023", () => {
    expect(KeteJobSecrets.parseDescriptor("3")).toBe(3)
    expect(KeteJobSecrets.parseDescriptor("1023")).toBe(1023)
  })

  test("refuses stdio, out-of-range and non-digit values", () => {
    for (const value of ["", "0", "1", "2", "1024", "-3", "3.0", " 3", "3 ", "0x3", "abc", "99999"])
      expect(KeteJobSecrets.parseDescriptor(value)).toBeUndefined()
  })
})

describe("KeteJobSecrets.validGatewayKey", () => {
  test("printable ASCII, 1–4096 bytes", () => {
    expect(KeteJobSecrets.validGatewayKey("kete_live_abc-123")).toBe(true)
    expect(KeteJobSecrets.validGatewayKey("x".repeat(4096))).toBe(true)
  })

  test("refuses empty, oversize and non-printable keys", () => {
    expect(KeteJobSecrets.validGatewayKey("")).toBe(false)
    expect(KeteJobSecrets.validGatewayKey("x".repeat(4097))).toBe(false)
    expect(KeteJobSecrets.validGatewayKey("key\n")).toBe(false)
    expect(KeteJobSecrets.validGatewayKey("a key")).toBe(false)
    expect(KeteJobSecrets.validGatewayKey("kéy")).toBe(false)
    expect(KeteJobSecrets.validGatewayKey("key\0")).toBe(false)
  })
})

describe("KeteJobSecrets.readDescriptor", () => {
  test("reads a regular file to EOF and closes the descriptor", async () => {
    const fd = file("ok", "secret-key")
    expect(await KeteJobSecrets.readDescriptor(fd, options)).toBe("secret-key")
    expect(closed(fd)).toBe(true)
  })

  test("reads an empty descriptor as an empty string", async () => {
    const fd = file("empty", "")
    expect(await KeteJobSecrets.readDescriptor(fd, options)).toBe("")
    expect(closed(fd)).toBe(true)
  })

  test("refuses more than maxBytes and still closes", async () => {
    const fd = file("big", "x".repeat(17))
    await expect(KeteJobSecrets.readDescriptor(fd, options)).rejects.toThrow("more than 16 bytes")
    expect(closed(fd)).toBe(true)
  })

  test("exactly maxBytes is accepted", async () => {
    const fd = file("exact", "x".repeat(16))
    expect(await KeteJobSecrets.readDescriptor(fd, options)).toBe("x".repeat(16))
  })

  test("refuses invalid UTF-8 and still closes", async () => {
    const fd = file("binary", new Uint8Array([0xff, 0xfe]))
    await expect(KeteJobSecrets.readDescriptor(fd, options)).rejects.toThrow("not valid UTF-8")
    expect(closed(fd)).toBe(true)
  })

  test("refuses a directory and closes it", async () => {
    const fd = fs.openSync(directory, "r")
    await expect(KeteJobSecrets.readDescriptor(fd, options)).rejects.toThrow("not a pipe, socket or regular file")
    expect(closed(fd)).toBe(true)
  })

  test.skipIf(process.platform === "win32")("refuses a character device and closes it", async () => {
    const fd = fs.openSync("/dev/null", "r")
    await expect(KeteJobSecrets.readDescriptor(fd, options)).rejects.toThrow("not a pipe, socket or regular file")
    expect(closed(fd)).toBe(true)
  })

  test("refuses a descriptor that isn't open", async () => {
    const fd = file("gone", "x")
    fs.closeSync(fd)
    await expect(KeteJobSecrets.readDescriptor(fd, options)).rejects.toThrow("is not open")
  })

  test.skipIf(process.platform === "win32")("reads a FIFO whose writer closed", async () => {
    const fifo = path.join(directory, "fifo-ok")
    execFileSync("mkfifo", [fifo])
    const fd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    const writer = fs.openSync(fifo, fs.constants.O_WRONLY)
    fs.writeSync(writer, "fifo-key")
    fs.closeSync(writer)
    expect(await KeteJobSecrets.readDescriptor(fd, options)).toBe("fifo-key")
    expect(closed(fd)).toBe(true)
  })

  test.skipIf(process.platform === "win32")("times out on a FIFO whose writer stays open, and closes it", async () => {
    const fifo = path.join(directory, "fifo-stuck")
    execFileSync("mkfifo", [fifo])
    // O_RDWR keeps a writer open on the same descriptor, so EOF never comes.
    const fd = fs.openSync(fifo, fs.constants.O_RDWR)
    const started = Date.now()
    await expect(KeteJobSecrets.readDescriptor(fd, { maxBytes: 16, timeoutMs: 200 })).rejects.toThrow(
      "was not closed within 200 ms",
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(closed(fd)).toBe(true)
  })

  test("error messages never include the content", async () => {
    const fd = file("leak", "top-secret-value-that-is-long")
    const error = await KeteJobSecrets.readDescriptor(fd, options).catch((caught: Error) => caught)
    expect(String(error)).not.toContain("top-secret")
  })
})

describe("KeteJobSecrets gateway key overlay", () => {
  test("refuses an invalid key, then is write-once", () => {
    expect(KeteJobSecrets.gatewayKey()).toBeUndefined()
    expect(() => KeteJobSecrets.setGatewayKey("bad key")).toThrow("printable ASCII")
    expect(KeteJobSecrets.gatewayKey()).toBeUndefined()
    KeteJobSecrets.setGatewayKey("job-key")
    expect(KeteJobSecrets.gatewayKey()).toBe("job-key")
    expect(() => KeteJobSecrets.setGatewayKey("other-key")).toThrow("already set")
    expect(KeteJobSecrets.gatewayKey()).toBe("job-key")
  })
})

describe("KeteJobSecrets organization overlay", () => {
  test("refuses anything but a GUID, then is write-once", () => {
    expect(KeteJobSecrets.organization()).toBeUndefined()
    for (const bad of ["", "../../etc", "not-a-guid"])
      expect(() => KeteJobSecrets.setOrganization(bad)).toThrow("not a valid organization id")
    expect(KeteJobSecrets.organization()).toBeUndefined()
    KeteJobSecrets.setOrganization("573b7e15-80c5-4db4-9e43-a8841b97f055")
    expect(KeteJobSecrets.organization()).toBe("573b7e15-80c5-4db4-9e43-a8841b97f055")
    expect(() => KeteJobSecrets.setOrganization("11111111-2222-4333-8444-555555555555")).toThrow("already set")
    expect(KeteJobSecrets.organization()).toBe("573b7e15-80c5-4db4-9e43-a8841b97f055")
  })
})
