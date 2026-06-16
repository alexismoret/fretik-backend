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
 * Per-file size cap. 30 MB (raised from 15 MB, 2026-06) — chosen against
 * the real provider ceilings of the paths a chat file travels:
 * Mistral OCR (`read`) and Gemini vision both accept 50 MB / 1000 pages,
 * and Claude caps the whole request at 32 MB. 30 MB sits at the
 * conservative side — comfortably under the OCR/vision 50 MB, aligned
 * with Claude's 32 MB request ceiling, and keeps native-image base64
 * inlining (~×1.33 payload) sane. Generous enough for B2B scans /
 * multi-page reports without blowing up cost or upload latency.
 */
export const MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;

/**
 * Per-message cap. 10 files (raised from 5, 2026-06) unblocks B2B
 * fan-out ("compare these 8 invoices") while staying far under provider
 * per-request limits (Claude 100 images, Gemini more). Keeps the
 * attached-files block readable and the per-turn hydration cost bounded.
 */
export const MAX_FILES_PER_MESSAGE = 10;

/**
 * Per-conversation aggregate cap. 30 files (raised from 20, 2026-06).
 * Counted across rows `status != 'error'` for the conversation.
 */
export const MAX_FILES_PER_CONVERSATION = 30;

/** HTTP-surface error codes used by the upload/handler validation path. */
export const CHAT_FILE_ERROR_CODES = {
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  TOO_MANY_FILES: "TOO_MANY_FILES",
  CONVERSATION_FILE_LIMIT_REACHED: "CONVERSATION_FILE_LIMIT_REACHED",
} as const;

export type ChatFileErrorCode =
  (typeof CHAT_FILE_ERROR_CODES)[keyof typeof CHAT_FILE_ERROR_CODES];
