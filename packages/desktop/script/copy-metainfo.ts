import { resolveChannel } from "./utils"
import { Brand } from "@opencode/util/kete/brand" // kete_change
import { KeteDesktop } from "@opencode/util/kete/desktop" // kete_change

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = KeteDesktop.appIDs[channel] // kete_change

const productName = KeteDesktop.productNames[channel] // kete_change

const summary = `AI coding agent${channel !== "prod" ? ` (${channel})` : ""}` // kete_change

// kete_change start: Kete Code's developer, description and links
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="ai.ketecode">
    <name>${Brand.displayName}</name>
  </developer>

  <description>
    <p>
      ${Brand.displayName} is an AI coding agent that helps you write and run code with any AI model.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">${Brand.urls.issues}</url>
  <url type="homepage">${Brand.urls.releases}</url>
</component>
`
// kete_change end

await Bun.write(`resources/${appId}.metainfo.xml`, xml)

console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
