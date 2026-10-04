// Offline mode (`--offline`, KETE_OFFLINE, or `kete.offline: true` in the global config): only
// models on this machine or a private network are used, and nothing else leaves the machine
// (docs/local-models.md). This module is the flag and the "is this host local?" rule that the CLI,
// the runtime plugins and the model filter share.
//
// The flag is an environment variable (KETE_OFFLINE, bridged by env.ts to OPENCODE_OFFLINE): it has
// to hold in the server process, and an env var reaches both a standalone server and any child it
// spawns. An invalid value fails closed — `enabled` treats "on" and "invalid" alike, as job mode
// does — so a typo can never silently put a user back online.

export * as KeteOffline from "./offline.js"

import { KeteEnv } from "./env.js"

/** The internal name env.ts's bridge renames KETE_OFFLINE to. */
export const variable = "OPENCODE_OFFLINE"
/** The user/entrypoint-facing name. */
export const publicName = KeteEnv.publicName(variable)

export type Environment = Record<string, string | undefined>

export type Flag = { readonly kind: "off" } | { readonly kind: "on" } | { readonly kind: "invalid"; readonly value: string }

const truncate = (value: string) => (value.length > 50 ? `${value.slice(0, 50)}…` : value)

/** Reads the flag: `1` or `true` is on; unset or empty is off; anything else is invalid, never guessed at. */
export function read(env: Environment = process.env): Flag {
  const value = env[variable]
  if (value === undefined || value === "") return { kind: "off" }
  const normalized = value.trim().toLowerCase()
  if (normalized === "1" || normalized === "true") return { kind: "on" }
  return { kind: "invalid", value: truncate(value) }
}

/** Whether offline mode applies: "on" or "invalid" both count. */
export function enabled(env: Environment = process.env): boolean {
  return read(env).kind !== "off"
}

/** The message a command that needs the network prints when offline mode is on. */
export function refuse(command: string): string {
  return `Offline mode is on (--offline, ${publicName} or kete.offline): \`${command}\` needs the network.`
}

function ipv4(host: string): readonly number[] | undefined {
  const parts = host.split(".")
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    octets.push(value)
  }
  return octets
}

/** Eight 16-bit groups, or undefined when `host` isn't an IPv6 literal. */
function ipv6(host: string): readonly number[] | undefined {
  if (!host.includes(":")) return undefined
  const address = host.split("%")[0] ?? ""
  const doubled = address.split("::")
  if (doubled.length > 2) return undefined
  const groups = (text: string): number[] | undefined => {
    if (text === "") return []
    const result: number[] = []
    const parts = text.split(":")
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        const v4 = ipv4(part)
        if (!v4) return undefined
        result.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined
      result.push(parseInt(part, 16))
    }
    return result
  }
  const head = groups(doubled[0] ?? "")
  if (!head) return undefined
  if (doubled.length === 1) return head.length === 8 ? head : undefined
  const tail = groups(doubled[1] ?? "")
  if (!tail) return undefined
  const missing = 8 - head.length - tail.length
  if (missing < 1) return undefined
  return [...head, ...Array<number>(missing).fill(0), ...tail]
}

function privateV4([a, b]: readonly number[]): boolean {
  return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
}

function hostName(host: string): string {
  return (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host).toLowerCase().replace(/\.$/, "")
}

/** Whether `host` is this machine only: 127/8, ::1, IPv4-mapped 127/8, `localhost` and `*.localhost`. */
export function isLoopbackHost(host: string): boolean {
  const name = hostName(host)
  if (name === "localhost" || name.endsWith(".localhost")) return true
  const v4 = ipv4(name)
  if (v4) return v4[0] === 127
  const v6 = ipv6(name)
  if (!v6) return false
  if (v6.slice(0, 7).every((group) => group === 0) && v6[7] === 1) return true
  return v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff && (v6[6]! >> 8) === 127
}

/** Whether `host` is this machine or a private-network address: loopback (127/8, ::1, `localhost`,
 * `*.localhost`), RFC 1918 (10/8, 172.16/12, 192.168/16), IPv6 unique-local (fc00::/7) and link-local
 * (fe80::/10), and IPv4-mapped IPv6 of those. Link-local IPv4 (169.254/16, cloud metadata) and every
 * other hostname are not local: classifying a hostname would need DNS, so use the IP. */
export function isLocalHost(host: string): boolean {
  if (isLoopbackHost(host)) return true
  const name = hostName(host)
  const v4 = ipv4(name)
  if (v4) return privateV4(v4)
  const v6 = ipv6(name)
  if (!v6) return false
  const first = v6[0]!
  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff)
    return privateV4([v6[6]! >> 8, v6[6]! & 0xff])
  return false
}

/** Whether `url` is http(s) and its host is local (see `isLocalHost`). Anything else is not local. */
export function isLocalURL(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  return isLocalHost(parsed.hostname)
}
