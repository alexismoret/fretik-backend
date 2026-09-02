import { z } from "@hono/zod-openapi";
import { paramsListSchema } from "./common/params";
import { responseListSchema } from "./common/responses";
import { documentStatusSchema } from "./documents";
import { recordFilterSchema, type RecordFilter } from "./ontology";

/**
 * Drive list params: pagination + search + advanced filters.
 *
 * `search` stays typed. Advanced filters use the same `RecordFilter[]` model as
 * the objects records list — the drive filters documents by the typed fields of
 * their `document` object mirror, so the field → operator → value shape and the
 * server-side predicate builder are shared, not duplicated.
 */
export const driveListParamsSchema = paramsListSchema.extend({
  // JSON-encoded `RecordFilter[]` (query params are strings; ofetch can't carry
  // an array of objects). Malformed input degrades to "no filters" rather than
  // erroring the list — matches `recordListQuerySchema`.
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
    })
    .openapi({
      description:
        "Field filters on the documents' `document` object mirror. JSON-encoded `RecordFilter[]` — each `{ key, op, value }`, AND across entries.",
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
 * category) without joining the full definitions on every row —
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
