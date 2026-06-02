/**
 * Canonical vocabulary of `code` values returned by chatbot tools in
 * their `{ error, code }` failure envelopes (see `src/tools/README.md`).
 *
 * Single source of truth: every tool references `TOOL_ERROR_CODES.*`
 * instead of inlining a string literal, so the set is searchable,
 * refactorable, and stays consistent across tools that share a failure
 * mode (e.g. `NO_CONVERSATION`, `INTERNAL_ERROR`, `SANDBOX_*`).
 *
 * Codes are grouped by origin. When adding a tool, reuse an existing
 * code where the failure mode matches; only add a new one for a
 * genuinely distinct, actionable failure.
 */
export const TOOL_ERROR_CODES = {
  // Runtime context (per-request state missing)
  NO_CONVERSATION: "NO_CONVERSATION",
  MEMORY_REQUIRES_USER: "MEMORY_REQUIRES_USER",

  // Catch-all for unexpected internal failures
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // E2B sandbox (mapped from SDK errors in `_e2b-errors.ts`)
  SANDBOX_NOT_FOUND: "SANDBOX_NOT_FOUND",
  SANDBOX_TIMEOUT: "SANDBOX_TIMEOUT",
  SANDBOX_RATE_LIMIT: "SANDBOX_RATE_LIMIT",
  SANDBOX_UNAVAILABLE: "SANDBOX_UNAVAILABLE",
  SANDBOX_WRITE_FAILED: "SANDBOX_WRITE_FAILED",

  // Code execution
  NON_ZERO_EXIT: "NON_ZERO_EXIT",
  PYTHON_ERROR: "PYTHON_ERROR",

  // Filesystem / read
  PATH_OUT_OF_SANDBOX: "PATH_OUT_OF_SANDBOX",
  READ_ONLY_PATH: "READ_ONLY_PATH",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  READ_ERROR: "READ_ERROR",
  READ_FAILED: "READ_FAILED",
  BINARY_NOT_READABLE: "BINARY_NOT_READABLE",
  NO_OCR_SIDECAR: "NO_OCR_SIDECAR",

  // Vision
  UNSUPPORTED_EXTENSION: "UNSUPPORTED_EXTENSION",
  UNSUPPORTED_VISION_TYPE: "UNSUPPORTED_VISION_TYPE",
  VISION_ERROR: "VISION_ERROR",

  // Storage / S3 / Drive download
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  NOT_READY: "NOT_READY",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  S3_FETCH_FAILED: "S3_FETCH_FAILED",
  S3_OBJECT_MISSING: "S3_OBJECT_MISSING",
  S3_UPLOAD_FAILED: "S3_UPLOAD_FAILED",

  // Domain query tools
  GET_ENTITY_DETAILS_ERROR: "GET_ENTITY_DETAILS_ERROR",
  LIST_ENTITIES_ERROR: "LIST_ENTITIES_ERROR",
  LIST_DOCUMENTS_ERROR: "LIST_DOCUMENTS_ERROR",
  RAG_ERROR: "RAG_ERROR",

  // Memory
  MEMORY_INVALID_INPUT: "MEMORY_INVALID_INPUT",
  MEMORY_HTTP_ERROR: "MEMORY_HTTP_ERROR",

  // Web (Tavily)
  TAVILY_TIMEOUT: "TAVILY_TIMEOUT",
  WEB_FETCH_ERROR: "WEB_FETCH_ERROR",
  WEB_FETCH_EMPTY: "WEB_FETCH_EMPTY",
  WEB_SEARCH_ERROR: "WEB_SEARCH_ERROR",
} as const;

export type ToolErrorCode =
  (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];
