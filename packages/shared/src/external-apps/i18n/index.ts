import { createInstance } from "i18next";

import en from "./locales/en";

/**
 * Dedicated i18next instance for external-app content (approval summaries
 * today, agent-stop emails tomorrow). Kept separate from the email
 * generator's instance so the two can evolve independently — same library,
 * same `i18n.t(key, {lng, ...params})` API.
 *
 * Each new language goes in `locales/<lang>.ts` and is registered below.
 */
const i18n = createInstance();

await i18n.init({
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  resources: {
    en: { translation: en },
  },
});

export { i18n };
