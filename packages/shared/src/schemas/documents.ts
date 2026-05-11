import { z } from "zod";
import {
  documentStatusEnum,
  documentTypeEnum,
  transportModeEnum,
} from "../db/schema";
import { entityRoleSchema } from "./entities";

export const documentStatusSchema = z.enum(documentStatusEnum.enumValues);
export const documentTypeSchema = z.enum(documentTypeEnum.enumValues);
export const transportModeSchema = z.enum(transportModeEnum.enumValues);

export const documentTransportType = z.object({
  code: z.string(),
  icon: z.string().nullable(),
});

/**
 * Upload schema: single file + optional folder
 */
const fileSchema = z.custom<File>(
  (val) => val instanceof Blob,
  "Expected a file",
);

export const UploadDocumentSchema = z.object({
  file: fileSchema.openapi({
    type: "string",
    format: "binary",
    description: "File to upload",
  }),
  folderId: z.uuid().optional().openapi({
    description: "Optional folder ID to associate with the document",
    example: "018f3a3a-3a3a-3a3a-3a3a-3a3a3a3a3a3a",
  }),
});

export type UploadDocumentInput = z.infer<typeof UploadDocumentSchema>;

import { FolderBreadcrumbSchema } from "./folders";

/**
 * Document response schema (without pre-extraction data)
 */
export const DocumentResponseSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  folderId: z.uuid().nullable(),
  status: documentStatusSchema,
  errorMessage: z.string().nullable(),
  originalFilename: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  uploadedById: z.uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;

/**
 * Document details response schema (with properties, uploader, and folder).
 */
export const GetDocumentDetailsResponseSchema = DocumentResponseSchema.extend({
  uploadedBy: z
    .object({
      id: z.uuid(),
      name: z.string(),
      image: z.string().nullable(),
    })
    .nullable(),
  folder: z
    .object({
      id: z.uuid(),
      name: z.string(),
    })
    .nullable(),
  properties: z
    .object({
      id: z.uuid(),
      pageCount: z.number(),
      documentType: documentTypeSchema,
      documentLanguage: z.string().nullable(),
      documentSummary: z.string(),
      documentDate: z.date().nullable(),
      documentNumber: z.string().nullable(),
      transportMode: transportModeSchema.nullable(),
      documentTransportType: z.string().nullable(),
      completedAt: z.date(),
      createdAt: z.date(),
    })
    .nullable(),
  breadcrumbs: z.array(FolderBreadcrumbSchema),
  labels: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      color: z.string().nullable(),
    }),
  ),
});

export type GetDocumentDetailsResponse = z.infer<
  typeof GetDocumentDetailsResponseSchema
>;

/**
 * Update document schema
 */
export const UpdateDocumentSchema = z.object({
  originalFilename: z.string().optional(),
  folderId: z.uuid().nullish(),
  documentSummary: z.string().min(1).max(500).optional(),
  documentType: documentTypeSchema.optional(),
  documentTransportType: z.string().nullish(),
  documentDate: z.coerce.date().nullish(),
  documentNumber: z.string().nullish(),
  transportMode: transportModeSchema.nullish(),
  documentLanguage: z.string().length(2).optional(),
  labelId: z.uuid().nullish(),
  entities: z
    .array(
      z.object({
        entityId: z.uuid(),
        role: entityRoleSchema,
      }),
    )
    .optional(),
});

export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;
