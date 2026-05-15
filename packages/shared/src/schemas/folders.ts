import { z } from "zod";
import { paramsListSchema } from "./common/params";
import { responseListSchema } from "./common/responses";
import {
  documentStatusSchema,
  documentTransportType,
  documentTypeSchema,
  transportModeSchema,
} from "./documents";

/**
 * Drive list params: pagination + search + advanced filters.
 *
 * All advanced filters accept multiple values. They can be passed either as
 * repeated query params (`?documentType=invoice&documentType=receipt`) or as
 * a single value (`?documentType=invoice`) — both are normalized to arrays.
 *
 * When any advanced filter array is non-empty the listing switches to a flat,
 * cross-folder, document-only mode (folders are hidden, folderId scope ignored).
 */
const toArray = <T>(val: unknown): T[] | undefined => {
  if (val === undefined || val === null || val === "") return undefined;
  return (Array.isArray(val) ? val : [val]) as T[];
};

export const driveListParamsSchema = paramsListSchema.extend({
  documentType: z
    .preprocess(toArray, z.array(z.lazy(() => documentTypeSchema)).optional())
    .openapi({
      description:
        "Filter by one or more document types (OR semantics within the filter).",
    }),
  transportMode: z
    .preprocess(toArray, z.array(z.lazy(() => transportModeSchema)).optional())
    .openapi({
      description:
        "Filter by one or more transport modes (OR semantics within the filter).",
    }),
  documentTransportType: z
    .preprocess(toArray, z.array(z.string()).optional())
    .openapi({
      description:
        "Filter by one or more transport document type codes (e.g. cmr, bl).",
    }),
  entityId: z.preprocess(toArray, z.array(z.uuid()).optional()).openapi({
    description:
      "Filter to documents linked to one or more entities (any role). OR semantics within the filter.",
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
 * Simplified document for drive view
 */
export const DriveDocumentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  fileSize: z.number().int(),
  mimeType: z.string(),
  thumbnailUrl: z.string().nullable(),
  documentType: z.lazy(() => documentTypeSchema),
  documentTransportType: z.lazy(() => documentTransportType.nullable()),
  status: z.lazy(() => documentStatusSchema),
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
