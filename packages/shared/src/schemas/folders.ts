import { z } from "@hono/zod-openapi";
import { accessLevelSchema } from "./access";
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
  projectId: z.uuid().optional().openapi({
    description:
      "The project whose Drive root to list. Omitted, the root of the team the caller has open. Ignored inside a folder, which belongs to its own place.",
  }),
});

export type DriveListParams = z.infer<typeof driveListParamsSchema>;

/**
 * Schéma de validation pour la création d'un dossier
 */
export const CreateFolderSchema = z.object({
  name: z.string().min(1).max(100),
  parentFolderId: z.uuid().nullish(),
  /**
   * The project whose root it is created at, when it has no parent. A folder
   * created in another belongs to that folder's project.
   */
  projectId: z.uuid().nullish(),
});

export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;

/**
 * Schéma de validation pour la mise à jour d'un dossier. Moving it into or
 * out of a project goes through `/projects/move`; a parent change keeps it
 * in the place its new parent is in.
 */
export const UpdateFolderSchema = CreateFolderSchema.omit({
  projectId: true,
}).partial();

export type UpdateFolderInput = z.infer<typeof UpdateFolderSchema>;

export const FolderResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  teamId: z.uuid(),
  /** The project it belongs to, with everything in its tree; null for a team's Drive. */
  projectId: z.uuid().nullable(),
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
  /** The project its tree belongs to; null for its team's Drive. */
  projectId: z.uuid().nullable(),
  fieldValues: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * Unified drive item (folder or document), with the caller's level on it:
 * its menu offers what that level allows (moving it or deleting it takes full
 * access), so it never offers what the server would refuse.
 */
export const DriveItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("folder"),
    data: FolderResponseSchema,
    level: accessLevelSchema,
  }),
  z.object({
    type: z.literal("document"),
    data: DriveDocumentSchema,
    level: accessLevelSchema,
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
  /**
   * The project whose Drive this is — its root, or a folder of its tree —
   * named so the path can start there. Null for a team's Drive.
   */
  project: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /**
   * The caller's level on the folder listed: adding to it takes edit. Null at
   * a root, where adding is contributing to the team or taking part in the
   * project (`authz/placement.ts`).
   */
  level: accessLevelSchema.nullable(),
});

export type FolderDriveResponse = z.infer<typeof FolderDriveResponseSchema>;
