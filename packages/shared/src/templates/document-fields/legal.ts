import type { DocumentFieldTemplate, FieldDefinitionSeedOption } from "./types";

const opt = (field: string, value: string): FieldDefinitionSeedOption => ({
  value,
  labelKey: `legal.fields.${field}.options.${value}`,
});

/**
 * Legal & Contracts template — for in-house counsel, law firms, compliance.
 * Covers: contract metadata, parties, jurisdiction, key dates and amounts.
 *
 * Field count = 8 (under the 15-field cap), leaving room for org-specific
 * additions (NDA-specific terms, clause flags, …).
 */
export const legalTemplate: DocumentFieldTemplate = {
  key: "legal",
  labelKey: "legal.name",
  descriptionKey: "legal.description",
  fields: [
    {
      key: "document_type",
      labelKey: "legal.fields.documentType.label",
      descriptionKey: "legal.fields.documentType.description",
      type: "select",
      options: [
        opt("documentType", "nda"),
        opt("documentType", "employment_contract"),
        opt("documentType", "service_agreement"),
        opt("documentType", "consulting_agreement"),
        opt("documentType", "lease"),
        opt("documentType", "amendment"),
        opt("documentType", "power_of_attorney"),
        opt("documentType", "settlement_agreement"),
        opt("documentType", "terms_and_conditions"),
        opt("documentType", "court_filing"),
        opt("documentType", "opinion_letter"),
        opt("documentType", "other"),
      ],
      displayInFilters: true,
      displayOrder: 0,
    },
    {
      key: "effective_date",
      labelKey: "legal.fields.effectiveDate.label",
      descriptionKey: "legal.fields.effectiveDate.description",
      type: "date",
      displayInFilters: true,
      displayOrder: 1,
    },
    {
      key: "expiration_date",
      labelKey: "legal.fields.expirationDate.label",
      descriptionKey: "legal.fields.expirationDate.description",
      type: "date",
      displayOrder: 2,
    },
    {
      key: "contract_value",
      labelKey: "legal.fields.contractValue.label",
      descriptionKey: "legal.fields.contractValue.description",
      type: "number",
      configExtras: { min: 0 },
      displayOrder: 3,
    },
    {
      key: "currency",
      labelKey: "legal.fields.currency.label",
      descriptionKey: "legal.fields.currency.description",
      type: "select",
      options: [
        opt("currency", "EUR"),
        opt("currency", "USD"),
        opt("currency", "GBP"),
        opt("currency", "CHF"),
        opt("currency", "JPY"),
        opt("currency", "CNY"),
        opt("currency", "CAD"),
        opt("currency", "AUD"),
      ],
      displayInFilters: true,
      displayOrder: 4,
    },
    {
      key: "jurisdiction",
      labelKey: "legal.fields.jurisdiction.label",
      descriptionKey: "legal.fields.jurisdiction.description",
      type: "text",
      displayInFilters: true,
      displayOrder: 5,
    },
    {
      key: "parties",
      labelKey: "legal.fields.parties.label",
      descriptionKey: "legal.fields.parties.description",
      type: "multi_select",
      configExtras: { freeform: true },
      displayOrder: 6,
    },
    {
      key: "counterparty_type",
      labelKey: "legal.fields.counterpartyType.label",
      descriptionKey: "legal.fields.counterpartyType.description",
      type: "select",
      options: [
        opt("counterpartyType", "corporate"),
        opt("counterpartyType", "individual"),
        opt("counterpartyType", "public_sector"),
        opt("counterpartyType", "non_profit"),
        opt("counterpartyType", "unknown"),
      ],
      displayOrder: 7,
    },
  ],
};
