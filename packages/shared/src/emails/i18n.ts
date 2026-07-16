import { createInstance } from "i18next";

import en from "./locales/en";
import fr from "./locales/fr";

const i18n = createInstance();

await i18n.init({
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
  resources: {
    en: {
      translation: en,
    },
    fr: {
      translation: fr,
    },
  },
});

export { i18n };
