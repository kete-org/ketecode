// Integration settings from the last sync (`integrations` in GET /api/v1/sync, being added by the
// platform's Slack integration task). The field is optional and loosely typed in ./contract.ts, so
// these readers accept only the shapes they understand and treat anything else as absent.

import type { SyncResponse } from "./contract.js"

const clientIdPattern = /^[A-Za-z0-9._-]{1,128}$/

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** The organization's Slack app client ID (`integrations.slack.client_id`), when the platform provides a valid one. */
export function slackClientId(response: Pick<SyncResponse, "integrations"> | undefined): string | undefined {
  const slack = record(record(response?.integrations)?.slack)
  const value = slack?.client_id ?? slack?.clientId
  return typeof value === "string" && clientIdPattern.test(value) ? value : undefined
}

export * as KeteSyncIntegrations from "./integrations.js"
