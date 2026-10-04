// The Kete Code chat panel: the web UI that the extension's own `kete serve` serves (upstream's
// packages/app, embedded in the CLI), framed in a VS Code webview. Kept free of the `vscode` module
// so it can be unit-tested with Bun.
//
// The frame is named "kete-vscode", which switches on the web UI's editor bridge
// (packages/app/src/kete/vscode-host.tsx). A small script in the webview relays the bridge's
// messages: from the frame (only from the server's origin) to the extension, and from the extension
// to the frame (only to the server's origin).

/**
 * The web UI's pairing link: `/connect#<base64url JSON>`, the format `kete pair` prints
 * (packages/app/src/servers/connect/pairing.ts). The part after `#` never reaches the server. The
 * username is the server's fixed internal account name.
 */
export function pairingUrl(server: string, password: string) {
  const code = Buffer.from(JSON.stringify({ username: "opencode", password })).toString("base64url")
  return `${new URL("/connect", server)}#${code}`
}

export type ChatView =
  | { readonly url: string; readonly nonce: string }
  | { readonly error: string; readonly hint?: string }
  | { readonly loading: string }

/**
 * VS Code theme variables the webview passes to the web UI, which maps them onto its own tokens
 * (packages/app/src/kete/vscode-theme.ts keeps the same list; a test checks they match).
 */
export const themeVariables = [
  "--vscode-editor-background",
  "--vscode-sideBar-background",
  "--vscode-panel-background",
  "--vscode-editorWidget-background",
  "--vscode-input-background",
  "--vscode-list-hoverBackground",
  "--vscode-list-activeSelectionBackground",
  "--vscode-foreground",
  "--vscode-descriptionForeground",
  "--vscode-disabledForeground",
  "--vscode-textLink-foreground",
  "--vscode-textLink-activeForeground",
  "--vscode-panel-border",
  "--vscode-widget-border",
  "--vscode-input-border",
  "--vscode-contrastBorder",
  "--vscode-focusBorder",
  "--vscode-icon-foreground",
  "--vscode-button-background",
  "--vscode-button-foreground",
  "--vscode-font-family",
  "--vscode-editor-font-family",
  "--vscode-font-size",
] as const

/** Message types the frame may send to the extension, and the extension to the frame. */
export const fromFrame = [
  "kete.openDiff",
  "kete.hello",
  "kete.contextAdded",
  "kete.editorContextApplied",
  "kete.session",
  "kete.themeApplied",
  "kete.dismissNotice",
  "kete.dismissCliHint",
] as const
export const toFrame = [
  "kete.addContext",
  "kete.workspace",
  "kete.editorContext",
  "kete.newSession",
  "kete.openSession",
  "kete.panel",
] as const

export function chatHtml(view: ChatView) {
  if ("url" in view) {
    const origin = new URL(view.url).origin
    return page(
      `default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${view.nonce}'`,
      `<iframe id="kete" name="kete-vscode" src="${escape(view.url)}" title="Kete Code" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${view.nonce}">${relay(origin)}</script>`,
    )
  }
  if ("loading" in view) return page("default-src 'none'; style-src 'unsafe-inline'", `<main><p>${escape(view.loading)}</p></main>`)
  return page(
    "default-src 'none'; style-src 'unsafe-inline'",
    `<main><h2>Kete Code isn't available</h2><p>${escape(view.error)}</p>${view.hint ? `<p class="hint">${escape(view.hint)}</p>` : ""}</main>`,
  )
}

function relay(origin: string) {
  return `(() => {
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById("kete");
  const origin = ${JSON.stringify(origin)};
  const fromFrame = ${JSON.stringify(fromFrame)};
  const toFrame = ${JSON.stringify(toFrame)};
  const variables = ${JSON.stringify(themeVariables)};
  // VS Code's theme, for the web UI to look native; sent on hello and whenever the theme changes.
  const theme = () => {
    const style = getComputedStyle(document.documentElement);
    const classes = document.body.classList;
    const kind = classes.contains("vscode-high-contrast-light") ? "high-contrast-light"
      : classes.contains("vscode-high-contrast") ? "high-contrast"
      : classes.contains("vscode-light") ? "light" : "dark";
    const values = {};
    for (const name of variables) values[name] = style.getPropertyValue(name).trim();
    return { type: "kete.theme", kind, variables: values };
  };
  const sendTheme = () => frame.contentWindow.postMessage(theme(), origin);
  new MutationObserver(sendTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  new MutationObserver(sendTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data.type !== "string") return;
    if (event.source === frame.contentWindow) {
      if (event.origin !== origin) return;
      if (data.type === "kete.hello") sendTheme();
      if (fromFrame.includes(data.type)) vscode.postMessage(data);
      return;
    }
    if (toFrame.includes(data.type)) frame.contentWindow.postMessage(data, origin);
  });
})();`
}

function page(csp: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
  main { padding: 16px; line-height: 1.5; }
  h2 { font-size: 1.1em; margin: 0 0 8px; }
  .hint { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>${body}</body>
</html>`
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
