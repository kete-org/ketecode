import { app } from "electron"
import { KeteDesktop } from "@opencode/util/kete/desktop" // kete_change

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<string, string> = KeteDesktop.productNames // kete_change

const appIDs: Record<string, string> = KeteDesktop.appIDs // kete_change

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : KeteDesktop.productNames.dev // kete_change

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : KeteDesktop.appIDs.dev // kete_change
