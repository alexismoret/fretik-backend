import { fieldDefinitionResponseSchema } from "@fretik/shared/schemas/field-definitions";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { internalMiddleware } from "../middlewares/internal";
import { runPreExtract } from "../services/pre-extract";
import type { HonoInternalAppType } from "../types/hono";

/**
 * POST /internal/pre-extract
 *
 * Server-to-server pre-extraction endpoint called by `@fretik/shared`
 * (`services/documents/upload.ts`) after a document is uploaded and
 * converted to PDF/image on S3.
 *
 * Auth: `X-Internal-Key` + standard `X-Context-*` headers, enforced by
 * `internalMiddleware`. `teamId` / `organizationId` live on the request
 * body (not derived from headers) so the caller can pre-extract across
 * tenants in a batch without re-issuing context headers — same
 * convention as `/internal/vectorize`.
 *
 * The response shape is `preExtractionResponseSchema` (see
 * `@fretik/shared/schemas/pre-extraction`), used unchanged by the
 * caller's Zod validation.
 */

const PreExtractRequestSchema = z.object({
  documentId: z.uuid(),
  mimeType: z.string().min(1),
  originalFilename: z.string().min(1),
  teamId: z.uuid(),
  organizationId: z.uuid(),
  /**
   * Optional override for the S3 key to OCR. When omitted, the
   * pre-extract service derives `documents/{documentId}{ext}` from
   * `originalFilename`. The upload pipeline sets this to the
   * ephemeral conversion key (`documents/{documentId}-preextract.pdf`)
   * when Word/PPT/spreadsheet input has been converted before OCR.
   */
  overrideS3Key: z.string().min(1).optional(),
  /**
   * Hex SHA-256 of the ORIGINAL document bytes. The dedup key into the
   * shared `file_extractions` cache so a document already OCR'd on
   * another surface (e.g. attached to a chat) reuses the extraction.
   * Optional for back-compat; absence falls back to a direct OCR call.
   */
  fileHash: z.string().min(1).optional(),
  /**
   * Active team field definitions. Resolved by the caller in
   * `@fretik/shared/services/documents/upload.ts` and forwarded as-is so
   * the runtime Zod schema and `.describe()` strings reach the LLM. The
   * server re-uses the canonical schema for validation.
   */
  fieldDefinitions: z.array(fieldDefinitionResponseSchema).default([]),
});

const preExtractRoutes = new OpenAPIHono<HonoInternalAppType>();
preExtractRoutes.use("*", internalMiddleware);

preExtractRoutes.post("/", async (c) => {
  const raw: unknown = await c.req.json();
  const parsed = PreExtractRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: parsed.error.issues.map((i) => i.message),
      },
      400,
    );
  }

  const {
    documentId,
    mimeType,
    originalFilename,
    organizationId,
    overrideS3Key,
    fileHash,
    fieldDefinitions,
  } = parsed.data;

  try {
    const result = await runPreExtract({
      documentId,
      originalFilename,
      mimeType,
      organizationId,
      overrideS3Key,
      fileHash,
      fieldDefinitions,
      // From the internal context headers (X-Context-Team-Id) — drives the
      // team's workhorse pick for the primary pre-extract model (C8b).
      teamId: c.get("context").teamId,
    });
    return c.json(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[pre-extract] failed for document ${documentId} (override=${overrideS3Key ?? "none"}):`,
      message,
    );
    return c.json(
      {
        code: "PREEXTRACT_ERROR",
        message,
      },
      500,
    );
  }
});

export { preExtractRoutes };
