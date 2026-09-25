import { z } from "@hono/zod-openapi";
import { documentStatusEnum } from "../db/schema";
import { accessLevelSchema } from "./access";
import { paramsListSchema } from "./common/params";
import { responseListSchema } from "./common/responses";
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

/** Hard cap on a folder description — see `services/folders/describe.ts`:
 * sixty of these ride one filing decision inside a 32k context window. */
export const FOLDER_DESCRIPTION_MAX_CHARS = 220;

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
})
  .partial()
  .extend({
    /**
     * What this folder is for, read by the Drive filer when a document arrives
     * with no destination. Setting it marks the description MANUAL, after which
     * the nightly generator never touches it again — a person saying where
     * things should go outranks anything inferred from what is already inside.
     *
     * Empty string clears it back to automatic.
     */
    description: z.string().max(FOLDER_DESCRIPTION_MAX_CHARS).nullish(),
  });

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
  /** What this folder is for — what the Drive filer matches against. */
  description: z.string().nullable(),
  /** `manual` once a person has written it, `agent` when the assistant did;
   * the generator leaves both be. */
  descriptionSource: z.enum(["auto", "manual", "agent"]).nullable(),
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
 * A document the Drive filer placed, while it still sits where it was put.
 * `decisionId` is what "undo" and "that's right" act on.
 */
export const AutoFiledSchema = z.object({
  decisionId: z.uuid(),
  /** The model's certainty. Null when the transport did not report one. */
  confidence: z.number().min(0).max(1).nullable(),
  filedAt: z.date(),
  /** A person has said this is the right folder. */
  confirmed: z.boolean(),
});

export type AutoFiled = z.infer<typeof AutoFiledSchema>;

/** Where a document sits after its automatic filing was undone or confirmed. */
export const FilingFeedbackResponseSchema = z.object({
  id: z.uuid(),
  folderId: z.uuid().nullable(),
});

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
  // Read from the DB enum, not `./documents`: that module imports this one,
  // and the cycle broke whichever side a process happened to load first.
  status: z.enum(documentStatusEnum.enumValues),
  /** The project its tree belongs to; null for its team's Drive. */
  projectId: z.uuid().nullable(),
  fieldValues: z.record(z.string(), z.unknown()),
  /** Null unless the filer placed it and it has not been moved since. */
  autoFiled: AutoFiledSchema.nullable(),
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
