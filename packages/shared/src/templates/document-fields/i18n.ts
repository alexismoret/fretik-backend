import { createInstance } from "i18next";
import en from "./locales/en";

/**
 * Dedicated i18next instance for document-field templates.
 *
 * Kept separate from `emails/i18n.ts` because the two feature areas share
 * no keys and have orthogonal release cycles. Adding a new locale here is
 * a single file (`locales/<code>.ts`) — extend the `resources` map below.
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

/**
 * Resolve a template i18n key to plain text for the given locale.
 * Falls back to English if the locale is unknown or the key is missing.
 */
export const translateTemplateKey = (key: string, locale: string): string => {
  return i18n.t(key, { lng: locale });
};

export { i18n as templateI18n };
