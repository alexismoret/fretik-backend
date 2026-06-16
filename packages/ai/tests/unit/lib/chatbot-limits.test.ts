import {
  CHAT_FILE_ERROR_CODES,
  MAX_FILES_PER_CONVERSATION,
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_SIZE_BYTES,
} from "@fretik/shared/utils/chatbot-limits";
import {
  CHATBOT_ACCEPTED_MIMES,
  isChatbotSupported,
  requiresOcrPreprocessing,
} from "@fretik/shared/utils/mimeTypes";
import { describe, expect, test } from "bun:test";

/**
 * Phase 11 limits contract. The same constants are mirrored on the
 * frontend (`app/app/utils/chatbot-limits.ts` +
 * `app/app/utils/mimeTypes.ts`). If any value drifts, this test is
 * the first alarm.
 */

describe("chatbot-limits — numeric caps", () => {
  test("MAX_FILE_SIZE_BYTES is 30 MB", () => {
    expect(MAX_FILE_SIZE_BYTES).toBe(30 * 1024 * 1024);
  });

  test("MAX_FILES_PER_MESSAGE is 10", () => {
    expect(MAX_FILES_PER_MESSAGE).toBe(10);
  });

  test("MAX_FILES_PER_CONVERSATION is 30", () => {
    expect(MAX_FILES_PER_CONVERSATION).toBe(30);
  });

  test("CHAT_FILE_ERROR_CODES covers every HTTP-surface guard", () => {
    expect(CHAT_FILE_ERROR_CODES.FILE_TOO_LARGE).toBe("FILE_TOO_LARGE");
    expect(CHAT_FILE_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect(CHAT_FILE_ERROR_CODES.TOO_MANY_FILES).toBe("TOO_MANY_FILES");
    expect(CHAT_FILE_ERROR_CODES.CONVERSATION_FILE_LIMIT_REACHED).toBe(
      "CONVERSATION_FILE_LIMIT_REACHED",
    );
  });
});

describe("mimeTypes — chatbot whitelist", () => {
  test("accepts PDF / DOCX / XLSX / PPTX / CSV / images / video / text formats", () => {
    const expected = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/csv",
      "image/png",
      "image/jpeg",
      "image/webp",
      // Video (C5) — analysed by the vision tool, or sent native by a
      // multimodal profile.
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "text/plain",
      "text/markdown",
      "application/json",
    ];
    for (const mime of expected) {
      expect(CHATBOT_ACCEPTED_MIMES).toContain(mime);
    }
  });

  test("rejects executables / archives / unknown / non-allowlisted video types", () => {
    expect(isChatbotSupported("application/x-msdownload")).toBe(false);
    expect(isChatbotSupported("application/zip")).toBe(false);
    expect(isChatbotSupported("application/octet-stream")).toBe(false);
    // Video acceptance is a specific allowlist, not "any video/*".
    expect(isChatbotSupported("video/x-msvideo")).toBe(false);
  });

  test("strips parameters from the MIME string (e.g. ;charset=utf-8)", () => {
    expect(isChatbotSupported("text/csv;charset=utf-8")).toBe(true);
    expect(isChatbotSupported("application/json ; charset=utf-8")).toBe(true);
  });

  test("requiresOcrPreprocessing flags PDF / DOCX / PPTX / images", () => {
    expect(requiresOcrPreprocessing("application/pdf")).toBe(true);
    expect(
      requiresOcrPreprocessing(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true);
    expect(
      requiresOcrPreprocessing(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe(true);
    expect(requiresOcrPreprocessing("image/png")).toBe(true);
    expect(requiresOcrPreprocessing("image/jpeg")).toBe(true);
  });

  test("requiresOcrPreprocessing returns false for text / spreadsheets", () => {
    expect(requiresOcrPreprocessing("text/plain")).toBe(false);
    expect(requiresOcrPreprocessing("text/csv")).toBe(false);
    expect(requiresOcrPreprocessing("application/json")).toBe(false);
    expect(
      requiresOcrPreprocessing(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(false);
  });
});
