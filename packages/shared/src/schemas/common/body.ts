import { z } from "@hono/zod-openapi";

/**
 * Schema for single resource identifier parameter
 * Used in routes like GET /resource/:id, DELETE /resource/:id
 */
export const bodyIdListSchema = z.object({
  ids: z
    .array(z.uuid())
    .openapi({
      example: "[01933eb8-541f-7000-a9f4-e4eee80ff04e]",
      description:
        "UUID v7 identifier array for the resource (time-ordered UUID)",
    })
    .describe("Array of unique identifier in UUID v7 format"),
});
