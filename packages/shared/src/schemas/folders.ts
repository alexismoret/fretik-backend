import { z } from "zod";
import { paramsListSchema } from "./common/params";
import { responseListSchema } from "./common/responses";
import { documentStatusSchema } from "./documents";

/**
 * Drive list params: pagination + search + advanced filters.
 *
 * Universal filters (search, entityId, labelIds) stay typed. Custom
 * filters target the per-team field definitions and are passed as
 * `customFilters[<fieldKey>]=value` (parsed by the handler into a list
 * of `{fieldKey, value}` predicates joined to `documentFieldValues`).
 */
const toArray = <T>(val: unknown): T[] | undefined => {
  if (val === undefined || val === null || val === "") return undefined;
  return (Array.isArray(val) ? val : [val]) as T[];
};

/**
 * A single dynamic filter predicate: equality on a `(fieldKey, value)`
 * pair stored in `document_field_values`. `value` is `unknown` because
 * the type is declared on the corresponding field definition; the
 * handler validates the shape before passing it to the search service.
 */
export const driveCustomFilterSchema = z.object({
  fieldKey: z.string().min(1).max(60),
  value: z.unknown(),
});

export type DriveCustomFilter = z.infer<typeof driveCustomFilterSchema>;

export const driveListParamsSchema = paramsListSchema.extend({
  entityId: z.preprocess(toArray, z.array(z.uuid()).optional()).openapi({
    description:
      "Filter to documents linked to one or more entities (any role). OR semantics within the filter.",
  }),
  labelIds: z.preprocess(toArray, z.array(z.uuid()).optional()).openapi({
    description:
      "Filter to documents tagged with one or more labels. OR semantics within the filter.",
  }),
  customFilters: z
    .preprocess((val) => {
      // The frontend serialises customFilters to JSON because ofetch can't
      // represent an array of objects in a query string (it collapses each
      // entry to "[object Object]"). Decode the JSON back to an array
      // before Zod validates the inner shape.
      if (val === undefined || val === null || val === "") return undefined;
      if (typeof val === "string") {
        try {
          return JSON.parse(val);
        } catch {
          return val; // let Zod produce a useful error
        }
      }
      return val;
    }, z.array(driveCustomFilterSchema).optional())
    .openapi({
      description:
        "Equality filters on dynamic document fields. JSON-encoded array of `{fieldKey, value}` pairs. `value` may be a scalar (eq match) or an array (ANY-of match for enum filters).",
    }),
});

export type DriveListParams = z.infer<typeof driveListParamsSchema>;

/**
 * Schéma de validation pour la création d'un dossier
 */
export const CreateFolderSchema = z.object({
  name: z.string().min(1).max(100),
  parentFolderId: z.uuid().nullish(),
});

export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;

/**
 * Schéma de validation pour la mise à jour d'un dossier
 */
export const UpdateFolderSchema = CreateFolderSchema.partial();

export type UpdateFolderInput = z.infer<typeof UpdateFolderSchema>;

export const FolderResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  teamId: z.uuid(),
  parentFolderId: z.uuid().nullable(),
  subFolderCount: z.number().int().min(0),
  documentCount: z.number().int().min(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type FolderResponse = z.infer<typeof FolderResponseSchema>;

/**
 * Breadcrumb item for navigation
 */
export const FolderBreadcrumbSchema = z.object({
  id: z.uuid().nullable(), // null for root
  name: z.string(),
});

export type FolderBreadcrumb = z.infer<typeof FolderBreadcrumbSchema>;

/**
 * Simplified document for drive view. Custom fields ride along via
 * `fieldValues` so the list view can render badges (e.g. document type,
 * transport mode) without joining the full definitions on every row —
 * the frontend has the resolved definitions from the parent drive query.
 */
export const DriveDocumentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  fileSize: z.number().int(),
  mimeType: z.string(),
  thumbnailUrl: z.string().nullable(),
  status: z.lazy(() => documentStatusSchema),
  fieldValues: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * Unified drive item (folder or document)
 */
export const DriveItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("folder"),
    data: FolderResponseSchema,
  }),
  z.object({
    type: z.literal("document"),
    data: DriveDocumentSchema,
  }),
]);

export type DriveItem = z.infer<typeof DriveItemSchema>;

/**
 * Response for a folder drive view
 */
export const FolderDriveResponseSchema = z.object({
  folder: FolderResponseSchema.nullable(), // null for root
  children: responseListSchema(DriveItemSchema),
  breadcrumbs: z.array(FolderBreadcrumbSchema),
});

export type FolderDriveResponse = z.infer<typeof FolderDriveResponseSchema>;
