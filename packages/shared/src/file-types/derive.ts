import { CODE_BASENAMES, CODE_LANGUAGES, FILE_TYPES } from "./registry";
import type {
  AgentAccess,
  ExtractionStrategy,
  FileColorToken,
  FileSurface,
  FileTypeDef,
  ThumbnailStrategy,
  ViewerStrategy,
} from "./types";

// ============================================================================ //
// FILE-TYPE REGISTRY — DERIVED LOOKUPS                                         //
// ----------------------------------------------------------------------------//
// Everything here is COMPUTED from `FILE_TYPES` at module load. No list is     //
// written twice: allowlists, accept attributes, extension→MIME tables and the  //
// category predicates all fall out of the registry.                            //
// ============================================================================ //

/** Strip MIME parameters and case: `Text/CSV;charset=utf-8` → `text/csv`. */
export const baseMime = (mimeType: string): string =>
  mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

/**
 * Lowercased extension including the dot (`".pdf"`), or `""` when the
 * filename carries none. Replaces the ad-hoc `split(".").pop()` /
 * `extname()` parsing that used to live in a dozen call sites.
 */
export const extensionOf = (filename: string): string => {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

const byId = new Map<string, FileTypeDef>();
const byMime = new Map<string, FileTypeDef>();
const byExtension = new Map<string, FileTypeDef>();

for (const def of FILE_TYPES) {
  byId.set(def.id, def);
  // `extensionOnly` defs share a MIME with their owner (`text/plain`) and
  // must never win the MIME lookup.
  if (!def.extensionOnly) {
    for (const mime of [def.mime, ...def.aliasMimes]) {
      if (!byMime.has(mime)) byMime.set(mime, def);
    }
  }
  for (const ext of def.extensions) {
    if (!byExtension.has(ext)) byExtension.set(ext, def);
  }
}

export const typeForId = (id: string): FileTypeDef | undefined => byId.get(id);

export const typeForMime = (mimeType: string): FileTypeDef | undefined =>
  byMime.get(baseMime(mimeType));

export const typeForExtension = (ext: string): FileTypeDef | undefined =>
  byExtension.get(ext.toLowerCase());

/** Extension lookup, falling back to well-known extensionless filenames. */
export const typeForFilename = (filename: string): FileTypeDef | undefined => {
  const ext = extensionOf(filename);
  if (ext) return typeForExtension(ext);
  const base = filename.slice(filename.lastIndexOf("/") + 1).toLowerCase();
  return base in CODE_BASENAMES ? byId.get("code") : undefined;
};

/**
 * The canonical resolution used by every surface.
 *
 * A binary MIME is authoritative — it comes from magic bytes, so a wrong
 * extension can never override it. `text/plain` is the one MIME that
 * under-describes its file (source code, INI configs and prose all share
 * it), so there the extension decides, but only when it names another
 * TEXTUAL type: a text file misnamed `report.pdf` stays text.
 */
export const resolveTypeForFile = (input: {
  mime?: string;
  filename?: string;
}): FileTypeDef | undefined => {
  const fromMime = input.mime ? typeForMime(input.mime) : undefined;
  if (fromMime && fromMime.mime !== "text/plain") return fromMime;
  const fromName = input.filename ? typeForFilename(input.filename) : undefined;
  if (fromName?.textual) return fromName;
  return fromMime ?? fromName;
};

/** Shiki language id for a filename, or `undefined` to render as plain text. */
export const codeLanguageFor = (filename: string): string | undefined => {
  const ext = extensionOf(filename);
  if (ext) return CODE_LANGUAGES[ext];
  const base = filename.slice(filename.lastIndexOf("/") + 1).toLowerCase();
  return CODE_BASENAMES[base];
};

// ==================== //
// MIME ↔ EXTENSION     //
// ==================== //

const buildExtToMime = (
  predicate: (def: FileTypeDef) => boolean,
): Record<string, string> => {
  const table: Record<string, string> = {};
  for (const def of FILE_TYPES) {
    if (!predicate(def)) continue;
    for (const ext of def.extensions) table[ext] ??= def.mime;
  }
  return table;
};

/**
 * Extension → canonical MIME, for every known type. The single table
 * that used to be copy-pasted into the sandbox artefact typer, the
 * `presentFiles` tool, the vision tool and the frontend.
 */
export const EXT_TO_MIME: Readonly<Record<string, string>> = buildExtToMime(
  () => true,
);

/**
 * Extension → canonical MIME, restricted to TEXTUAL formats. These carry
 * no magic bytes, so detection falls back to this table after the UTF-8
 * sniff — without it a `.md` lands on `text/plain` and loses the one
 * property that makes it editable.
 */
export const TEXT_EXT_TO_MIME: Readonly<Record<string, string>> =
  buildExtToMime((def) => def.textual);

/** Canonical extension for a MIME (`application/pdf` → `.pdf`). */
export const canonicalExtensionFor = (mimeType: string): string | undefined =>
  typeForMime(mimeType)?.extensions[0];

/** The MIME to DECLARE for a textual file that arrives without one. */
export const declaredMimeFromFilename = (
  filename: string,
): string | undefined => TEXT_EXT_TO_MIME[extensionOf(filename)];

/**
 * Best-effort MIME for a file we only know by name — an artefact the
 * agent produced in its sandbox, a link in its markdown. Never a
 * substitute for detection: the real type comes from the bytes at every
 * ingestion boundary.
 */
export const mimeFromFilename = (filename: string): string =>
  EXT_TO_MIME[extensionOf(filename)] ?? "application/octet-stream";

// ==================== //
// CATEGORY PREDICATES  //
// ==================== //

/**
 * Any UTF-8-readable text / code / data file. Falls back to the `text/*`
 * prefix for MIMEs absent from the registry so legacy rows stored with a
 * vendor type (`text/x-python`, …) stay readable.
 */
export const isTextMime = (mimeType: string): boolean => {
  const def = typeForMime(mimeType);
  return def ? def.textual : baseMime(mimeType).startsWith("text/");
};

/** PDF / Office documents Mistral OCR reads natively. */
export const isOcrDocumentMime = (mimeType: string): boolean =>
  typeForMime(mimeType)?.extraction === "mistral-ocr";

export const isImageMime = (mimeType: string): boolean => {
  const def = typeForMime(mimeType);
  return def ? def.family === "image" : baseMime(mimeType).startsWith("image/");
};

/** Videos — no text to extract; handed to the vision tool or sent native. */
export const isVideoMime = (mimeType: string): boolean => {
  const def = typeForMime(mimeType);
  return def ? def.family === "video" : baseMime(mimeType).startsWith("video/");
};

export const isSpreadsheetMime = (mimeType: string): boolean => {
  const def = typeForMime(mimeType);
  if (def) return def.family === "spreadsheet";
  const base = baseMime(mimeType);
  return (
    base.includes("csv") ||
    base.includes("excel") ||
    base.includes("spreadsheet")
  );
};

/**
 * Markdown — the format Fretik AUTHORS. Singled out because it is the one
 * Drive type whose original S3 key collides with its own sidecar key
 * (`documents/{id}.md` both ways).
 */
export const isMarkdownMime = (mimeType: string): boolean =>
  typeForMime(mimeType)?.id === "markdown";

export const isHtmlMime = (mimeType: string): boolean =>
  typeForMime(mimeType)?.family === "html";

export const isEmailMime = (mimeType: string): boolean =>
  typeForMime(mimeType)?.family === "email";

/** True when the file must be OCR'd (or converted then OCR'd) to yield text. */
export const requiresOcrPreprocessing = (mimeType: string): boolean => {
  const extraction = typeForMime(mimeType)?.extraction;
  return (
    extraction === "mistral-ocr" ||
    extraction === "convert-ocr" ||
    extraction === "image-ocr"
  );
};

// ==================== //
// SURFACE ALLOWLISTS   //
// ==================== //

const defsForSurface = (surface: FileSurface): FileTypeDef[] =>
  FILE_TYPES.filter((def) => def.surfaces.includes(surface));

/** Canonical MIMEs a surface accepts. */
export const mimesForSurface = (surface: FileSurface): string[] =>
  defsForSurface(surface).map((def) => def.mime);

/** Every extension a surface accepts, canonical order. */
export const extensionsForSurface = (surface: FileSurface): string[] =>
  defsForSurface(surface).flatMap((def) => [...def.extensions]);

/**
 * Value for an `<input type="file" accept>` attribute. MIMEs alone are
 * not enough: a browser reports an empty `file.type` for most source and
 * config files, so the extensions have to be listed too.
 */
export const acceptAttrFor = (surface: FileSurface): string =>
  [...mimesForSurface(surface), ...extensionsForSurface(surface)].join(",");

/**
 * Is this file accepted by a given surface? Unknown-but-textual files are
 * allowed everywhere except avatars: they are readable by definition, and
 * upload detection normalises them to `text/plain` anyway.
 */
export const isSupportedBySurface = (
  surface: FileSurface,
  mimeType: string,
  filename?: string,
): boolean => {
  const def = resolveTypeForFile({ mime: mimeType, filename });
  if (def) return def.surfaces.includes(surface);
  return surface !== "avatar" && isTextMime(mimeType);
};

export const isDriveSupported = (
  mimeType: string,
  filename?: string,
): boolean => isSupportedBySurface("drive", mimeType, filename);

export const isChatbotSupported = (
  mimeType: string,
  filename?: string,
): boolean => isSupportedBySurface("chatbot", mimeType, filename);

// ==================== //
// STRATEGY ACCESSORS   //
// ==================== //

/**
 * How to turn this file into text. Unknown-but-textual MIMEs keep the
 * lenient `text` route so a file type we have not catalogued yet is still
 * readable rather than rejected.
 */
export const extractionFor = (
  mimeType: string,
  filename?: string,
): ExtractionStrategy => {
  const def = resolveTypeForFile({ mime: mimeType, filename });
  if (def) return def.extraction;
  return isTextMime(mimeType) ? "text" : "none";
};

export const thumbnailFor = (
  mimeType: string,
  filename?: string,
): ThumbnailStrategy =>
  resolveTypeForFile({ mime: mimeType, filename })?.thumbnail ?? "none";

export const viewerFor = (
  mimeType: string,
  filename?: string,
): ViewerStrategy => {
  const def = resolveTypeForFile({ mime: mimeType, filename });
  if (def) return def.viewer;
  return isTextMime(mimeType) ? "text" : "none";
};

export const agentAccessFor = (
  mimeType: string,
  filename?: string,
): AgentAccess => {
  const def = resolveTypeForFile({ mime: mimeType, filename });
  if (def) return def.agentAccess;
  return isTextMime(mimeType) ? "raw-text" : "opaque";
};

export const iconFor = (mimeType: string, filename?: string): string =>
  resolveTypeForFile({ mime: mimeType, filename })?.icon ?? "i-ph-file";

export const colorTokenFor = (
  mimeType: string,
  filename?: string,
): FileColorToken =>
  resolveTypeForFile({ mime: mimeType, filename })?.color ?? "neutral";

/**
 * Whether a markdown sidecar is EXPECTED for this type — asked before
 * extraction has run, when there is no markdown to weigh yet. Images
 * count: they only keep their sidecar if OCR finds text, but one is
 * attempted.
 */
export const expectsSidecar = (mimeType: string, filename?: string): boolean =>
  (resolveTypeForFile({ mime: mimeType, filename })?.sidecar ?? "never") !==
  "never";

/**
 * Whether to persist a `.md` sidecar next to the original. Images only
 * earn one when OCR found enough text to be worth reading — a logo or a
 * selfie keeps the original and the agent reaches for `vision`.
 */
export const shouldWriteSidecar = (
  mimeType: string,
  markdown: string,
  filename?: string,
): boolean => {
  const policy =
    resolveTypeForFile({ mime: mimeType, filename })?.sidecar ?? "never";
  if (policy === "always") return true;
  if (policy === "never") return false;
  return markdown.replace(/\s+/g, "").length >= 20;
};
