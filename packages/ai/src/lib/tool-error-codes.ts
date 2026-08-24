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
  // The action needs an authenticated user and this session has none. NOT an
  // input-shape code on purpose: no argument the model can change fixes it, so
  // the loop guard must not steer it into "retry with the corrected shape".
  REQUIRES_USER: "REQUIRES_USER",

  // Page builder (managePage domain tool). The publish gate rejects a page the
  // agent must EDIT first (blank, cyclic, past the element/depth ceiling), so
  // it stays out of the input-shape family: re-sending the same publish call is
  // exactly the wrong move.
  PAGE_NOT_PUBLISHABLE: "PAGE_NOT_PUBLISHABLE",
  // The caller reached for authoring on the instance that only reads, tweaks
  // and publishes. Same family reasoning as above: no argument fixes it — the
  // work belongs to `buildPage`, so the loop guard must not steer a retry.
  PAGE_REQUIRES_BUILDER: "PAGE_REQUIRES_BUILDER",

  // Workflow (headless workflow-agent tools)
  NO_WORKFLOW_RUN: "NO_WORKFLOW_RUN",
  // Workflow builder (manageWorkflow domain tool)
  WORKFLOW_ERROR: "WORKFLOW_ERROR",
  WORKFLOW_NOT_FOUND: "WORKFLOW_NOT_FOUND",
  WORKFLOW_NOT_TESTED: "WORKFLOW_NOT_TESTED",

  // User-initiated Stop — the turn was aborted mid-tool (POST /:id/stop).
  // The model never reads this (the tool loop is aborted with it); it
  // documents intent and keeps the failure envelope canonical.
  ABORTED: "ABORTED",

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
  // Image / scan carries no extractable text → inspect visually with `vision`.
  NO_TEXT_CONTENT: "NO_TEXT_CONTENT",

  // Vision
  UNSUPPORTED_EXTENSION: "UNSUPPORTED_EXTENSION",
  UNSUPPORTED_VISION_TYPE: "UNSUPPORTED_VISION_TYPE",
  VISION_ERROR: "VISION_ERROR",

  // Structured extraction (`extract` tool). INVALID_ARGS = malformed call
  // shape (empty/oversized field list) — the loop guard forces a corrected
  // retry of the SAME tool from the worked example in the hint, never a switch
  // to python. INVALID_SCHEMA kept for back-compat (legacy `schema` arg path).
  INVALID_ARGS: "INVALID_ARGS",
  INVALID_SCHEMA: "INVALID_SCHEMA",
  INVALID_PAGE_RANGE: "INVALID_PAGE_RANGE",
  EXTRACT_ERROR: "EXTRACT_ERROR",

  // Prose transformation (`transform` tool)
  TRANSFORM_ERROR: "TRANSFORM_ERROR",
  EMPTY_SOURCE: "EMPTY_SOURCE",

  // Storage / S3 / Drive download
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  NOT_READY: "NOT_READY",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  S3_FETCH_FAILED: "S3_FETCH_FAILED",
  S3_OBJECT_MISSING: "S3_OBJECT_MISSING",
  S3_UPLOAD_FAILED: "S3_UPLOAD_FAILED",

  // Document authoring (manageDocument). The content moved since the agent
  // read it, so its edit anchors were composed against text that is gone. Its
  // own code, not an input-shape one: re-sending a corrected call shape is
  // exactly wrong — the fix is to read the document again. Same reasoning as
  // `PAGE_NOT_PUBLISHABLE`.
  DOCUMENT_STALE: "DOCUMENT_STALE",

  // Domain query tools
  LIST_DOCUMENTS_ERROR: "LIST_DOCUMENTS_ERROR",
  RAG_ERROR: "RAG_ERROR",
  // Drive management tools (uploadToDrive / manageDrive / listFolders):
  // invalid action args or a failed folder/document operation.
  DRIVE_ERROR: "DRIVE_ERROR",
  // Object graph (ontology) query tools
  OBJECT_QUERY_ERROR: "OBJECT_QUERY_ERROR",
  OBJECT_TYPE_NOT_FOUND: "OBJECT_TYPE_NOT_FOUND",

  // Memory
  MEMORY_INVALID_INPUT: "MEMORY_INVALID_INPUT",
  MEMORY_HTTP_ERROR: "MEMORY_HTTP_ERROR",

  // Web (Tavily)
  TAVILY_TIMEOUT: "TAVILY_TIMEOUT",
  WEB_FETCH_ERROR: "WEB_FETCH_ERROR",
  WEB_FETCH_EMPTY: "WEB_FETCH_EMPTY",
  WEB_SEARCH_ERROR: "WEB_SEARCH_ERROR",
  WEB_MAP_ERROR: "WEB_MAP_ERROR",
  // Deployment has no Tavily API key. Defensive backstop: the web tools are
  // pruned from every registry in that case (`pruneWebTools`), so the model
  // normally never sees them.
  WEB_TOOLS_UNCONFIGURED: "WEB_TOOLS_UNCONFIGURED",
  // Egress hardening (web-egress.ts): scheme/private-IP/length vs domain policy.
  WEB_FETCH_BLOCKED_TARGET: "WEB_FETCH_BLOCKED_TARGET",
  WEB_FETCH_DOMAIN_BLOCKED: "WEB_FETCH_DOMAIN_BLOCKED",
  // Tool-permission policy: the team set this tool to `blocked` (Settings →
  // Tool permissions). A backstop for a guessed/pruned tool name.
  TOOL_DISABLED_BY_POLICY: "TOOL_DISABLED_BY_POLICY",
} as const;

export type ToolErrorCode =
  (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

/**
 * Canonical failure envelope every chatbot tool returns instead of
 * throwing. A thrown error is opaque to the model; this object is a
 * normal tool result it can read, explain, or recover from. `hint`
 * (optional) gives the corrected call shape or next step.
 */
export interface ToolErrorOutput {
  error: string;
  code: ToolErrorCode;
  hint?: string;
}

/** Build a `ToolErrorOutput`. Use at every tool failure path. */
export const toolError = (
  code: ToolErrorCode,
  error: string,
  hint?: string,
): ToolErrorOutput =>
  hint === undefined ? { error, code } : { error, code, hint };
