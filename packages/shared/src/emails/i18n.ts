import { createInstance } from "i18next";

import en from "./locales/en";

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
  },
});

export { i18n };
