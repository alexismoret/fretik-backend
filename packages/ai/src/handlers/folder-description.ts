import { access } from "@fretik/shared/authz/http";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { internalMiddleware } from "../middlewares/internal";
import { generateFolderDescription } from "../services/folder-description";
import type { HonoInternalAppType } from "../types/hono";

/**
 * POST /internal/folder-description
 *
 * Server-to-server: the nightly folder pass in @fretik/jobs hands over a
 * folder's name, path and the extraction summaries of what is inside it, and
 * gets back one sentence saying what the folder is for. That sentence is what
 * the Drive filer compares a new document against.
 *
 * The summaries travel in the BODY rather than being read here, for the same
 * reason `/internal/vectorize` takes its content: this service holds no
 * database handle for the Drive, and the caller already has the rows.
 */

const FolderDescriptionRequestSchema = z.object({
  folderName: z.string().min(1).max(300),
  folderPath: z.string().min(1).max(2000),
  /** Newest first, already filtered to non-empty by the caller. */
  summaries: z.array(z.string().min(1).max(2000)).min(1).max(20),
  maxChars: z.number().int().min(60).max(1000),
});

const folderDescriptionRoutes = new OpenAPIHono<HonoInternalAppType>();
folderDescriptionRoutes.use("*", internalMiddleware);

folderDescriptionRoutes.post(
  "/",
  access.internal(
    "The nightly folder pass sends summaries it already filtered; the text arrives in the body.",
  ),
  async (c) => {
    const raw: unknown = await c.req.json();
    const parsed = FolderDescriptionRequestSchema.safeParse(raw);
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

    try {
      const description = await generateFolderDescription({
        teamId: c.get("context").teamId,
        ...parsed.data,
      });
      return c.json({ description }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[folder-description] failed:", message);
      return c.json({ code: "FOLDER_DESCRIPTION_ERROR", message }, 500);
    }
  },
);

export { folderDescriptionRoutes };
