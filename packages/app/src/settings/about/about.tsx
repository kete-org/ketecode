import { Show, createResource } from "solid-js" // kete_change
import { Brand } from "@opencode/util/kete/brand" // kete_change
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { ExternalLink } from "@/runtime/platform/external-link"
import legal from "./legal.svg"
import anomalyBrush from "./anomaly-brush.svg"
import { AnimatedWordmark } from "./animated-wordmark"
import { FALLBACK_OTHER_CONTRIBUTORS, loadOtherContributorCount } from "./contributors"
import { wordmarkFont } from "@/kete/fonts" // kete_change

const writers = [
  "thdxr",
  "adamdotdev",
  "rekram1-node",
  "kitlangton",
  "iamdavidhill",
  "jayair",
  "fwang",
  "brendonovich",
  "nexxeln",
  "hona",
  "kommander",
  "jlongster",
  "vimtor",
  "r44vcorp",
  "simonklee",
  "arvsrn",
] as const
const illustrators = ["usrnk1", "ludvigrask_", "arvsrn", "iamdavidhill"] as const

export function SettingsAbout(props: { active: boolean }) {
  const language = useLanguage()
  const platform = usePlatform()
  const [otherContributors] = createResource(
    () => props.active || undefined,
    () => loadOtherContributorCount(platform.fetch ?? fetch),
    { initialValue: FALLBACK_OTHER_CONTRIBUTORS },
  )
  const credit = (name: string) => (
    <bdi dir="ltr">
      <ExternalLink href={profile(name)}>{name}</ExternalLink>
    </bdi>
  )
  const writerCredits = () => [
    ...writers.map(credit),
    <ExternalLink href="https://github.com/anomalyco/opencode/graphs/contributors">
      {language.plural("settings.about.otherContributor", otherContributors.latest, {
        count: otherContributors.latest,
      })}
    </ExternalLink>,
  ]

  return (
    <div class="settings-about-content">
      <div class="settings-about-intro">
        <p>
          {language.t("settings.about.version", {
            version: platform.version ?? language.t("settings.about.devVersion"),
          })}
        </p>
        <p>{language.t("settings.about.license")}</p>
      </div>

      <AnimatedWordmark active={props.active} />

      <div class="settings-about-credits">
        <p>{language.rich("settings.about.writtenByNames", { names: language.list(writerCredits()) })}</p>
        <p>
          {language.rich("settings.about.illustratedByNames", {
            names: language.list(illustrators.map(credit)),
          })}
        </p>
      </div>

      <div class="settings-about-publication">
        <p>{language.t("settings.about.firstPublished")}</p>
        <p>{language.t("settings.about.firstIllustrated")}</p>
      </div>

      {/* kete_change start: Kete Code has no website yet (Brand.urls.docs); link it once it exists */}
      <Show when={Brand.urls.docs}>
        {(docs) => (
          <p class="settings-about-faint">
            <ExternalLink href={docs()}>
              <bdi dir="ltr">{new URL(docs()).host}</bdi>
            </ExternalLink>
          </p>
        )}
      </Show>
      {/* kete_change end */}

      <div class="settings-about-details">
        <p>{language.t("settings.about.description")}</p>
        <p>{language.t("settings.about.trademark")}</p>
        <p>{language.t("settings.about.typeset")}</p>
        {/* kete_change start: the wordmark's font licence (SIL OFL), bundled under assets/brand/fonts */}
        <p class="settings-about-faint">
          "Kete Code" is set in{" "}
          <ExternalLink href={wordmarkFont.licenceUrl}>
            {wordmarkFont.name} — {wordmarkFont.licence}
          </ExternalLink>
          .
        </p>
        {/* kete_change end */}
      </div>

      <p>{language.t("settings.about.tagline")}</p>
      <img class="settings-about-legal" src={legal} alt="" />
      <div class="settings-about-copyright">
        <p>{language.t("settings.about.copyright")}</p>
        <img class="settings-about-anomaly-brush" src={anomalyBrush} alt="" />
      </div>
    </div>
  )
}

function profile(name: string) {
  if (name === "r44vcorp") return "https://github.com/R44VC0RP"
  if (name === "ludvigrask_") return "https://x.com/ludvigrask_"
  return `https://github.com/${name}`
}
