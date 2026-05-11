/**
 * Chatbot file-attachment limits (Phase 11).
 *
 * Shared between backend (`@fretik/ai` upload service + handler guard)
 * and frontend (Nuxt app — `useChatFiles.addFiles` validation,
 * `ChatFilePicker` disabled state, dropzone hint). Frontend imports
 * this module directly via the `@fretik/shared` workspace dependency
 * so the two sides can never drift.
 *
 * Rationale for each cap — see
 * `chatbot-overhaul-progress.json::keyDecisions.chatFileLimits` and
 * `chatbot-overhaul-plan.md` Phase 11 decision 11.
 */

/**
 * Per-file size cap. 15 MB is 50% above the Drive document cap
 * (10 MB) to accommodate slightly larger PDFs users attach to chat
 * for analysis without promoting to Drive, still well under Claude's
 * 30 MB to keep OCR + hydration fast.
 */
export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

/**
 * Per-message cap. 5 files keeps the attached-files block in the
 * system prompt concise (model tool-calling degrades past ~10 paths
 * at once) and the hydration cost bounded (5 × 15 MB ≈ 75 MB worst
 * case per turn).
 */
export const MAX_FILES_PER_MESSAGE = 5;

/**
 * Per-conversation aggregate cap. Mirrors Claude.ai's documented
 * 20-files-per-chat limit (support.claude.com/en/articles/8241126).
 * Counted across rows `status != 'error'` for the conversation.
 */
export const MAX_FILES_PER_CONVERSATION = 20;

/** HTTP-surface error codes used by the upload/handler validation path. */
export const CHAT_FILE_ERROR_CODES = {
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  TOO_MANY_FILES: "TOO_MANY_FILES",
  CONVERSATION_FILE_LIMIT_REACHED: "CONVERSATION_FILE_LIMIT_REACHED",
} as const;

export type ChatFileErrorCode =
  (typeof CHAT_FILE_ERROR_CODES)[keyof typeof CHAT_FILE_ERROR_CODES];
