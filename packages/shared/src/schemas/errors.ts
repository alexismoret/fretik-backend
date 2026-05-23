import { z } from "zod";

/**
 * Known error codes used throughout the API
 * This provides autocomplete and type safety for error codes
 */
export const ERROR_CODES = {
  // Auth & Access
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  TEAM_REQUIRED: "TEAM_REQUIRED",

  // Resource errors
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXIST: "ALREADY_EXIST",

  // Validation
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BAD_REQUEST: "BAD_REQUEST",

  // File operations
  NO_FILES: "NO_FILES",
  TOO_MANY_FILES: "TOO_MANY_FILES",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  INVALID_FILE_TYPE: "INVALID_FILE_TYPE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  UPLOAD_ERROR: "UPLOAD_ERROR",
  CONVERSATION_FILE_LIMIT_REACHED: "CONVERSATION_FILE_LIMIT_REACHED",
  FILE_ALREADY_EXISTS: "FILE_ALREADY_EXISTS",

  // AI context (Projects-style user/team context)
  MUTE_NOT_ALLOWED: "MUTE_NOT_ALLOWED",

  // AI memory (agent-writable memory tool)
  MEMORY_INVALID_PATH: "MEMORY_INVALID_PATH",
  MEMORY_FILE_EXISTS: "MEMORY_FILE_EXISTS",
  MEMORY_FILE_NOT_FOUND: "MEMORY_FILE_NOT_FOUND",
  MEMORY_TOO_LARGE: "MEMORY_TOO_LARGE",
  MEMORY_RENAME_DEST_EXISTS: "MEMORY_RENAME_DEST_EXISTS",
  MEMORY_PATTERN_TOO_GENERIC: "MEMORY_PATTERN_TOO_GENERIC",

  // Database
  TEAM_SETTINGS_NOT_FOUND: "TEAM_SETTINGS_NOT_FOUND",
  DATABASE_ERROR: "DATABASE_ERROR",

  // Skills (team-toggle UI / API)
  SKILL_NOT_FOUND: "SKILL_NOT_FOUND",
  SKILL_NOT_TOGGLEABLE: "SKILL_NOT_TOGGLEABLE",
  SKILL_INVALID_NAME: "SKILL_INVALID_NAME",
  SKILL_INVALID_DESCRIPTION: "SKILL_INVALID_DESCRIPTION",
  SKILL_INVALID_BODY: "SKILL_INVALID_BODY",
  SKILL_BUNDLED_READONLY: "SKILL_BUNDLED_READONLY",
  SKILL_CAP_REACHED: "SKILL_CAP_REACHED",

  // External apps (Nango connections + tool approval gate)
  EXTERNAL_APP_PROVIDER_NOT_FOUND: "EXTERNAL_APP_PROVIDER_NOT_FOUND",
  EXTERNAL_APP_CONNECTION_NOT_FOUND: "EXTERNAL_APP_CONNECTION_NOT_FOUND",
  EXTERNAL_APP_NO_CONNECTION: "EXTERNAL_APP_NO_CONNECTION",
  EXTERNAL_APP_AMBIGUOUS_CONNECTION: "EXTERNAL_APP_AMBIGUOUS_CONNECTION",
  EXTERNAL_APP_NANGO_VERIFY_FAILED: "EXTERNAL_APP_NANGO_VERIFY_FAILED",
  EXTERNAL_APP_INVALID_ACTION: "EXTERNAL_APP_INVALID_ACTION",
  EXTERNAL_APP_PLAN_INVALID: "EXTERNAL_APP_PLAN_INVALID",
  EXTERNAL_APP_PLAN_EXECUTING: "EXTERNAL_APP_PLAN_EXECUTING",
  EXTERNAL_APP_PLAN_REJECTED: "EXTERNAL_APP_PLAN_REJECTED",
  TOOL_APPROVAL_NOT_FOUND: "TOOL_APPROVAL_NOT_FOUND",
  TOOL_APPROVAL_WRONG_STATUS: "TOOL_APPROVAL_WRONG_STATUS",

  // Generic
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Base error schema for API error responses
 */
export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  details: z.union([z.string(), z.array(z.string())]).optional(),
});

export type ApiError = z.infer<typeof ErrorSchema>;

/**
 * Type guard to validate if an unknown object is an ApiError
 */
export const isApiError = (obj: unknown): obj is ApiError => {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "code" in obj &&
    typeof (obj as Record<string, unknown>).code === "string"
  );
};

/**
 * Parse an error message that might be JSON-encoded ApiError
 */
export const parseApiError = (message: string): ApiError | null => {
  try {
    const parsed: unknown = JSON.parse(message);
    if (isApiError(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};
