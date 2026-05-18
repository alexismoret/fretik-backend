import type { DocumentFieldTemplate, FieldDefinitionSeedOption } from "./types";

const opt = (field: string, value: string): FieldDefinitionSeedOption => ({
  value,
  labelKey: `accounting.fields.${field}.options.${value}`,
});

/**
 * Accounting & Finance template — for AP/AR, bookkeeping, finance ops.
 * Covers invoice metadata, amounts breakdown, currency, dates and terms.
 *
 * Field count = 11 (under the 15-field cap), tight set chosen to support
 * day-to-day finance flows (matching, reconciliation, tax reporting) while
 * leaving room for org-specific additions (cost centre, project, …).
 */
export const accountingTemplate: DocumentFieldTemplate = {
  key: "accounting",
  labelKey: "accounting.name",
  descriptionKey: "accounting.description",
  fields: [
    {
      resourceType: "document",
      key: "document_type",
      labelKey: "accounting.fields.documentType.label",
      descriptionKey: "accounting.fields.documentType.description",
      type: "select",
      options: [
        opt("documentType", "invoice"),
        opt("documentType", "credit_note"),
        opt("documentType", "debit_note"),
        opt("documentType", "receipt"),
        opt("documentType", "statement"),
        opt("documentType", "quote"),
        opt("documentType", "purchase_order"),
        opt("documentType", "remittance_advice"),
        opt("documentType", "expense_report"),
        opt("documentType", "payslip"),
        opt("documentType", "other"),
      ],
      displayInFilters: true,
      displayOrder: 0,
    },
    {
      resourceType: "document",
      key: "invoice_number",
      labelKey: "accounting.fields.invoiceNumber.label",
      descriptionKey: "accounting.fields.invoiceNumber.description",
      type: "text",
      displayInFilters: true,
      displayOrder: 1,
    },
    {
      resourceType: "document",
      key: "invoice_date",
      labelKey: "accounting.fields.invoiceDate.label",
      descriptionKey: "accounting.fields.invoiceDate.description",
      type: "date",
      displayInFilters: true,
      displayOrder: 2,
    },
    {
      resourceType: "document",
      key: "due_date",
      labelKey: "accounting.fields.dueDate.label",
      descriptionKey: "accounting.fields.dueDate.description",
      type: "date",
      displayInFilters: true,
      displayOrder: 3,
    },
    {
      resourceType: "document",
      key: "currency",
      labelKey: "accounting.fields.currency.label",
      descriptionKey: "accounting.fields.currency.description",
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
      resourceType: "document",
      key: "total_amount",
      labelKey: "accounting.fields.totalAmount.label",
      descriptionKey: "accounting.fields.totalAmount.description",
      type: "number",
      configExtras: { min: 0 },
      displayOrder: 5,
    },
    {
      resourceType: "document",
      key: "subtotal_amount",
      labelKey: "accounting.fields.subtotalAmount.label",
      descriptionKey: "accounting.fields.subtotalAmount.description",
      type: "number",
      configExtras: { min: 0 },
      displayOrder: 6,
    },
    {
      resourceType: "document",
      key: "tax_amount",
      labelKey: "accounting.fields.taxAmount.label",
      descriptionKey: "accounting.fields.taxAmount.description",
      type: "number",
      configExtras: { min: 0 },
      displayOrder: 7,
    },
    {
      resourceType: "document",
      key: "vat_rate",
      labelKey: "accounting.fields.vatRate.label",
      descriptionKey: "accounting.fields.vatRate.description",
      type: "number",
      configExtras: { min: 0, max: 100 },
      displayOrder: 8,
    },
    {
      resourceType: "document",
      key: "payment_terms",
      labelKey: "accounting.fields.paymentTerms.label",
      descriptionKey: "accounting.fields.paymentTerms.description",
      type: "text",
      displayOrder: 9,
    },
    {
      resourceType: "document",
      key: "vendor_tax_id",
      labelKey: "accounting.fields.vendorTaxId.label",
      descriptionKey: "accounting.fields.vendorTaxId.description",
      type: "text",
      displayOrder: 10,
    },
  ],
};
