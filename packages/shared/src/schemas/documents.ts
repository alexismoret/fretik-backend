import { z } from "zod";
import { documentStatusEnum } from "../db/schema";
import { fieldDefinitionResponseSchema } from "./field-definitions";
import { FolderBreadcrumbSchema } from "./folders";

export const documentStatusSchema = z.enum(documentStatusEnum.enumValues);

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
 * Lightweight recent-document row for the home "Recent files" card — the
 * columns needed to render a file row (name, kind, size, status, when) without
 * the presigned URL / properties / field-value payload of the detail route.
 */
export const RecentDocumentSchema = z.object({
  id: z.uuid(),
  originalFilename: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  status: documentStatusSchema,
  folderId: z.uuid().nullable(),
  createdAt: z.date(),
});

export type RecentDocument = z.infer<typeof RecentDocumentSchema>;

/**
 * Document details response schema (with universal properties, uploader, folder,
 * dynamic field values + their definitions for rendering).
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
      documentLanguage: z.string().nullable(),
      documentSummary: z.string(),
      confidenceScore: z.number().nullable(),
      completedAt: z.date(),
      createdAt: z.date(),
    })
    .nullable(),
  breadcrumbs: z.array(FolderBreadcrumbSchema),
  /**
   * Per-document custom field values, keyed by `fieldDefinitions.key`.
   * Values are JSON primitives or arrays (multi_select) — the type is
   * declared on the corresponding `fieldDefinitions` entry.
   */
  fieldValues: z.record(z.string(), z.unknown()),
  /**
   * Definitions resolved for the document's team, so the frontend can
   * render the right panel + edit form without a second round-trip.
   */
  fieldDefinitions: z.array(fieldDefinitionResponseSchema),
});

export type GetDocumentDetailsResponse = z.infer<
  typeof GetDocumentDetailsResponseSchema
>;

/**
 * Update document schema. Universal fields stay typed; custom fields go
 * through `fieldValues` keyed by definition slug. `null` value clears the
 * key for the document; absence leaves it untouched.
 */
export const UpdateDocumentSchema = z.object({
  originalFilename: z.string().optional(),
  folderId: z.uuid().nullish(),
  documentSummary: z.string().min(1).max(500).optional(),
  documentLanguage: z.string().length(2).nullish(),
  fieldValues: z.record(z.string(), z.unknown()).optional(),
});

export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;
