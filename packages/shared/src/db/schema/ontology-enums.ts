import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Shared lifecycle vocabulary for the dynamic-data system. Both `links`,
 * `object_records`, and `link_types` carry these — trust is a first-class
 * dimension, not a second table. Reuses the proven `entities` model
 * (suggested → confirmed → rejected): user-created rows are born `confirmed`,
 * AI-extracted ones `suggested` until reviewed.
 */
export const ontologyStatusEnum = pgEnum("ontology_status", [
  "confirmed",
  "suggested",
  "rejected",
]);

/**
 * How a record / link / link-type came to exist. Drives default visibility
 * (the UI and default agent context show `confirmed` only) and audit.
 */
export const ontologySourceEnum = pgEnum("ontology_source", [
  "user_manual",
  "user_correction",
  "ai_extraction",
  "ai_inference",
  "system",
  "connector",
]);

export const ONTOLOGY_STATUSES = ontologyStatusEnum.enumValues;
export const ONTOLOGY_SOURCES = ontologySourceEnum.enumValues;
export type OntologyStatus = (typeof ONTOLOGY_STATUSES)[number];
export type OntologySource = (typeof ONTOLOGY_SOURCES)[number];
