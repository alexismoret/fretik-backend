/**
 * Pure helpers for the virtual extracted-figure paths the agent sees.
 * No I/O, no env — safe to import anywhere (S3-backed ops live in
 * `./storage`, which imports the regex from here).
 *
 * The cached sidecar keeps Mistral's canonical refs (`![…](img-0.jpeg)`)
 * — it is content-addressed and shared across surfaces, so it must stay
 * filename-agnostic. The `read` tool rewrites refs AT READ TIME to a
 * virtual path under the document itself (`{dir}/{filename}/img-0.jpeg`,
 * e.g. `attachments/report.pdf/img-0.jpeg` or
 * `downloads/9f2c_contract.pdf/img-0.jpeg`) so the agent can hand one
 * figure to `vision`; `vision` parses that path back with
 * `parseExtractedImagePath` and resolves the bytes from the extraction
 * cache (Bun-side, no sandbox).
 */

/**
 * Shape of a Mistral-emitted embedded-image id (`img-3.jpeg`). Guards
 * both S3 key construction (`./storage`) and the virtual-path resolver
 * in `read` / `vision` — anything else is skipped, never stored, never
 * resolved.
 */
export const EXTRACTED_IMAGE_ID_RE = /^img-\d+\.(jpe?g|png|webp|gif)$/i;

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
  /** The workspace directory the document sits in (`attachments`, `downloads`, …). */
  dir: string;
  filename: string;
  imageId: string;
}

/**
 * Parse a virtual extracted-figure path — `<dir>/<filename>/<imageId>`
 * with a Mistral-shaped image id. Returns `null` for anything else (real
 * files, nested dirs, bad ids).
 *
 * `<dir>` is any workspace directory, not just `attachments`: a document
 * is extractable because of its BYTES, so a PDF the agent downloaded
 * yields the same figures as the same PDF a user attached, and a ref the
 * model is shown must be a ref it can follow.
 */
export const parseExtractedImagePath = (
  relativePath: string,
): ExtractedImagePath | null => {
  const segments = relativePath.split("/");
  if (segments.length !== 3) return null;
  const [dir, filename, imageId] = segments;
  if (!dir || !filename || !imageId) return null;
  if (!EXTRACTED_IMAGE_ID_RE.test(imageId)) return null;
  return { dir, filename, imageId };
};
