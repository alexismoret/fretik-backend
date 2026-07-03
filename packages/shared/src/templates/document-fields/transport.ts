import type { DocumentFieldTemplate, FieldDefinitionSeedOption } from "./types";

/**
 * Build a select option referencing the transport locale namespace.
 * Centralises the key prefix to keep the option list readable.
 */
const opt = (field: string, value: string): FieldDefinitionSeedOption => ({
  value,
  labelKey: `transport.fields.${field}.options.${value}`,
});

/**
 * Transport & Logistics template — equivalent to the freight-locked experience
 * Fretik shipped before the generic refactor. Seeds the 5 fields that the
 * previous hardcoded `documentProperties` columns covered:
 *   - document_type (was `documentType` enum, 20 values)
 *   - transport_mode (was `transportMode` enum, 6 values)
 *   - transport_type (was `documentTransportType` FK to the 45-code lookup)
 *   - document_date (was `documentDate`)
 *   - document_number (was `documentNumber`)
 */
export const transportTemplate: DocumentFieldTemplate = {
  key: "transport",
  labelKey: "transport.name",
  descriptionKey: "transport.description",
  fields: [
    {
      key: "document_type",
      labelKey: "transport.fields.documentType.label",
      descriptionKey: "transport.fields.documentType.description",
      type: "select",
      options: [
        opt("documentType", "invoice"),
        opt("documentType", "credit_note"),
        opt("documentType", "receipt"),
        opt("documentType", "statement"),
        opt("documentType", "contract"),
        opt("documentType", "order"),
        opt("documentType", "quotation"),
        opt("documentType", "certificate"),
        opt("documentType", "permit"),
        opt("documentType", "declaration"),
        opt("documentType", "report"),
        opt("documentType", "letter"),
        opt("documentType", "form"),
        opt("documentType", "list"),
        opt("documentType", "instruction"),
        opt("documentType", "specification"),
        opt("documentType", "plan"),
        opt("documentType", "notice"),
        opt("documentType", "record"),
        opt("documentType", "unknown"),
      ],
      displayOrder: 0,
    },
    {
      key: "transport_mode",
      labelKey: "transport.fields.transportMode.label",
      descriptionKey: "transport.fields.transportMode.description",
      type: "select",
      options: [
        opt("transportMode", "sea"),
        opt("transportMode", "air"),
        opt("transportMode", "road"),
        opt("transportMode", "rail"),
        opt("transportMode", "inland_waterway"),
        opt("transportMode", "multimodal"),
      ],
      displayOrder: 1,
    },
    {
      key: "transport_type",
      labelKey: "transport.fields.transportType.label",
      descriptionKey: "transport.fields.transportType.description",
      type: "select",
      options: [
        opt("transportType", "bill_of_lading"),
        opt("transportType", "sea_waybill"),
        opt("transportType", "air_waybill"),
        opt("transportType", "road_consignment_note"),
        opt("transportType", "rail_consignment_note"),
        opt("transportType", "inland_waterway_bill"),
        opt("transportType", "multimodal_transport_document"),
        opt("transportType", "charter_party"),
        opt("transportType", "booking_document"),
        opt("transportType", "shipping_instruction"),
        opt("transportType", "transport_order"),
        opt("transportType", "rate_document"),
        opt("transportType", "schedule"),
        opt("transportType", "delivery_document"),
        opt("transportType", "arrival_notice"),
        opt("transportType", "release_order"),
        opt("transportType", "packing_list"),
        opt("transportType", "loading_list"),
        opt("transportType", "cargo_manifest"),
        opt("transportType", "container_list"),
        opt("transportType", "customs_declaration"),
        opt("transportType", "summary_declaration"),
        opt("transportType", "temporary_import_document"),
        opt("transportType", "certificate_of_origin"),
        opt("transportType", "customs_valuation_document"),
        opt("transportType", "export_license"),
        opt("transportType", "health_certificate"),
        opt("transportType", "inspection_certificate"),
        opt("transportType", "fumigation_certificate"),
        opt("transportType", "damage_report"),
        opt("transportType", "vgm_declaration"),
        opt("transportType", "dangerous_goods_declaration"),
        opt("transportType", "msds"),
        opt("transportType", "cargo_insurance_certificate"),
        opt("transportType", "insurance_declaration"),
        opt("transportType", "freight_invoice"),
        opt("transportType", "customs_invoice"),
        opt("transportType", "commercial_invoice_transport"),
        opt("transportType", "container_interchange_document"),
        opt("transportType", "equipment_release"),
        opt("transportType", "warehouse_receipt"),
        opt("transportType", "storage_document"),
        opt("transportType", "letter_of_credit"),
        opt("transportType", "guarantee_document"),
        opt("transportType", "tracking_report"),
        opt("transportType", "special_instruction"),
      ],
      displayOrder: 2,
    },
    {
      key: "document_date",
      labelKey: "transport.fields.documentDate.label",
      descriptionKey: "transport.fields.documentDate.description",
      type: "date",
      displayOrder: 3,
    },
    {
      key: "document_number",
      labelKey: "transport.fields.documentNumber.label",
      descriptionKey: "transport.fields.documentNumber.description",
      type: "text",
      configExtras: { max: 100 },
      displayOrder: 4,
    },
  ],
};
