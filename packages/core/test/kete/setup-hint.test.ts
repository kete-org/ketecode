import { describe, expect, test } from "bun:test"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { KeteSetup } from "@opencode/util/kete/setup"

// Pins the pairing `kete run`'s hint relies on: an upstream message or mapping change fails here.
describe("kete run no-model hint", () => {
  test("recognizes the no-model session error", () => {
    const error = toSessionError(new SessionRunnerModel.ModelNotSelectedError({ sessionID: Session.ID.make("ses_test") }))
    expect(KeteSetup.isNoModel(error)).toBe(true)
  })

  test("does not recognize an unavailable model", () => {
    const error = toSessionError(
      new SessionRunnerModel.ModelUnavailableError({ providerID: Provider.ID.make("p"), modelID: Model.ID.make("m") }),
    )
    expect(KeteSetup.isNoModel(error)).toBe(false)
  })
})
