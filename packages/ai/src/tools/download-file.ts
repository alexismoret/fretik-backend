import {
  canonicalExtensionFor,
  extensionOf,
  typeForExtension,
} from "@fretik/shared/file-types";
import { resolveFileType } from "@fretik/shared/file-types/detect";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  listFiles,
  WORKSPACE_DIRS,
  writeFile,
} from "../lib/conversation-storage";
import { safeFetchWithGuards } from "../lib/download-file";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { traceExternalCall } from "../lib/trace-tool";

/**
 * Bring a file behind a public URL into the workspace.
 *
 * The sandbox cannot do this itself, by design: its outbound network is an
 * allowlist covering package registries and the team's connected apps, so a
 * general-purpose fetch from inside the VM would mean handing agent-authored
 * code an open internet connection — which is also an open exfiltration
 * channel. Fetching SERVER-side keeps the capability and drops the channel,
 * and it reuses the SSRF guard the web tools already run: scheme, length,
 * private ranges and the operator's domain policy, re-checked by NAME and by
 * RESOLVED ADDRESS on every redirect hop.
 */

/** Files one call may fetch. The byte quota is the real ceiling. */
const MAX_URLS = 10;

interface DownloadedFile {
  path: string;
  filename: string;
  bytes: number;
  mime: string;
  finalUrl: string;
}

interface FailedDownload {
  url: string;
  error: string;
  code: string;
}

/**
 * `Content-Disposition` is the only place an origin states the name it means,
 * and a URL path often carries none (`/download?id=8213`). RFC 5987's
 * `filename*=UTF-8''…` wins over the plain form when both are present, because
 * the plain one is the ASCII fallback.
 */
const filenameFromDisposition = (header: string | null): string | undefined => {
  if (header === null) return undefined;
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // A malformed percent-escape is not worth failing a download over.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim();
};

const filenameFromUrl = (url: string): string | undefined => {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    if (last === undefined) return undefined;
    return decodeURIComponent(last);
  } catch {
    return undefined;
  }
};

/**
 * Same rule as `download-drive-document`, plus one: a run of dots collapses to
 * a single one. Separators are already gone, so `..` cannot traverse anywhere,
 * but a name like `.._.._etc_passwd` is one an operator reading the workspace
 * has to stop and think about, and the extension logic below treats every dot
 * as a boundary.
 */
const sanitizeFilename = (value: string): string =>
  value
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, 180);

/**
 * Name the file after what it IS, not after what the URL called it. A PDF
 * served from `/download?id=8213` reaches the workspace as `download.pdf`, so
 * `read` and `python` both see something they can open.
 */
const deriveFilename = (input: {
  requested: string | undefined;
  disposition: string | null;
  url: string;
  mime: string;
}): string => {
  const raw =
    input.requested ??
    filenameFromDisposition(input.disposition) ??
    filenameFromUrl(input.url) ??
    "download";
  const safe = sanitizeFilename(raw) || "download";
  // `extensionOf` and `canonicalExtensionFor` both carry the dot (`".pdf"`).
  const ext = extensionOf(safe);
  if (ext !== "" && typeForExtension(ext)?.mime === input.mime) return safe;
  const canonical = canonicalExtensionFor(input.mime);
  if (canonical === undefined) return safe;
  return safe.endsWith(canonical) ? safe : `${safe}${canonical}`;
};

/** `report.pdf` → `report-2.pdf`, so a second download never overwrites. */
const deduplicate = (filename: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(filename)) return filename;
  const ext = extensionOf(filename);
  const stem = ext === "" ? filename : filename.slice(0, -ext.length);
  for (let n = 2; n < 1_000; n += 1) {
    const candidate = `${stem}-${n.toString()}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now().toString()}${ext}`;
};

export const createDownloadFileTool = () =>
  tool({
    description: `Fetch files from public URLs into the workspace's \`downloads/\` directory, then read or process them with \`read\` / \`python\`.

Use it for the bytes behind a link: a PDF, spreadsheet, image, archive or dataset. For the TEXT of a web page, use \`webFetch\` instead — it renders the page and returns prose.

The sandbox itself cannot reach arbitrary hosts, so \`curl\`/\`wget\`/\`requests\` inside \`python\` or \`bash\` will fail on a killed TLS handshake. This tool fetches server-side, which is the supported way in.

Up to ${MAX_URLS.toString()} URLs per call. Each file is capped, and a file over the cap is refused rather than truncated. Returns one entry per URL under \`files\` (with its workspace \`path\`) and one under \`failed\` for each that did not arrive — a partial result is normal, so act on what came back and report the rest.`,
    inputSchema: z.object({
      urls: z
        .array(z.url())
        .min(1)
        .max(MAX_URLS)
        .describe("Public http(s) URLs pointing directly at the files."),
      filename: z
        .string()
        .max(180)
        .optional()
        .describe(
          "Name to save under, extension optional. Honoured only when a single URL is given; otherwise each file is named from the server or the URL.",
        ),
    }),
    execute: async ({ urls, filename }, options) => {
      const ctx = getRuntimeContext(options);
      const conversationId = ctx.conversationId;
      if (conversationId === undefined) {
        return {
          error:
            "Downloading a file needs a conversation workspace to write into.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }

      // One listing for the whole call: names are deduplicated against what is
      // already there AND against the files this call has written so far.
      const taken = new Set<string>(
        (await listFiles(conversationId, WORKSPACE_DIRS.downloads)).map(
          (f) => f.path.split("/").at(-1) ?? f.path,
        ),
      );

      const files: DownloadedFile[] = [];
      const failed: FailedDownload[] = [];
      let spent = 0;

      for (const url of urls) {
        const outcome = await traceExternalCall(
          "web-download",
          { url },
          async () => safeFetchWithGuards(url, spent),
          (r) => ({
            output:
              "error" in r
                ? { failed: true, code: r.code }
                : { bytes: r.body.byteLength, contentType: r.contentType },
          }),
        );
        if ("error" in outcome) {
          failed.push({ url, error: outcome.error, code: outcome.code });
          continue;
        }

        const resolved = await resolveFileType({
          bytes: outcome.body,
          declaredMime: outcome.contentType ?? undefined,
          filename: filenameFromDisposition(outcome.contentDisposition),
        });
        const name = deduplicate(
          deriveFilename({
            requested: urls.length === 1 ? filename : undefined,
            disposition: outcome.contentDisposition,
            url: outcome.finalUrl,
            mime: resolved.mimeType,
          }),
          taken,
        );
        taken.add(name);

        const path = `${WORKSPACE_DIRS.downloads}/${name}`;
        try {
          await writeFile(conversationId, path, outcome.body, {
            contentType: resolved.mimeType,
            // Awaited: the next turn's `read` presigns the S3 object, and the
            // fire-and-forget mirror would not have landed yet.
            awaitBackup: true,
          });
        } catch (err) {
          failed.push({
            url,
            error: `Could not write to the workspace: ${err instanceof Error ? err.message : String(err)}`,
            code: TOOL_ERROR_CODES.SANDBOX_WRITE_FAILED,
          });
          continue;
        }

        spent += outcome.body.byteLength;
        files.push({
          path,
          filename: name,
          bytes: outcome.body.byteLength,
          mime: resolved.mimeType,
          finalUrl: outcome.finalUrl,
        });
      }

      if (files.length === 0) {
        const first = failed[0];
        return {
          error:
            failed.length === 1 && first !== undefined
              ? first.error
              : `None of the ${urls.length.toString()} URLs could be downloaded.`,
          code: first?.code ?? TOOL_ERROR_CODES.DOWNLOAD_FAILED,
          failed,
        };
      }

      return { files, ...(failed.length > 0 ? { failed } : {}) };
    },
  });
