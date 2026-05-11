import { z } from "zod";
import { entityRoleEnum, entityTypeEnum } from "../db/schema";
import { documentTypeSchema, transportModeSchema } from "./documents";

/**
 * Hardcoded list of fine-grained freight/logistics document types (45 values).
 * Kept here — rather than pulled from the DB `document_transport_types`
 * lookup table — because Zod enums must be literal-typed at compile time
 * and the LLM needs a stable, reviewable list. If the lookup table gains
 * new codes, update this array manually.
 */
export const DOCUMENT_TRANSPORT_TYPE_CODES = [
  "bill_of_lading",
  "sea_waybill",
  "air_waybill",
  "road_consignment_note",
  "rail_consignment_note",
  "inland_waterway_bill",
  "multimodal_transport_document",
  "charter_party",
  "booking_document",
  "shipping_instruction",
  "transport_order",
  "rate_document",
  "schedule",
  "delivery_document",
  "arrival_notice",
  "release_order",
  "packing_list",
  "loading_list",
  "cargo_manifest",
  "container_list",
  "customs_declaration",
  "summary_declaration",
  "temporary_import_document",
  "certificate_of_origin",
  "customs_valuation_document",
  "export_license",
  "health_certificate",
  "inspection_certificate",
  "fumigation_certificate",
  "damage_report",
  "vgm_declaration",
  "dangerous_goods_declaration",
  "msds",
  "cargo_insurance_certificate",
  "insurance_declaration",
  "freight_invoice",
  "customs_invoice",
  "commercial_invoice_transport",
  "container_interchange_document",
  "equipment_release",
  "warehouse_receipt",
  "storage_document",
  "letter_of_credit",
  "guarantee_document",
  "tracking_report",
  "special_instruction",
] as const;

/**
 * Entity extracted from a document by the LLM. Multiple entries with the
 * same `name` but different `role` are expected when an organisation plays
 * several roles in the same document (e.g. issuer + consignee).
 */
export const preExtractionEntitySchema = z.object({
  name: z
    .string()
    .max(200)
    .describe(
      "Exact company/organization name as written on the document (do not normalise casing or expand acronyms).",
    ),
  role: z
    .enum(entityRoleEnum.enumValues)
    .describe(
      "Role of the entity in the document context. issuer = official authority that issued/created the document; customer = the customer/client (shipper, consignee, buyer, importer/exporter); broker = freight forwarder, customs broker, or intermediary agent; consignee = party receiving the goods (only if distinct from customer); shipper = party sending the goods (only if distinct from issuer); mentioned = any other organisation mentioned that does not fit above.",
    ),
  type: z
    .enum(entityTypeEnum.enumValues)
    .optional()
    .describe(
      "Entity category. carrier = shipping lines, airlines, trucking companies, any transport operator; client = end customers, importers, exporters, buyers, sellers; other = government bodies, certification authorities, banks, insurance companies.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Confidence level (0..1) in the accuracy of this specific entity/role extraction.",
    ),
});

/**
 * Subset of the pre-extraction response that is ACTUALLY produced by the
 * LLM via `generateText()` in `@fretik/ai`. Every field carries a
 * `.describe()` string which Zod serialises to the JSON Schema description
 * fed to the model — so the model understands what to produce.
 */
export const preExtractionLlmSchema = z.object({
  documentType: documentTypeSchema.describe(
    "Generic functional document category. Select the most appropriate value among the 20 allowed. Key distinctions: order = requests for goods/services (purchase orders, transport orders, pickup requests, booking requests); instruction = procedural directives or guidelines (shipping instructions, user manuals, handling procedures); form = structured templates to be completed (application forms, registration forms); record = official documentation of events/transactions (bills of lading, receipts, logs); declaration = formal statements to authorities (customs declarations, tax returns); certificate = official attestations (certificates of origin, quality certificates, diplomas). Use `unknown` only if the document cannot be confidently classified. NEVER put a transport-specific value here — use documentTransportType for that.",
  ),
  documentTransportType: z
    .enum(DOCUMENT_TRANSPORT_TYPE_CODES)
    .nullish()
    .describe(
      "Specific freight/logistics document type. Set ONLY if the document is clearly freight/logistics-related; otherwise null. Pick the category that matches the document's PRIMARY function (e.g. bill_of_lading for all BL types; air_waybill for all AWB types; road_consignment_note for CMR and road transport; booking_document for booking requests/confirmations; transport_order for pickup requests, collection orders, forwarding instructions; delivery_document for delivery notes, proof of delivery, goods receipts; certificate_of_origin for EUR1/ATR/Form A; health_certificate for phytosanitary/veterinary/health; inspection_certificate for quality/quantity/weight/survey; customs_declaration for import/export/transit/SAD; freight_invoice for freight invoices and transport debit/credit notes).",
    ),
  transportMode: transportModeSchema
    .nullish()
    .describe(
      "Transport mode if explicitly mentioned or clearly identifiable from the document type (CMR → road; Air Waybill → air; Ocean BL → sea). Set to null if uncertain or not applicable.",
    ),
  documentSummary: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      "Factual summary of the document purpose and key information. Aim for 3-5 sentences. Target under 500 characters; 1000 is a hard cap.",
    ),
  // ISO 639-1 code is strictly 2 letters. We accept both lowercase and
  // uppercase at validation time (models occasionally emit "EN" instead
  // of "en") but keep the hard 2-char rule. Previously `/^[a-z]{2}$/`
  // produced false Zod rejections on otherwise-valid responses, which
  // then triggered an expensive fallback round-trip.
  documentLanguage: z
    .string()
    .regex(/^[a-zA-Z]{2}$/)
    .toLowerCase()
    .describe(
      "Primary language of the document content as an ISO 639-1 two-letter code, lowercase (e.g. en, fr, de, es, it, nl, pt). MUST be exactly 2 characters.",
    ),
  documentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/)
    .nullish()
    .describe(
      "Document date in ISO 8601 format (YYYY-MM-DD or full ISO datetime). Null if not explicitly present on the document.",
    ),
  documentNumber: z
    .string()
    .max(100)
    .nullish()
    .describe(
      "Official document/reference/tracking number if present (invoice number, BL number, booking reference, etc.). Null if not present.",
    ),
  entities: z
    .array(preExtractionEntitySchema)
    .default([])
    .describe(
      "ALL organisations/companies mentioned in the document. Do NOT limit the number of entities. If the SAME organisation plays SEVERAL roles in the document (e.g. the same company is both ISSUER and CONSIGNEE), emit ONE entry PER role (same `name`, different `role`, with the appropriate `confidence` for each) — do NOT pick a single 'best' role.",
    ),
  confidenceScore: z
    .number()
    .min(0)
    .max(1)
    .nullish()
    .describe(
      "Overall confidence (0..1) in the extraction quality across all fields. Null if not self-assessable.",
    ),
  preExtractionMetadata: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe(
      "Optional free-form metadata (e.g. diagnostic notes). Keep minimal.",
    ),
});

export type PreExtractionLlmOutput = z.infer<typeof preExtractionLlmSchema>;

/**
 * Full HTTP response shape of `POST /internal/pre-extract` (@fretik/ai).
 * Extends `preExtractionLlmSchema` with the three orchestrator-filled
 * fields (`success`, `pages`, `pageCount`) that are NOT produced by the
 * LLM. Used by `@fretik/shared/services/documents/upload.ts` to validate
 * the response before persisting to `documentProperties`.
 *
 * Date coercion (`z.coerce.date`) is applied at the response boundary so
 * JSON strings coming over the wire are converted to `Date` instances for
 * downstream code. The LLM schema keeps the field as a strict ISO string.
 */
export const preExtractionResponseSchema = preExtractionLlmSchema
  .omit({ documentDate: true })
  .extend({
    success: z.boolean(),
    pages: z.array(
      z.object({
        index: z.number(),
        markdown: z.string(),
      }),
    ),
    pageCount: z.number(),
    documentDate: z.coerce.date().nullish(),
  });

export type PreExtractionResponse = z.infer<typeof preExtractionResponseSchema>;
