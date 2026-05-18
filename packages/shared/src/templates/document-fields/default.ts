import type { DocumentFieldTemplate } from "./types";

/**
 * Default template — applied automatically when an organization is created.
 * Minimal, industry-neutral set so the AI assistant has something to extract
 * even before the user customises anything.
 */
export const defaultTemplate: DocumentFieldTemplate = {
  key: "default",
  labelKey: "default.name",
  descriptionKey: "default.description",
  fields: [
    {
      resourceType: "document",
      key: "document_type",
      labelKey: "default.fields.documentType.label",
      descriptionKey: "default.fields.documentType.description",
      type: "select",
      options: [
        {
          value: "invoice",
          labelKey: "default.fields.documentType.options.invoice",
        },
        {
          value: "contract",
          labelKey: "default.fields.documentType.options.contract",
        },
        {
          value: "report",
          labelKey: "default.fields.documentType.options.report",
        },
        {
          value: "letter",
          labelKey: "default.fields.documentType.options.letter",
        },
        { value: "form", labelKey: "default.fields.documentType.options.form" },
        {
          value: "receipt",
          labelKey: "default.fields.documentType.options.receipt",
        },
        {
          value: "other",
          labelKey: "default.fields.documentType.options.other",
        },
      ],
      displayInFilters: true,
      displayOrder: 0,
    },
    {
      resourceType: "document",
      key: "document_date",
      labelKey: "default.fields.documentDate.label",
      descriptionKey: "default.fields.documentDate.description",
      type: "date",
      displayOrder: 1,
    },
  ],
};
