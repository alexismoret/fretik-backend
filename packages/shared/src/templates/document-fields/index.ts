import { accountingTemplate } from "./accounting";
import { defaultTemplate } from "./default";
import { legalTemplate } from "./legal";
import { transportTemplate } from "./transport";
import type { DocumentFieldTemplate } from "./types";

/**
 * Registry of every available industry template. Keyed by `DocumentFieldTemplate.key`
 * so the API and the UI selector can look up by string. Order is preserved
 * for `Object.values(...)` consumers (selector menu).
 */
export const DOCUMENT_FIELD_TEMPLATES: Record<string, DocumentFieldTemplate> = {
  [defaultTemplate.key]: defaultTemplate,
  [transportTemplate.key]: transportTemplate,
  [legalTemplate.key]: legalTemplate,
  [accountingTemplate.key]: accountingTemplate,
};

export const DOCUMENT_FIELD_TEMPLATE_KEYS = Object.keys(
  DOCUMENT_FIELD_TEMPLATES,
);

export type DocumentFieldTemplateKey = keyof typeof DOCUMENT_FIELD_TEMPLATES;

export { templateI18n, translateTemplateKey } from "./i18n";
export type {
  DocumentFieldTemplate,
  FieldDefinitionSeed,
  FieldDefinitionSeedOption,
} from "./types";
export {
  accountingTemplate,
  defaultTemplate,
  legalTemplate,
  transportTemplate,
};
