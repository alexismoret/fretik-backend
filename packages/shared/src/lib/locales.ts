/**
 * Locales the app ships UI + email translations for. Single source of truth
 * shared by the user `language` field, the team-language endpoint's validation,
 * and every backend i18n instance. Keep in sync with the frontend
 * `nuxt.config.ts` i18n `locales` and the `.../locales/<code>.ts` files.
 */
export const SUPPORTED_LOCALES = ["en", "fr"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

/** Narrow an arbitrary string to a supported locale, else fall back to `en`. */
export const normalizeLocale = (
  value: string | null | undefined,
): SupportedLocale => {
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === value) return locale;
  }
  return DEFAULT_LOCALE;
};
