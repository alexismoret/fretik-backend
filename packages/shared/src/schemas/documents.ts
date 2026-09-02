import { z } from "@hono/zod-openapi";
import {
  documentSourceEnum,
  documentStatusEnum,
  documentVersionActorEnum,
} from "../db/schema";
import { fieldDefinitionResponseSchema } from "./field-definitions";
import { FolderBreadcrumbSchema } from "./folders";

export const documentStatusSchema = z.enum(documentStatusEnum.enumValues);
export const documentSourceSchema = z.enum(documentSourceEnum.enumValues);

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
  onConflict: z.enum(["ask", "replace", "keepBoth"]).optional().openapi({
    description:
      "What to do when the folder already holds a different file with this name. `ask` (default) answers 409 DOCUMENT_NAME_CONFLICT with the existing document's id in `details`; `replace` files the bytes as a new version of it; `keepBoth` uploads under `name (2).ext`. Identical bytes are never a conflict.",
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
  source: documentSourceSchema,
  errorMessage: z.string().nullable(),
  originalFilename: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  uploadedById: z.uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DocumentResponse = z.infer<typeof DocumentResponseSchema>;

// ==================== //
// AUTHORING + VERSIONS //
// ==================== //

/** Cap on a document's markdown. Generous for prose, small enough that a
 * runaway agent write is refused at the boundary rather than in S3. */
const MAX_AUTHORED_CONTENT_BYTES = 512 * 1024;

const authoredContentSchema = z
  .string()
  .max(MAX_AUTHORED_CONTENT_BYTES)
  .openapi({ description: "The document's markdown, in full." });

export const CreateAuthoredDocumentSchema = z.object({
  title: z.string().min(1).max(200).openapi({
    description: "Document title — becomes its filename.",
    example: "Q3 review",
  }),
  content: authoredContentSchema.default(""),
  folderId: z.uuid().nullish().openapi({
    description: "Destination folder. Omit for the Drive root.",
  }),
});

export const SaveAuthoredContentSchema = z.object({
  content: authoredContentSchema,
  /**
   * The `updatedAt` the client last saw. Sent back so a save that would
   * overwrite someone else's is refused with 409 `DOCUMENT_STALE` instead of
   * silently winning.
   */
  baseUpdatedAt: z.coerce.date().optional(),
});

export const AuthoredContentResponseSchema = z.object({
  document: DocumentResponseSchema,
  content: z.string(),
});

export const DocumentVersionSchema = z.object({
  id: z.uuid(),
  versionNumber: z.number(),
  operation: z.string().openapi({
    description: "`create` · `edit` · `replace` · `restore`.",
  }),
  fileSize: z.number(),
  byActor: z.enum(documentVersionActorEnum.enumValues),
  /**
   * How it happened. `manual` and `assistant` both name a person in
   * `byUserName`; only `workflow` may have nobody behind it.
   */
  origin: z.enum(["manual", "assistant", "workflow"]),
  byUserId: z.uuid().nullable(),
  byUserName: z.string().nullable(),
  byConversationId: z.uuid().nullable(),
  isCurrent: z.boolean(),
  createdAt: z.date(),
});

/** What an upload actually did — see `UploadDocumentResult`. */
export const UploadOutcomeSchema = z.enum([
  "created",
  "replaced",
  "alreadyPresent",
]);

export const DocumentVersionDownloadSchema = z.object({
  /** Presigned, short-lived, and marked as an attachment. */
  url: z.url(),
  /** The name the file saves under — the document's, carrying `(v3)`. */
  filename: z.string(),
});

export const SaveAuthoredContentResponseSchema = z.object({
  document: DocumentResponseSchema,
  // `origin`, `byUserName` and `isCurrent` are history-listing concerns, resolved
  // by joins this path does not run: the caller of a save already knows who
  // just wrote, and the version it gets back is by definition the current one.
  version: DocumentVersionSchema.omit({
    byUserName: true,
    isCurrent: true,
    origin: true,
  }),
  /** True when the content matched what was stored — no version was created. */
  unchanged: z.boolean(),
});

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
