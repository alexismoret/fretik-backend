import { z } from "zod";
import {
  linkTypeCardinalityEnum,
  ONTOLOGY_SOURCES,
  ONTOLOGY_STATUSES,
} from "../db/schema";
import { FIELD_DEFINITION_LIMITS } from "../services/field-definitions/constants";
import { OBJECT_TYPE_LIMITS } from "../services/object-types/constants";
import { paramsListSchema } from "./common/params";
import {
  fieldConfigSchema,
  fieldDefinitionTypeSchema,
} from "./field-definitions";
import { audienceSchema, recordSharingSchema } from "./object-sharing";

/**
 * Wire schemas for the dynamic-data (ontology) API — object types, records,
 * links, and the activity timeline. Shared across the four handlers so request
 * validation and response shapes stay in lockstep. Timestamps use
 * `z.coerce.date()` (accepts both `Date` rows and ISO strings) like the
 * field-definitions schema; `data` / `props` are opaque JSONB maps.
 */

export const ontologyStatusSchema = z.enum(ONTOLOGY_STATUSES);
export const ontologySourceSchema = z.enum(ONTOLOGY_SOURCES);
export const linkCardinalitySchema = z.enum(linkTypeCardinalityEnum.enumValues);

const jsonMap = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Object types
// ---------------------------------------------------------------------------

export const objectTypeResponseSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  teamId: z.uuid().nullable(),
  key: z.string(),
  label: z.string(),
  labelPlural: z.string().nullable(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  isSystem: z.boolean(),
  enabled: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const createObjectTypeRequestSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(
      /^[a-z][a-z0-9_]{0,58}[a-z0-9]$|^[a-z]$/,
      "Key must be snake_case (lowercase letters, digits, underscores)",
    ),
  label: z.string().trim().min(1),
  labelPlural: z.string().trim().min(1).nullish(),
  description: z
    .string()
    .trim()
    .max(OBJECT_TYPE_LIMITS.MAX_DESCRIPTION_CHARS)
    .nullish(),
  icon: z.string().trim().max(60).nullish(),
  color: z.string().trim().max(20).nullish(),
  // Initial cross-team audience. Omitted = internal (owning team only).
  sharing: audienceSchema.optional(),
});

export const updateObjectTypeRequestSchema = z.object({
  label: z.string().trim().min(1).optional(),
  labelPlural: z.string().trim().min(1).nullish(),
  description: z
    .string()
    .trim()
    .max(OBJECT_TYPE_LIMITS.MAX_DESCRIPTION_CHARS)
    .nullish(),
  icon: z.string().trim().max(60).nullish(),
  color: z.string().trim().max(20).nullish(),
  enabled: z.boolean().optional(),
  // Change the cross-team audience (owner-only). Reconciles `object_grants`.
  sharing: audienceSchema.optional(),
});

/**
 * One draft field inside the "create type with fields" payload — a field's
 * intrinsic shape minus the per-field routing keys (`scope`, `objectTypeId`):
 * the type is created in the same call, and `key` is derived server-side.
 * Select / multi_select still require non-empty options.
 */
const objectTypeFieldInputSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(FIELD_DEFINITION_LIMITS.MAX_LABEL_CHARS),
    type: fieldDefinitionTypeSchema,
    description: z
      .string()
      .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
      .nullish(),
    config: fieldConfigSchema.default({}),
    isTitle: z.boolean().optional(),
    aiExtractionEnabled: z.boolean().optional(),
    vectorizeInclude: z.boolean().optional(),
    displayInPanel: z.boolean().optional(),
    enabled: z.boolean().optional(),
    displayOrder: z.number().int().min(0).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "select" || data.type === "multi_select") {
      const opts = data.config?.options ?? [];
      if (opts.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["config", "options"],
          message:
            "Select / multi_select fields require at least one option in config.options.",
        });
      }
    }
  });

/**
 * Create an object type and its initial fields in one atomic request (the
 * composer's "create"). Extends the plain type-create shape with a `fields`
 * array.
 */
export const createObjectTypeWithFieldsRequestSchema =
  createObjectTypeRequestSchema.extend({
    fields: z
      .array(objectTypeFieldInputSchema)
      .max(FIELD_DEFINITION_LIMITS.MAX_FIELDS_PER_TYPE)
      .default([]),
  });

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export const objectRecordResponseSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  teamId: z.uuid(),
  userId: z.uuid().nullable(),
  objectTypeId: z.uuid(),
  data: jsonMap,
  label: z.string(),
  normalizedLabel: z.string(),
  aliases: z.array(z.string()).nullable(),
  status: ontologyStatusSchema,
  source: ontologySourceSchema,
  confidence: z.string().nullable(),
  documentId: z.uuid().nullable(),
  // TRUE = the record follows its type's audience live; FALSE = it carries its
  // own `record_shares` (a subset of the type's). Drives the "same as type" vs
  // "custom" display.
  inheritTypeSharing: z.boolean(),
  // Field values not stored in `data` — relations as `[{id,label}]` and rollup
  // aggregates — projected from the team's typed view. Optional: present on the
  // list / detail read paths, absent on write responses.
  computed: jsonMap.optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/**
 * One outgoing relation to attach when creating a record. Name the relation by
 * `relationKey` (resolved/created against the new record's type) or an explicit
 * `linkTypeId`; target it by `toRecordId` or an uploaded file's `toDocumentId`
 * (its document_record mirror). Shared by the API create body and the code-mode
 * bulk SDK.
 */
export const recordRelationInputSchema = z.object({
  relationKey: z.string().max(60).optional(),
  linkTypeId: z.uuid().optional(),
  toRecordId: z.uuid().optional(),
  toDocumentId: z.uuid().optional(),
});

export const createObjectRecordRequestSchema = z.object({
  objectTypeId: z.uuid(),
  data: jsonMap.default({}),
  status: ontologyStatusSchema.optional(),
  source: ontologySourceSchema.optional(),
  labelOverride: z.string().trim().min(1).nullish(),
  // Outgoing relations created with the record, in one transaction.
  relations: z.array(recordRelationInputSchema).optional(),
  // Cross-team sharing. Omitted = inherit the type's audience.
  sharing: recordSharingSchema.optional(),
});

/**
 * Update a record's `data` and/or its `sharing` in one request — at least one
 * must be present. A data-only patch is the field autosave; a sharing-only patch
 * is the share popover (reset-to-inherit = `{ inherit: true }`, owner-only).
 */
export const updateObjectRecordRequestSchema = z
  .object({
    data: jsonMap.optional(),
    sharing: recordSharingSchema.optional(),
  })
  .refine((v) => v.data !== undefined || v.sharing !== undefined, {
    message: "Provide `data`, `sharing`, or both.",
  });

export const setRecordStatusRequestSchema = z.object({
  status: z.enum(["confirmed", "rejected"]),
});

// Field-level filters. Keys are slug-guarded; ops are scoped per field type on
// the client but re-validated here. Values cover the comparable primitives plus
// a string array for `in`.
export const recordFilterOpSchema = z.enum([
  "eq",
  "neq",
  "contains",
  "in",
  "gt",
  "lt",
  "gte",
  "lte",
  "between",
  "is_true",
  "is_false",
  "is_empty",
  "is_not_empty",
]);

// `{ start, end }` ISO range for `between` on date / datetime fields. Either
// bound may be null → an open interval on that side.
export const dateRangeFilterValueSchema = z.object({
  start: z.string().nullable(),
  end: z.string().nullable(),
});

export const recordFilterSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  op: recordFilterOpSchema,
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      dateRangeFilterValueSchema,
    ])
    .optional(),
});

export type RecordFilter = z.infer<typeof recordFilterSchema>;

export const recordListQuerySchema = paramsListSchema.extend({
  objectTypeId: z.uuid(),
  status: ontologyStatusSchema.default("confirmed"),
  // Resolve the mirror record of an uploaded document (attachment fields link
  // to the mirror, keyed by the drive document id).
  documentId: z.uuid().optional(),
  // Query params arrive as strings; only the literal "true" opts in.
  withLinks: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  // `label` | `createdAt` | `updatedAt` | `field:<key>` — validated +
  // shape-guarded in the service; an unknown token falls back to createdAt.
  sortBy: z.string().max(80).default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  // JSON-encoded `RecordFilter[]` (query params are strings). Malformed input
  // degrades to "no filters" rather than erroring the list.
  filters: z
    .string()
    .optional()
    .transform((raw): RecordFilter[] => {
      if (!raw) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        const res = z.array(recordFilterSchema).max(20).safeParse(parsed);
        return res.success ? res.data : [];
      } catch {
        return [];
      }
    }),
});

// Group aggregate (kanban column headers): exact count + optional sum per group.
export const recordAggregateQuerySchema = z.object({
  objectTypeId: z.uuid(),
  groupKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  status: ontologyStatusSchema.default("confirmed"),
  sumKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80)
    .optional(),
  sumKind: z.enum(["number", "money"]).optional(),
});

export const groupAggregateSchema = z.object({
  value: z.string().nullable(),
  count: z.number().int(),
  sum: z.number().nullable(),
});

// Map view: records of a type placed on a map by one of its `location` fields,
// scoped to the current camera bounding box. Above a cap the server returns
// grid-aggregated clusters instead of individual points (see `getMapPoints`).
export const recordMapQuerySchema = z.object({
  objectTypeId: z.uuid(),
  fieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  // Bbox is OPTIONAL: omitted = the whole dataset (the client's first call, to
  // learn whether it can load everything at once or must page by viewport). All
  // four must be present together to bound the query.
  minLng: z.coerce.number().min(-180).max(180).optional(),
  minLat: z.coerce.number().min(-90).max(90).optional(),
  maxLng: z.coerce.number().min(-180).max(180).optional(),
  maxLat: z.coerce.number().min(-90).max(90).optional(),
});

const locationBboxSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

export const mapPointSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  lng: z.number(),
  lat: z.number(),
  featureType: z.string().nullable(),
  bbox: locationBboxSchema.nullable(),
});

export const mapClusterSchema = z.object({
  lng: z.number(),
  lat: z.number(),
  count: z.number().int(),
});

export const mapPointsResponseSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("points"), points: z.array(mapPointSchema) }),
  z.object({
    mode: z.literal("clusters"),
    clusters: z.array(mapClusterSchema),
  }),
]);

// ---------------------------------------------------------------------------
// Links + link types
// ---------------------------------------------------------------------------

export const linkResponseSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  teamId: z.uuid(),
  linkTypeId: z.uuid(),
  fromRecordId: z.uuid(),
  toRecordId: z.uuid(),
  props: jsonMap,
  source: ontologySourceSchema,
  confidence: z.string().nullable(),
  validFrom: z.coerce.date().nullable(),
  validTo: z.coerce.date().nullable(),
  recordedAt: z.coerce.date().nullable(),
  invalidatedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

export const linkTypeResponseSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  teamId: z.uuid().nullable(),
  key: z.string(),
  normalizedKey: z.string(),
  label: z.string(),
  fromObjectTypeId: z.uuid(),
  toObjectTypeId: z.uuid().nullable(),
  inverseKey: z.string().nullable(),
  inverseLabel: z.string().nullable(),
  cardinality: linkCardinalitySchema,
  isTemporal: z.boolean(),
  enabled: z.boolean(),
  status: ontologyStatusSchema,
  source: ontologySourceSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// A link endpoint record carries only its registry columns — never the typed
// `data` (that lives in the per-type extension table and isn't fetched for link
// chips). So the nested toRecord/fromRecord omit `data`/`computed`.
const linkedRecordSchema = objectRecordResponseSchema.omit({
  data: true,
  computed: true,
});

// Nested relations are NOT NULL in the DB, but the relational query types
// them nullable — mirror that here so the service return validates cleanly.
const outgoingLinkResponseSchema = linkResponseSchema.extend({
  toRecord: linkedRecordSchema.nullable(),
  linkType: linkTypeResponseSchema.nullable(),
});

const incomingLinkResponseSchema = linkResponseSchema.extend({
  fromRecord: linkedRecordSchema.nullable(),
  linkType: linkTypeResponseSchema.nullable(),
});

export const objectRecordWithLinksResponseSchema =
  objectRecordResponseSchema.extend({
    outgoingLinks: z.array(outgoingLinkResponseSchema),
    incomingLinks: z.array(incomingLinkResponseSchema),
  });

export const recordLinksResponseSchema = z.object({
  outgoing: z.array(outgoingLinkResponseSchema),
  incoming: z.array(incomingLinkResponseSchema),
});

/**
 * A list row optionally carrying a lightweight outgoing-relation summary
 * (`?withLinks=true`) — just enough for relation chips in the views.
 */
export const recordLinkSummarySchema = z.object({
  id: z.uuid(),
  linkType: z.object({ key: z.string(), label: z.string() }),
  toRecord: z.object({
    id: z.uuid(),
    label: z.string(),
    objectTypeId: z.uuid(),
  }),
});

export const objectRecordListItemSchema = objectRecordResponseSchema.extend({
  outgoingLinks: z.array(recordLinkSummarySchema).optional(),
});

export const createLinkRequestSchema = z.object({
  linkTypeId: z.uuid(),
  fromRecordId: z.uuid(),
  toRecordId: z.uuid(),
  props: jsonMap.optional(),
});

export const createLinkTypeRequestSchema = z.object({
  // Optional: omitted from the UI and derived server-side from the label.
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(
      /^[a-z][a-z0-9_]{0,58}[a-z0-9]$|^[a-z]$/,
      "Key must be snake_case (lowercase letters, digits, underscores)",
    )
    .optional(),
  label: z.string().trim().min(1),
  fromObjectTypeId: z.uuid(),
  toObjectTypeId: z.uuid().nullish(),
  inverseKey: z.string().trim().max(60).nullish(),
  inverseLabel: z.string().trim().nullish(),
  cardinality: linkCardinalitySchema.default("many_to_many"),
});

// ---------------------------------------------------------------------------
// Activity timeline (folded from domain_events)
// ---------------------------------------------------------------------------

export const recordHistoryResponseSchema = z.object({
  recordId: z.uuid(),
  fields: z.record(
    z.string(),
    z.array(
      z.object({
        value: z.unknown(),
        at: z.coerce.date(),
        eventId: z.uuid(),
        eventType: z.string(),
      }),
    ),
  ),
  events: z.array(
    z.object({
      id: z.uuid(),
      type: z.string(),
      occurredAt: z.coerce.date(),
      actorType: z.string(),
      actorName: z.string().nullable(),
      changedKeys: z.array(z.string()),
    }),
  ),
});
