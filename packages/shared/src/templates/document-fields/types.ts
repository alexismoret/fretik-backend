import type { FieldDefinitionConfig, fieldDefinitions } from "../../db/schema";

/**
 * Per-field seed payload — what a template describes for a single field.
 *
 * Templates carry **i18n keys**, not raw text. The apply layer resolves them
 * to the target locale's strings via `templateMessages` and persists plain
 * text in the DB. After that, the field is fully user-editable text — i18n
 * never re-enters the loop for that record.
 *
 * Mirrors `NewFieldDefinition` minus the columns set by the apply layer:
 *   - `id` (auto, uuid_v7)
 *   - `organizationId` / `teamId` (set per scope when applying)
 *   - `createdAt` / `updatedAt` (auto)
 */
export type FieldDefinitionSeedOption = {
  value: string;
  /** i18n key (e.g. `"transport.documentType.options.invoice"`). */
  labelKey: string;
  color?: string;
  icon?: string;
};

export type FieldDefinitionSeed = {
  key: string;
  /** i18n key for the field's display label. */
  labelKey: string;
  /**
   * i18n key for the field's description. Doubles as the source of the
   * pre-extract Zod `.describe()` — both audiences (user tooltip, LLM
   * instructions) read the same wording.
   */
  descriptionKey?: string;
  type: (typeof fieldDefinitions.$inferInsert)["type"];
  options?: FieldDefinitionSeedOption[];
  configExtras?: Omit<FieldDefinitionConfig, "options">;
  aiExtractionEnabled?: boolean;
  vectorizeInclude?: boolean;
  displayInPanel?: boolean;
  enabled?: boolean;
  displayOrder: number;
};

/**
 * Industry template — a named bundle of seed field definitions applied to
 * an organization (at creation) or to a team (via the settings UI).
 */
export type DocumentFieldTemplate = {
  key: string;
  /** i18n key for the template name shown in the UI selector. */
  labelKey: string;
  /** i18n key for the description shown under the selector. */
  descriptionKey: string;
  fields: FieldDefinitionSeed[];
};
