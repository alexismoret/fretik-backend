import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseApiError, type ApiError } from "../schemas/errors";
import { internalError } from "./errors";

type ErrorStatusCode = 400 | 401 | 403 | 404 | 409 | 500;

/**
 * Global error handler for Hono services.
 *
 * - HTTPException with a JSON message produced by throwHttpError → parsed ApiError
 * - HTTPException with a plain message → wrapped as ApiError with code "HTTP_ERROR"
 * - Anything else → generic 500 internal error
 *
 * Usage:
 * ```ts
 * import { errorHandler } from "@fretik/shared/lib/error-handler";
 * app.onError(errorHandler);
 * ```
 */
export const errorHandler = (err: Error, c: Context) => {
  console.error("[Error Handler]", err);

  if (err instanceof HTTPException) {
    const status = err.status;
    const validStatus: ErrorStatusCode =
      status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 500
        ? status
        : 500;

    const apiError = parseApiError(err.message);
    if (apiError) {
      return c.json(apiError, validStatus);
    }

    return c.json(
      {
        code: "HTTP_ERROR",
        message: err.message,
      } satisfies ApiError,
      validStatus,
    );
  }

  const errorMessage = err instanceof Error ? err.message : "Unknown error";
  return c.json(
    internalError("An unexpected error occurred", errorMessage),
    500,
  );
};
