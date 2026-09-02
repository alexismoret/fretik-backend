import { z } from "@hono/zod-openapi";
import {
  aiContextFileStatusEnum,
  aiContextScopeEnum,
} from "../db/schema/ai-context";

/**
 * HTTP schemas for the `/chatbot-context/*` routes. Kept in one file
 * alongside the other per-domain schema modules (`documents.ts`, …) so
 * handlers stay thin and every payload shape is reusable by the frontend
 * TanStack Query layer via `@fretik/shared/schemas`.
 */

// ==================== //
// ENUMS                //
// ==================== //

export const aiContextScopeSchema = z.enum(aiContextScopeEnum.enumValues);
export type AiContextScopeValue = z.infer<typeof aiContextScopeSchema>;

export const aiContextFileStatusSchema = z.enum(
  aiContextFileStatusEnum.enumValues,
);
export type AiContextFileStatusValue = z.infer<
  typeof aiContextFileStatusSchema
>;

// ==================== //
// PATH PARAMS          //
// ==================== //

export const scopeParamSchema = z.object({
  scope: aiContextScopeSchema.openapi({
    param: { name: "scope", in: "path" },
    example: "team",
  }),
});

export const scopeAndFileIdParamSchema = scopeParamSchema.extend({
  fileId: z.uuid().openapi({ param: { name: "fileId", in: "path" } }),
});

// ==================== //
// REQUEST BODIES       //
// ==================== //

/**
 * Instructions payload. Cap aligned with Anthropic Projects (custom
 * instructions fit comfortably in 100k chars — beyond that, users
 * should split context into files instead).
 */
export const updateContextInstructionsSchema = z.object({
  instructions: z.string().max(100_000),
});

export type UpdateContextInstructionsInput = z.infer<
  typeof updateContextInstructionsSchema
>;

const fileSchema = z.custom<File>(
  (val) => val instanceof Blob,
  "Expected a file",
);

export const uploadContextFileSchema = z.object({
  file: fileSchema.openapi({
    type: "string",
    format: "binary",
    description:
      "File to upload (PDF / DOCX / PPTX / XLSX / XLS / CSV / TXT / MD / JSON / image).",
  }),
});

export const toggleContextFileEnabledSchema = z.object({
  enabled: z.boolean(),
});

export const muteContextResourceSchema = z.object({
  muted: z.boolean(),
});

// ==================== //
// RESPONSE SHAPES      //
// ==================== //

export const contextFileSummarySchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  status: aiContextFileStatusSchema,
  errorMessage: z.string().nullable(),
  charCount: z.number().int().nullable(),
  pageCount: z.number().int().nullable(),
  enabled: z.boolean(),
  mutedByMe: z.boolean(),
  uploadedById: z.uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ContextFileSummaryResponse = z.infer<
  typeof contextFileSummarySchema
>;

export const contextProfileSummarySchema = z.object({
  id: z.string(),
  scope: aiContextScopeSchema,
  instructions: z.string(),
  mutedByMe: z.boolean(),
  updatedById: z.uuid().nullable(),
  updatedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  updatedAt: z.date(),
});

export type ContextProfileSummaryResponse = z.infer<
  typeof contextProfileSummarySchema
>;

export const contextProfileResponseSchema = z.object({
  profile: contextProfileSummarySchema,
  files: z.array(contextFileSummarySchema),
  totalCharCount: z.number().int(),
  tokenEstimate: z.number().int(),
});

export type ContextProfileResponse = z.infer<
  typeof contextProfileResponseSchema
>;

export const contextFileContentResponseSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mimeType: z.string(),
  content: z.string().nullable(),
});

export const contextFileDownloadResponseSchema = z.object({
  url: z.url(),
});

export const contextOkResponseSchema = z.object({
  ok: z.literal(true),
});

export const contextProfileIdResponseSchema = z.object({
  id: z.uuid(),
});
