import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { ERROR_CODES, type ApiError } from "../schemas/errors";

/**
 * Throws an HTTPException with a JSON-encoded error message
 * Use this in services to propagate errors to handlers
 */
export const throwHttpError = (
  status: ContentfulStatusCode,
  error: ApiError,
): never => {
  throw new HTTPException(status, { message: JSON.stringify(error) });
};

/**
 * Creates an ApiError object without throwing
 * Use this when you need to return an error response directly in a handler
 */
export const createApiError = (
  code: string,
  message?: string,
  details?: string | string[],
): ApiError => ({
  code,
  message,
  details,
});

// ==================== //
// PRE-BUILT ERROR HELPERS //
// ==================== //

/**
 * 404 - Resource not found
 */
export const notFound = (message = "Resource not found"): ApiError => ({
  code: ERROR_CODES.NOT_FOUND,
  message,
});

/**
 * 400 - Bad request / validation error
 */
export const badRequest = (
  message?: string,
  details?: string | string[],
): ApiError => ({
  code: ERROR_CODES.BAD_REQUEST,
  message: message ?? "Invalid request",
  details,
});

/**
 * 400 - Validation error with details
 */
export const validationError = (
  details: string | string[],
  message?: string,
): ApiError => ({
  code: ERROR_CODES.VALIDATION_ERROR,
  message: message ?? "Validation failed",
  details,
});

/**
 * 403 - Forbidden / permission denied
 */
export const forbidden = (
  message = "You do not have permission to access this resource",
): ApiError => ({
  code: ERROR_CODES.FORBIDDEN,
  message,
});

/**
 * 403 - Team required in session
 */
export const teamRequired = (): ApiError => ({
  code: ERROR_CODES.TEAM_REQUIRED,
  message: "No active team found in session",
});

/**
 * 409 - Resource already exists
 */
export const alreadyExists = (
  message = "Resource already exists",
): ApiError => ({
  code: ERROR_CODES.ALREADY_EXIST,
  message,
});

/**
 * 500 - Internal server error
 */
export const internalError = (
  message = "An unexpected error occurred",
  details?: string,
): ApiError => ({
  code: ERROR_CODES.INTERNAL_ERROR,
  message,
  details,
});

// ==================== //
// FILE-SPECIFIC ERRORS //
// ==================== //

/**
 * 400 - No files provided
 */
export const noFiles = (): ApiError => ({
  code: ERROR_CODES.NO_FILES,
  message: "No files provided",
});

/**
 * 400 - Too many files
 */
export const tooManyFiles = (maxFiles: number): ApiError => ({
  code: ERROR_CODES.TOO_MANY_FILES,
  message: `Maximum ${maxFiles} files allowed`,
});

/**
 * 400 - File validation errors
 */
export const fileValidationError = (details: string[]): ApiError => ({
  code: ERROR_CODES.VALIDATION_ERROR,
  message: "File validation failed",
  details,
});

/**
 * 413 - File exceeds the per-file size cap.
 */
export const fileTooLarge = (
  filename: string,
  sizeBytes: number,
  maxBytes: number,
): ApiError => ({
  code: ERROR_CODES.FILE_TOO_LARGE,
  message: `File "${filename}" is too large (${sizeBytes.toString()} bytes). Max ${maxBytes.toString()} bytes.`,
});

/**
 * 415 - File MIME type is not accepted.
 */
export const unsupportedMediaType = (mimeType: string): ApiError => ({
  code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
  message: `Unsupported file type: ${mimeType}`,
});

/**
 * 409 - The conversation has reached the maximum number of attached files.
 */
export const conversationFileLimitReached = (max: number): ApiError => ({
  code: ERROR_CODES.CONVERSATION_FILE_LIMIT_REACHED,
  message: `This conversation has reached the maximum of ${max.toString()} files.`,
});

// ==================== //
// DATABASE ERRORS      //
// ==================== //

/**
 * 500 - Team settings not found
 */
export const teamSettingsNotFound = (teamId: string): ApiError => ({
  code: ERROR_CODES.TEAM_SETTINGS_NOT_FOUND,
  message: `No settings found for team ${teamId}`,
});
