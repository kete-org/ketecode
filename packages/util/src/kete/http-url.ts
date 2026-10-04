// One rule for an operator-supplied http(s) URL: parsed, origin plus path with trailing slashes
// dropped; anything else (unset, unparsable, another scheme) is `undefined`. Shared by the gateway
// provider (core/src/kete/gateway.ts) and job mode's endpoints (job-mode.ts).

export function normalize(raw: string | undefined): string | undefined {
  if (!raw || !URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

export * as KeteHttpURL from "./http-url.js"
