import { z } from "@hono/zod-openapi";

// ================== //
// SUCCESS RESPONSES  //
// ================== //

/**
 * Schema for responses returning a single ID (e.g., after creation)
 */
export const responseSuccessIdSchema = z.object({
  id: z
    .string()
    .uuid()
    .openapi({
      example: "01933eb8-541f-7000-a9f4-e4eee80ff04e",
      description: "UUID v7 of the newly created resource (time-ordered UUID)",
    })
    .describe("Unique identifier of the created resource"),
});

export type ResponseSuccessId = z.infer<typeof responseSuccessIdSchema>;

/**
 * Generic schema builder for paginated list responses
 */
export const responseListSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    count: z
      .number()
      .nonnegative()
      .openapi({
        example: 42,
        description:
          "Total count of items across all pages. Use this with limit and page to calculate total pages.",
      })
      .describe("Total number of items matching the query"),
    data: z.array(dataSchema),
  });

/**
 * The other half of `cursorParamSchema`: where the next page starts, or `null`
 * when this one is the last. Grafted onto whatever envelope a list already
 * returns rather than replacing it — a list that answers both a numbered
 * `page` and a `cursor` keeps one response shape, and the field simply stays
 * absent on the path that did not walk.
 */
export const nextCursorSchema = z
  .string()
  .nullable()
  .openapi({
    description:
      "Cursor to pass as `cursor` for the following page. Null when this is the last one.",
  })
  .describe("Cursor of the next page, or null at the end");

/**
 * Schema for delete operation responses
 */
export const responseDeleteSchema = z.object({
  rowCount: z
    .number()
    .nullish()
    .openapi({
      example: 1,
      description:
        "Number of database rows deleted. Typically 1 for single item deletion.",
    })
    .describe("Number of rows affected by the delete operation"),
});

export type ResponseDelete = z.infer<typeof responseDeleteSchema>;

// ======================== //
// RESPONSE SCHEMA BUILDERS //
// ======================== //

/**
 * Builder for success (200) response schemas
 */
export const responseSuccessSchemaBuilder = <T extends z.ZodTypeAny>(
  schema: T,
  description = "Request successful",
) => ({
  200: {
    content: {
      "application/json": { schema },
    },
    description,
  },
});

/**
 * Builder for created (201) response schemas
 */
export const responseCreatedSchemaBuilder = <T extends z.ZodTypeAny>(
  schema: T,
  description = "Resource created successfully",
) => ({
  201: {
    content: {
      "application/json": { schema },
    },
    description,
  },
});

/**
 * Pre-built success delete response schema
 */
export const responseSuccessDeleteSchema = responseSuccessSchemaBuilder(
  responseDeleteSchema,
  "Resource successfully deleted",
);

// =============== //
// ERROR RESPONSES //
// =============== //

/**
 * Base error schema for all error responses
 */
export const errorResponseSchema = z.object({
  code: z
    .string()
    .openapi({
      example: "VALIDATION_ERROR",
      description:
        "Unique error code for programmatic error handling. See API documentation for complete list.",
    })
    .describe("Machine-readable error code"),
  message: z
    .string()
    .optional()
    .openapi({
      example: "The provided input is invalid",
      description: "Detailed error message explaining what went wrong.",
    })
    .describe("Human-readable error message"),
  details: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .openapi({
      example: [
        "Field 'email' is required",
        "Field 'name' must be at least 2 characters",
      ],
      description:
        "Additional details about the error (validation errors, etc.)",
    })
    .describe("Additional error details"),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * 200 Success deleted
 */
export const responseSuccessDeletedSchema = {
  200: {
    content: {
      "application/json": {
        schema: responseDeleteSchema,
      },
    },
    description: "Success deleted",
  },
};

/**
 * 400 Bad Request - Validation errors or invalid input
 */
export const responseBadRequestSchema = {
  400: {
    content: {
      "application/json": {
        schema: errorResponseSchema,
        example: {
          code: "VALIDATION_ERROR",
          message: "Invalid input data",
        },
      },
    },
    description:
      "Bad Request - The request contains invalid data or missing required fields",
  },
};

/**
 * 401 Unauthorized - Authentication required
 */
export const responseUnauthorizedSchema = {
  401: {
    content: {
      "application/json": {
        schema: z.object({
          code: z.enum(["UNAUTHORIZED"]).openapi({
            description:
              "Returned when authentication is required but not provided",
          }),
        }),
        example: { code: "UNAUTHORIZED" },
      },
    },
    description:
      "Unauthorized - Authentication is required to access this resource",
  },
};

/**
 * 403 Forbidden - Insufficient permissions or missing context
 */
export const responseForbiddenSchema = {
  403: {
    content: {
      "application/json": {
        schema: errorResponseSchema,
        example: {
          code: "FORBIDDEN",
          message: "You do not have permission to access this resource",
        },
      },
    },
    description:
      "Forbidden - You do not have permission to perform this action",
  },
};

/**
 * 404 Not Found - Resource does not exist
 */
export const responseNotFoundSchema = {
  404: {
    content: {
      "application/json": {
        schema: z.object({
          code: z
            .enum(["NOT_FOUND"])
            .openapi({
              description:
                "Returned when the requested resource does not exist or has been deleted",
            })
            .describe(
              "Error code indicating the requested resource was not found",
            ),
        }),
        example: { code: "NOT_FOUND" },
      },
    },
    description:
      "Not Found - The requested resource does not exist or you do not have access to it",
  },
};

/**
 * 409 Conflict - Resource already exists
 */
export const responseAlreadyExistSchema = {
  409: {
    content: {
      "application/json": {
        schema: z.object({
          code: z
            .enum(["ALREADY_EXIST"])
            .openapi({
              description:
                "Returned when attempting to create a resource that would violate a uniqueness constraint",
            })
            .describe(
              "Error code indicating a resource with the same unique identifier already exists",
            ),
        }),
        example: { code: "ALREADY_EXIST" },
      },
    },
    description:
      "Conflict - A resource with the specified unique identifier already exists",
  },
};

/**
 * 409 Conflict — the request clashes with the resource's current state.
 *
 * Distinct from `responseAlreadyExistSchema`, which pins one code and carries
 * nothing else. This one keeps `details`, because the useful conflicts are the
 * ones the caller can act on: a name collision hands back the id of the
 * document already sitting there, so the client can offer to replace it.
 */
export const responseConflictSchema = {
  409: {
    content: {
      "application/json": {
        schema: z.object({
          code: z.string(),
          message: z.string().optional(),
          details: z.union([z.string(), z.array(z.string())]).optional(),
        }),
        example: {
          code: "DOCUMENT_NAME_CONFLICT",
          message: 'A different file named "report.pdf" is already here.',
          details: "018f3a3a-3a3a-3a3a-3a3a-3a3a3a3a3a3a",
        },
      },
    },
    description: "Conflict — the request clashes with the current state",
  },
};

/**
 * 500 Internal Server Error - Unexpected server error
 */
export const responseInternalErrorSchema = {
  500: {
    content: {
      "application/json": {
        schema: errorResponseSchema,
        example: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      },
    },
    description:
      "Internal Server Error - An unexpected error occurred on the server",
  },
};
