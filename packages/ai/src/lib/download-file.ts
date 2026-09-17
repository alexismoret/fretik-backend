import { TOOL_ERROR_CODES } from "./tool-error-codes";
import { assertFetchableTarget, WebEgressError } from "./web-egress";
import { downloadLimits, downloadUserAgent, timeouts } from "./web/config";
import { safeFetch, WebHttpError, type SafeFetchResult } from "./web/http";

/**
 * One guarded download, as a value.
 *
 * Split from the tool so the byte accounting and the failure mapping can be
 * tested without a workspace: what a download does on refusal is most of its
 * behaviour, and all of it is invisible from the happy path.
 */

export type DownloadOutcome =
  (SafeFetchResult & { ok: true }) | { error: string; code: string };

/**
 * Fetch a URL with the full guard rail, refusing rather than truncating when
 * it runs past a ceiling.
 *
 * `spentBytes` is what this CALL has already written. The per-call ceiling
 * exists because `/workspace` is a 256 MiB tmpfs shared with everything else
 * the turn is doing — ten files at the per-file ceiling would fill it, and a
 * full workspace fails the next write rather than this one.
 */
export const safeFetchWithGuards = async (
  url: string,
  spentBytes: number,
): Promise<DownloadOutcome> => {
  const limits = downloadLimits();
  const remaining = limits.perCall - spentBytes;
  if (remaining <= 0) {
    return {
      error: `This call has already downloaded its ${limits.perCall.toString()} byte budget. Download the rest in a separate call.`,
      code: TOOL_ERROR_CODES.DOWNLOAD_TOO_LARGE,
    };
  }

  try {
    assertFetchableTarget(url);
    const result = await safeFetch(url, {
      timeoutMs: timeouts().download,
      maxBytes: Math.min(limits.perFile, remaining),
      // A file, not a document: take whatever the origin serves rather than
      // the text/XML set the page readers ask for.
      accept: "*/*",
      userAgent: downloadUserAgent(),
      // A truncated PDF is not a small PDF, it is a corrupt one — and handing
      // the agent a broken artifact to debug is worse than a clear refusal.
      overflow: "reject",
    });

    if (result.body.byteLength === 0) {
      return {
        error: "The server returned an empty file.",
        code: TOOL_ERROR_CODES.DOWNLOAD_FAILED,
      };
    }
    return { ...result, ok: true };
  } catch (err) {
    if (err instanceof WebEgressError) {
      return { error: err.detail.message, code: err.detail.code };
    }
    if (err instanceof WebHttpError) {
      if (err.status === 413) {
        return {
          error: `${err.message}. Ask for a smaller export, or a specific part of the file.`,
          code: TOOL_ERROR_CODES.DOWNLOAD_TOO_LARGE,
        };
      }
      return { error: err.message, code: TOOL_ERROR_CODES.DOWNLOAD_FAILED };
    }
    if (err instanceof Error && err.name === "AbortError") {
      return {
        error: `The download did not finish within ${timeouts().download.toString()} ms.`,
        code: TOOL_ERROR_CODES.WEB_TIMEOUT,
      };
    }
    return {
      error: err instanceof Error ? err.message : String(err),
      code: TOOL_ERROR_CODES.DOWNLOAD_FAILED,
    };
  }
};
