import { EXTRACTED_IMAGE_ID_RE } from "./storage";

/**
 * Pure helpers for the virtual extracted-figure paths the agent sees.
 *
 * The cached sidecar keeps Mistral's canonical refs (`![…](img-0.jpeg)`)
 * — it is content-addressed and shared across surfaces, so it must stay
 * filename-agnostic. The `read` tool rewrites refs AT READ TIME to a
 * virtual path under the attachment (`attachments/{filename}/img-0.jpeg`)
 * so the agent can hand one figure to `vision`; `vision` parses that
 * path back with `parseExtractedImagePath` and resolves the bytes from
 * the extraction cache (Bun-side, no sandbox).
 */

const IMAGE_REF_RE = /!\[([^\]]*)\]\(\s*(img-[^)\s]+)\s*\)/g;

/**
 * Rewrite `![alt](img-N.ext)` refs to `![alt]({virtualDir}/img-N.ext)`,
 * ONLY for ids present in the stored manifest — unknown or legacy refs
 * are left untouched (they resolve to nothing and must not pretend
 * otherwise).
 */
export const rewriteExtractedImageRefs = (args: {
  markdown: string;
  virtualDir: string;
  imageIds: string[];
}): string => {
  if (args.imageIds.length === 0) return args.markdown;
  const stored = new Set(args.imageIds);
  return args.markdown.replace(IMAGE_REF_RE, (full, alt: string, id: string) =>
    stored.has(id) ? `![${alt}](${args.virtualDir}/${id})` : full,
  );
};

export interface ExtractedImagePath {
  attachmentFilename: string;
  imageId: string;
}

/**
 * Parse a virtual extracted-figure path — strictly
 * `attachments/<filename>/<imageId>` with a Mistral-shaped image id.
 * Returns `null` for anything else (real files, nested dirs, bad ids).
 */
export const parseExtractedImagePath = (
  relativePath: string,
): ExtractedImagePath | null => {
  const segments = relativePath.split("/");
  if (segments.length !== 3 || segments[0] !== "attachments") return null;
  const [, attachmentFilename, imageId] = segments;
  if (!attachmentFilename || !imageId) return null;
  if (!EXTRACTED_IMAGE_ID_RE.test(imageId)) return null;
  return { attachmentFilename, imageId };
};
