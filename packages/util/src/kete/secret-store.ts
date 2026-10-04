// OS-native storage for the Kete account key (CLAUDE.md §9: never plaintext config).
//
// Each backend drives a tool the OS already ships, so the single-file binaries need no
// native addon: macOS `security` (Keychain), Linux `secret-tool` (Secret Service, from
// libsecret-tools), Windows PowerShell 5.1 calling the Credential Manager API. The secret
// always travels on stdin or stdout, never in a command argument, so it cannot show up in
// the process list. When no OS store works (headless Linux, containers, a locked keychain
// over SSH) the key falls back to a file only the user can read, and the caller warns.

import { spawn } from "node:child_process"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { KeteJobMode } from "./job-mode.js"

export type Kind = "keychain" | "secret-service" | "credential-manager" | "file"

export interface Store {
  readonly kind: Kind
  /** Where the key lives, for `kete whoami` and warnings. Never contains the key. */
  readonly description: string
  readonly set: (name: string, secret: string) => Promise<void>
  /** `undefined` when there is no entry under `name`. */
  readonly get: (name: string) => Promise<string | undefined>
  /** Succeeds when there is no entry under `name`. */
  readonly remove: (name: string) => Promise<void>
}

export const service = "kete-code"
const label = "Kete Code account key"
const timeout = 15_000

/** Keys and entry names are restricted to printable ASCII without quotes or backslashes, so no tool re-parses them. */
const safe = /^[\x21-\x7e]+$/
const quoted = /["'\\]/

export function keychain(options: { keychain?: string } = {}): Store {
  const file = options.keychain ? [options.keychain] : []
  return {
    kind: "keychain",
    description: options.keychain ? `macOS Keychain (${options.keychain})` : "macOS Keychain",
    set: async (name, secret) => {
      check(name, secret)
      // `security -i` reads the command from stdin, keeping the key out of argv. It exits 0 even when the
      // command fails, so the caller verifies by reading the key back.
      const keychainArgument = options.keychain ? ` "${options.keychain}"` : ""
      await run("security", ["-i"], {
        stdin: `add-generic-password -U -s "${service}" -a "${name}" -l "${label}" -w "${secret}"${keychainArgument}\n`,
      })
    },
    get: async (name) => {
      const result = await run("security", ["find-generic-password", "-s", service, "-a", name, "-w", ...file], {
        allow: [44],
      })
      return result.code === 44 ? undefined : result.stdout.replace(/\r?\n$/, "")
    },
    remove: async (name) => {
      await run("security", ["delete-generic-password", "-s", service, "-a", name, ...file], { allow: [44] })
    },
  }
}

export function secretService(): Store {
  const attributes = (name: string) => ["service", service, "account", name]
  return {
    kind: "secret-service",
    description: "Secret Service (GNOME Keyring or KWallet)",
    set: async (name, secret) => {
      check(name, secret)
      await run("secret-tool", ["store", `--label=${label}`, ...attributes(name)], { stdin: secret })
    },
    get: async (name) => {
      // secret-tool exits 1 both when there is no entry and on some errors; the caller's read-back check
      // catches a store that silently fails.
      const result = await run("secret-tool", ["lookup", ...attributes(name)], { allow: [1] })
      return result.code === 1 || result.stdout === "" ? undefined : result.stdout
    },
    remove: async (name) => {
      await run("secret-tool", ["clear", ...attributes(name)], { allow: [1] })
    },
  }
}

export function credentialManager(): Store {
  const target = (name: string) => `${service}:${name}`
  const powershell = (name: string, operation: "write" | "read" | "delete", stdin?: string) =>
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(credentialScript(target(name), operation))],
      { stdin, allow: [3] },
    )
  return {
    kind: "credential-manager",
    description: "Windows Credential Manager",
    set: async (name, secret) => {
      check(name, secret)
      await powershell(name, "write", secret)
    },
    get: async (name) => {
      const result = await powershell(name, "read")
      return result.code === 3 ? undefined : result.stdout
    },
    remove: async (name) => {
      await powershell(name, "delete")
    },
  }
}

/** The fallback: one file per entry, readable only by the user. */
export function file(directory: string): Store {
  const location = (name: string) => path.join(directory, `account-key-${name.replace(/[^A-Za-z0-9.-]/g, "_")}`)
  return {
    kind: "file",
    description: `a file readable only by you (${directory})`,
    set: async (name, secret) => {
      check(name, secret)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const target = location(name)
      await writeFile(target, secret, { mode: 0o600 })
      // The mode above only applies to a new file; tighten an existing one too.
      await chmod(target, 0o600)
      if (process.platform === "win32") await restrictWindows(target)
    },
    get: async (name) => {
      const content = await readFile(location(name), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      return content === undefined || content === "" ? undefined : content
    },
    remove: async (name) => {
      await rm(location(name), { force: true })
    },
  }
}

/** The OS-native store for this platform, if there is one. */
export function native(platform: NodeJS.Platform = process.platform): Store | undefined {
  if (platform === "darwin") return keychain()
  if (platform === "win32") return credentialManager()
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") return secretService()
  return undefined
}

/**
 * Saves `secret` in the first store that holds it: each candidate is written and read back, so a store
 * that reports success without keeping the value is skipped. Returns the store used and why earlier
 * candidates were skipped, so the caller can warn when the key ended up in the fallback file.
 */
export async function save(candidates: readonly Store[], name: string, secret: string) {
  check(name, secret)
  const skipped: Array<{ store: Store; reason: string }> = []
  for (const store of candidates) {
    const reason = await store
      .set(name, secret)
      .then(() => store.get(name))
      .then((stored) => (stored === secret ? undefined : "the stored key could not be read back"))
      .catch((error: unknown) => message(error))
    if (reason === undefined) return { store, skipped }
    skipped.push({ store, reason })
    // Don't leave a half-written entry behind in a store we are not going to use.
    await store.remove(name).catch(() => undefined)
  }
  throw new Error(
    `Could not store the account key: ${skipped.map((item) => `${item.store.description}: ${item.reason}`).join("; ")}`,
  )
}

function check(name: string, secret: string) {
  if (!safe.test(name) || quoted.test(name)) throw new Error("Invalid credential entry name")
  if (!safe.test(secret) || quoted.test(secret)) throw new Error("The platform returned a key in an unexpected format")
}

type Result = { code: number; stdout: string }

/** Runs a tool with a timeout. Output is never included in errors, since it may hold the key. */
function run(command: string, args: string[], options: { stdin?: string; allow?: number[] } = {}) {
  return new Promise<Result>((resolve, reject) => {
    // Job mode (docs/jobs.md "Job mode"): the OS keychain CLI isn't run through the shared
    // ChildProcessSpawner service, so it needs its own guard.
    KeteJobMode.refuseSpawn("OS credential store")
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} did not finish within ${timeout / 1000} seconds`))
    }, timeout)
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new Error(error.code === "ENOENT" ? `${command} is not installed` : `${command} failed to start`))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const exit = code ?? 1
      if (exit === 0 || options.allow?.includes(exit))
        return resolve({ code: exit, stdout: Buffer.concat(stdout).toString("utf8") })
      // stderr from these tools describes the failure and never echoes the secret, which only goes to stdin.
      const detail = Buffer.concat(stderr).toString("utf8").trim().split(/\r?\n/)[0]
      reject(new Error(`${command} exited with code ${exit}${detail ? `: ${detail}` : ""}`))
    })
    child.stdin.end(options.stdin ?? "")
  })
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function restrictWindows(target: string) {
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME
  if (!user) throw new Error("Cannot restrict the key file: USERNAME is not set")
  await run("icacls", [target, "/inheritance:r", "/grant:r", `${user}:F`])
}

function encode(script: string) {
  return Buffer.from(script, "utf16le").toString("base64")
}

// Credential Manager through the Win32 API. PowerShell has no built-in cmdlet that can read a generic
// credential's secret back, and `cmdkey` can only write one. Exit code 3 means "no such credential".
function credentialScript(target: string, operation: "write" | "read" | "delete") {
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class KeteCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
  const int Generic = 1, LocalMachine = 2, NotFound = 1168;
  public static void Write(string target, string secret) {
    byte[] bytes = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL credential = new CREDENTIAL();
    credential.Type = Generic; credential.TargetName = target; credential.UserName = "${service}";
    credential.Persist = LocalMachine; credential.CredentialBlobSize = bytes.Length;
    credential.CredentialBlob = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, credential.CredentialBlob, bytes.Length);
      if (!CredWriteW(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(credential.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr buffer;
    if (!CredReadW(target, Generic, 0, out buffer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == NotFound) return null;
      throw new Win32Exception(error);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(buffer, typeof(CREDENTIAL));
      byte[] bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return Encoding.UTF8.GetString(bytes);
    } finally { CredFree(buffer); }
  }
  public static void Delete(string target) {
    if (!CredDeleteW(target, Generic, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error != NotFound) throw new Win32Exception(error);
    }
  }
}
'@
${
  operation === "write"
    ? `[KeteCredential]::Write('${target}', [Console]::In.ReadToEnd())`
    : operation === "read"
      ? `$secret = [KeteCredential]::Read('${target}')
if ($secret -eq $null) { exit 3 }
[Console]::Out.Write($secret)`
      : `[KeteCredential]::Delete('${target}')`
}
`
}

export * as KeteSecretStore from "./secret-store.js"
