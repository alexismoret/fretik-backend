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
  s3Key: z.string().min(1),
  mimeType: z.string().min(1),
  originalFilename: z.string().min(1),
  teamId: z.uuid(),
  organizationId: z.uuid(),
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

  const { documentId, s3Key, mimeType } = parsed.data;

  try {
    const result = await runPreExtract({ documentId, s3Key, mimeType });
    return c.json(result, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[pre-extract] failed for document ${documentId} (s3Key=${s3Key}):`,
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
