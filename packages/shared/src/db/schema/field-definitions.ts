import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";

/**
 * Resource type that this field definition applies to.
 * Currently only "document" — kept as an enum so future scopes
 * (workflow, task, …) plug in without column reshapes.
 */
export const fieldDefinitionResourceTypeEnum = pgEnum(
  "field_definition_resource_type",
  ["document"],
);

/**
 * Field value type. Drives the runtime Zod builder used in pre-extract,
 * the dynamic input components on the frontend, and the filter UI.
 */
export const fieldDefinitionTypeEnum = pgEnum("field_definition_type", [
  "text",
  "number",
  "date",
  "datetime",
  "boolean",
  "select",
  "multi_select",
  "url",
  "email",
]);

/**
 * Shape of `config` JSONB. Per-type optional configuration.
 *  - select / multi_select: `options` is the closed list of allowed values.
 *  - text: `multiline` switches the frontend renderer to a textarea.
 *  - number: `min` / `max` bound the value in the schema.
 *  - multi_select: `freeform: true` lets users add values outside `options`.
 */
export type FieldDefinitionOption = {
  value: string;
  label: string;
  color?: string;
  icon?: string;
};

export type FieldDefinitionConfig = {
  options?: FieldDefinitionOption[];
  multiline?: boolean;
  min?: number;
  max?: number;
  freeform?: boolean;
};

/**
 * Field definitions table.
 *
 * Scope semantics:
 *   - `teamId IS NULL` → organization-level definition. Used as the template
 *     copied into a team's own definitions at team creation. Never read at
 *     document runtime.
 *   - `teamId IS NOT NULL` → team-level definition. The runtime source of
 *     truth: pre-extract, vectorize, panel rendering, filters all read these.
 *
 * Inheritance is copy-on-create only (org creation → applies `default`
 * template, team creation → duplicates the org's definitions). Editing an
 * org-scoped definition afterwards never propagates to existing teams.
 */
export const fieldDefinitions = pgTable(
  "field_definitions",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    // NULL = organization scope (template), set = team scope (runtime)
    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),

    resourceType: fieldDefinitionResourceTypeEnum("resource_type")
      .notNull()
      .default("document"),

    // Stable slug. Immutable post-create when values exist (enforced in the
    // service layer). Maps 1:1 with the `fieldKey` column of
    // `document_field_values`.
    key: varchar("key", { length: 60 }).notNull(),
    label: text("label").notNull(),
    // User-facing description AND `.describe()` source for the pre-extract
    // Zod runtime — the same text drives the field tooltip in the UI and the
    // instructions sent to the LLM via Vercel AI SDK's `Output.object`. Kept
    // single because both audiences benefit from the same precise wording.
    description: text("description"),

    type: fieldDefinitionTypeEnum("type").notNull(),
    config: jsonb("config")
      .$type<FieldDefinitionConfig>()
      .notNull()
      .default({}),

    aiExtractionEnabled: boolean("ai_extraction_enabled")
      .notNull()
      .default(true),
    vectorizeInclude: boolean("vectorize_include").notNull().default(true),
    displayInPanel: boolean("display_in_panel").notNull().default(true),
    displayInFilters: boolean("display_in_filters").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // Two partial unique indexes — Postgres treats NULLs as distinct in a
    // standard UNIQUE so we need explicit partials to enforce "one (key) per
    // (org, resourceType)" at org scope and "one (key) per (team,
    // resourceType)" at team scope.
    uniqueIndex("field_definitions_org_key_uniq")
      .on(table.organizationId, table.resourceType, table.key)
      .where(sql`team_id IS NULL`),
    uniqueIndex("field_definitions_team_key_uniq")
      .on(table.teamId, table.resourceType, table.key)
      .where(sql`team_id IS NOT NULL`),
    index("field_definitions_org_resource_idx")
      .on(table.organizationId, table.resourceType)
      .where(sql`team_id IS NULL`),
    index("field_definitions_team_resource_idx")
      .on(table.teamId, table.resourceType)
      .where(sql`team_id IS NOT NULL`),
  ],
);

export type FieldDefinition = typeof fieldDefinitions.$inferSelect;
export type NewFieldDefinition = typeof fieldDefinitions.$inferInsert;
export type FieldDefinitionType = FieldDefinition["type"];
export type FieldDefinitionResourceType = FieldDefinition["resourceType"];
