import {
  DOCUMENT_FIELD_TEMPLATES,
  translateTemplateKey,
} from "../../templates/document-fields";
import { getTeamLocale } from "./get-locale";

/**
 * Minimal metadata shape returned by the API for the template selector.
 * The frontend never sees i18n keys — it sees already-resolved text.
 */
export type DocumentFieldTemplateListEntry = {
  key: string;
  label: string;
  description: string;
  fieldCount: number;
  fields: {
    key: string;
    label: string;
    description: string | null;
    type: string;
    optionCount: number;
  }[];
};

/**
 * List every available template. If `teamId` is provided, the locale is
 * read from `teamSettings.lang`; otherwise an explicit `locale` may be
 * supplied (defaults to `"en"`).
 *
 * The light field-level metadata is included so the UI can preview "what
 * will be applied" without a second round-trip.
 */
export const listDocumentFieldTemplates = async (data: {
  teamId?: string | null;
  locale?: string;
}): Promise<DocumentFieldTemplateListEntry[]> => {
  const { teamId, locale: localeOverride } = data;
  const locale =
    localeOverride ?? (teamId ? await getTeamLocale(teamId) : "en");

  return Object.values(DOCUMENT_FIELD_TEMPLATES).map((template) => ({
    key: template.key,
    label: translateTemplateKey(template.labelKey, locale),
    description: translateTemplateKey(template.descriptionKey, locale),
    fieldCount: template.fields.length,
    fields: template.fields.map((seed) => ({
      key: seed.key,
      label: translateTemplateKey(seed.labelKey, locale),
      description: seed.descriptionKey
        ? translateTemplateKey(seed.descriptionKey, locale)
        : null,
      type: seed.type,
      optionCount: seed.options ? seed.options.length : 0,
    })),
  }));
};
