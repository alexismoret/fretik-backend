import { z } from "zod";

/**
 * Schema for single resource identifier parameter
 * Used in routes like GET /resource/:id, DELETE /resource/:id
 */
export const paramsIdSchema = z.object({
  id: z
    .uuid()
    .openapi({
      example: "01933eb8-541f-7000-a9f4-e4eee80ff04e",
      description: "UUID v7 identifier for the resource (time-ordered UUID)",
    })
    .describe("Unique identifier in UUID v7 format"),
});

export type ParamsId = z.infer<typeof paramsIdSchema>;

/**
 * Schema for optional single resource identifier parameter
 * Used in routes like GET /resource/:id, DELETE /resource/:id
 */
export const optionalParamsIdSchema = z.object({
  id: z
    .uuid()
    .optional()
    .openapi({
      example: "01933eb8-541f-7000-a9f4-e4eee80ff04e",
      description: "UUID v7 identifier for the resource (time-ordered UUID)",
    })
    .describe("Unique identifier in UUID v7 format"),
});

export type OptionalParamsId = z.infer<typeof optionalParamsIdSchema>;

/**
 * Schema for list/pagination query parameters
 * Used in routes like GET /resources
 */
export const paramsListSchema = z.object({
  limit: z.coerce
    .number()
    .nonnegative()
    .max(50)
    .default(25)
    .openapi({
      example: 25,
      minimum: 0,
      maximum: 50,
      description:
        "Controls pagination size. Maximum allowed is 50 items per page.",
    })
    .describe("Maximum number of items to return per page"),
  page: z.coerce
    .number()
    .nonnegative()
    .default(0)
    .openapi({
      example: 0,
      minimum: 0,
      description:
        "Zero-indexed page number. Use 0 for the first page, 1 for the second, etc.",
    })
    .describe("Page number for pagination (zero-indexed)"),
  search: z
    .string()
    .trim()
    .optional()
    .openapi({
      example: "example",
      description:
        "Case-insensitive search term. Filters results by matching against relevant fields.",
    })
    .describe("Search query string to filter results"),
});

export type ParamsList = z.infer<typeof paramsListSchema>;

/**
 * Extended list schema with folder filter
 * Used in routes that support folder-based filtering
 */
export const paramsListWithFolderSchema = paramsListSchema.extend({
  folderId: z
    .string()
    .uuid()
    .optional()
    .openapi({
      example: "01933eb8-541f-7000-a9f4-e4eee80ff04e",
      description: "Filter results by folder UUID",
    })
    .describe("Optional folder ID to filter results"),
});

export type ParamsListWithFolder = z.infer<typeof paramsListWithFolderSchema>;
