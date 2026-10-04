// Side-effect module: must be the first import of the CLI entry point so the
// KETE_* -> OPENCODE_* bridge runs before any module reads the environment
// at evaluation time. See @opencode/util/kete/env for the rules.
import { KeteEnv } from "@opencode/util/kete/env"

KeteEnv.bridge(process.env)
