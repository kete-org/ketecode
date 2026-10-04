import path from "node:path"

export function isolatedEnv(root: string, overrides: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    HOME: root,
    KETE_CLI_CONFIG_CONTENT: undefined, // kete_change
    KETE_CONFIG_CONTENT: "{}", // kete_change
    KETE_CONFIG_DIR: path.join(root, "config"), // kete_change
    KETE_DB: path.join(root, "opencode.db"), // kete_change
    KETE_DISABLE_FILEWATCHER: "true", // kete_change
    KETE_DISABLE_MODELS_FETCH: "true", // kete_change
    KETE_TEST_HOME: root, // kete_change
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...overrides,
  }
}
