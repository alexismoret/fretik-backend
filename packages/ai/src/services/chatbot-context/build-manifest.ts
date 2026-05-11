import { sanitizeSessionSegment } from "@fretik/shared/lib/chatbot-session-storage";
import {
  loadAccessibleContext,
  type AccessibleContextFile,
  type LoadContextArgs,
} from "./load-context";

/**
 * Build the `{{chatbotContextManifest}}` system-prompt fragment.
 *
 * Replaces the previous "stuff every byte of OCR'd content into the
 * prompt" approach with a compact manifest aligned with Anthropic's
 * Project Knowledge / Agent Skills patterns: file metadata stays in
 * the prompt at all times, the body is fetched on demand via the
 * standard `read` tool (the conversation-turn hydrator pushes every
 * accessible context file into the sandbox at `/workspace/context/`,
 * so the manifest just needs to expose a `path` per file).
 *
 * Per file, the manifest emits: filename, sandbox path, scope,
 * mime/size, an outline of up to 8 H1-H3 headings extracted from the
 * markdown, a 200-char single-line preview, and a hint that names
 * the right tool to follow up with. Small files
 * (`charCount < INLINE_THRESHOLD_CHARS`) are inlined in full so
 * trivial snippets / glossaries don't pay an extra round-trip.
 *
 * Only files with `status = 'ready'`, `enabled = true`, and non-empty
 * `content` are listed — transient states stay observable in the
 * settings UI but never reach the model.
 */

const INLINE_THRESHOLD_CHARS = 2_000;
const PREVIEW_CHARS = 200;
const MAX_OUTLINE_HEADINGS = 8;

export interface ChatbotContextManifestResult {
  manifest: string;
  totalChars: number;
  fileCount: number;
  inlinedFileCount: number;
}

const formatBytes = (size: number): string => {
  if (size < 1024) return `${size.toString()} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

const HEADING_RE = /^(#{1,3})\s+(.+)$/gm;

const extractHeadings = (content: string): string[] => {
  const headings: string[] = [];
  HEADING_RE.lastIndex = 0;
  let match: RegExpExecArray | null = HEADING_RE.exec(content);
  while (match !== null) {
    if (headings.length >= MAX_OUTLINE_HEADINGS) break;
    const text = match[2]?.trim();
    if (text !== undefined && text.length > 0) headings.push(text);
    match = HEADING_RE.exec(content);
  }
  return headings;
};

const buildPreview = (content: string): string => {
  const single = content.replace(/\s+/g, " ").trim();
  if (single.length <= PREVIEW_CHARS) return single;
  return `${single.slice(0, PREVIEW_CHARS)}…`;
};

const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
]);

const OCR_DOC_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-powerpoint",
]);

/**
 * Pick the most useful one-liner that tells the model which tool to
 * reach for. The hint always names the sandbox `path` so the model
 * can copy-paste it verbatim.
 */
const sidecarPathFor = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? `${path}.md` : `${path.slice(0, dot)}.md`;
};

const hintFor = (file: AccessibleContextFile, path: string): string => {
  if (OCR_DOC_MIMES.has(file.mimeType)) {
    const sidecarPath = sidecarPathFor(path);
    return `_Use \`read("${path}")\` — auto-resolves to the OCR markdown sidecar. For Python access, open the sidecar directly: \`open("${sidecarPath}").read()\` (the original PDF/DOCX/PPTX is not synced to the sandbox)._`;
  }
  if (SPREADSHEET_MIMES.has(file.mimeType)) {
    return `_Use \`read("${path}")\` for the markdown-tables sidecar (one table per sheet), or \`python\` with \`pandas.read_excel("${path}")\` / \`pd.read_csv("${path}")\` for cell-level access. The sandbox sees this file at \`${path}\` (read-only)._`;
  }
  if (file.mimeType.startsWith("image/")) {
    if (file.hasMarkdown) {
      return `_Use \`read("${path}")\` for the OCR text, or \`vision("${path}", "<question>")\` for explicitly visual questions._`;
    }
    return `_Use \`vision("${path}", "<question>")\` — no OCR text was extractable from this image._`;
  }
  return `_Use \`read("${path}")\`, or open it directly from \`python\` (synced to the sandbox at \`${path}\`)._`;
};

const renderFileEntry = (
  file: AccessibleContextFile,
): { block: string; inlined: boolean } => {
  const content = file.content ?? "";
  const charCount = file.charCount ?? content.length;
  const sandboxPath = `context/${sanitizeSessionSegment(file.filename)}`;

  const lines: string[] = [];
  lines.push(`### ${file.filename}`);
  lines.push(`- path: \`${sandboxPath}\``);
  lines.push(`- scope: ${file.scope}`);
  lines.push(`- type: ${file.mimeType}`);

  const sizeParts = [`${charCount.toString()} chars`];
  if (file.pageCount !== null) {
    sizeParts.push(
      `${file.pageCount.toString()} ${file.pageCount === 1 ? "page" : "pages"}`,
    );
  }
  sizeParts.push(formatBytes(file.size));
  lines.push(`- size: ${sizeParts.join(", ")}`);

  if (charCount > 0 && charCount < INLINE_THRESHOLD_CHARS) {
    // Small file: inline the full content. The four-backtick fence
    // survives any triple-backtick block embedded inside the file.
    lines.push("");
    lines.push("````");
    lines.push(content);
    lines.push("````");
    return { block: lines.join("\n"), inlined: true };
  }

  const headings = extractHeadings(content);
  if (headings.length > 0) {
    lines.push(`- outline: ${headings.join(" / ")}`);
  }
  const preview = buildPreview(content);
  if (preview.length > 0) {
    lines.push(`- preview: ${preview}`);
  }
  lines.push("");
  lines.push(hintFor(file, sandboxPath));
  return { block: lines.join("\n"), inlined: false };
};

export const buildChatbotContextManifest = async (
  args: LoadContextArgs,
): Promise<ChatbotContextManifestResult> => {
  const ctx = await loadAccessibleContext(args);

  const sections: string[] = [];

  if (ctx.teamProfile && !ctx.teamProfile.instructionsMuted) {
    const instr = ctx.teamProfile.instructions.trim();
    if (instr.length > 0) {
      sections.push(`## Team instructions\n${instr}`);
    }
  }
  if (ctx.userProfile) {
    const instr = ctx.userProfile.instructions.trim();
    if (instr.length > 0) {
      sections.push(`## My instructions\n${instr}`);
    }
  }

  // Only ready + enabled + non-empty files reach the model. Transient
  // states (uploading, extracting, error) are observable in the
  // settings UI but exposing them here would only add noise.
  const usableFiles = ctx.files.filter(
    (f) =>
      f.enabled &&
      f.status === "ready" &&
      typeof f.content === "string" &&
      f.content.length > 0,
  );

  let inlinedFileCount = 0;
  if (usableFiles.length > 0) {
    const lines: string[] = ["## Available context files"];
    usableFiles.forEach((file, i) => {
      const entry = renderFileEntry(file);
      if (entry.inlined) inlinedFileCount += 1;
      lines.push("");
      lines.push(entry.block);
      if (i < usableFiles.length - 1) {
        lines.push("");
        lines.push("---");
      }
    });
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) {
    return {
      manifest: "",
      totalChars: 0,
      fileCount: 0,
      inlinedFileCount: 0,
    };
  }

  const manifest = sections.join("\n\n").trimEnd();
  return {
    manifest,
    totalChars: manifest.length,
    fileCount: usableFiles.length,
    inlinedFileCount,
  };
};
