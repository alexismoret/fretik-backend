// ============================================================================ //
// FILE-TYPE REGISTRY — TYPES                                                   //
// ----------------------------------------------------------------------------//
// Isomorphic module: imported by every backend package AND by the Nuxt app     //
// (via the `#file-types` alias). Nothing in this directory may import outside  //
// of it, and `detect.ts` (the only file with a dependency) is deliberately     //
// NOT re-exported from `index.ts` so the shared surface stays dependency-free. //
// ============================================================================ //

/** Broad family a type belongs to — drives grouping, defaults and copy. */
export type FileFamily =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "image"
  | "text"
  | "markdown"
  | "code"
  | "data"
  | "email"
  | "html"
  | "video";

/** How the extraction pipeline turns the file into readable text. */
export type ExtractionStrategy =
  | "mistral-ocr" // sent natively to Mistral OCR (pdf, docx, pptx, doc, ppt)
  | "convert-ocr" // Gotenberg LibreOffice → PDF → Mistral OCR (odt, ods, odp, rtf)
  | "image-ocr" // Mistral OCR on the raster image
  | "spreadsheet" // exceljs → markdown tables
  | "text" // UTF-8 decode, verbatim
  | "email" // headers + body + attachment list → markdown
  | "html" // HTML → markdown
  | "none";

/** How the Drive builds the document thumbnail. */
export type ThumbnailStrategy =
  | "native-image" // resize the image itself
  | "pdf-first-page" // Poppler on the original PDF
  | "libreoffice" // Gotenberg LibreOffice first page → PDF → Poppler
  | "chromium-screenshot" // Gotenberg Chromium screenshot route (html, markdown)
  | "none";

/** Which frontend viewer renders the file. */
export type ViewerStrategy =
  | "pdf"
  | "docx"
  | "xlsx"
  | "pptx"
  | "csv"
  | "markdown"
  | "code" // syntax-highlighted code block
  | "text"
  | "image"
  | "html-iframe" // sandboxed srcdoc iframe, scripts disabled
  | "none";

/** How the agent's `read` tool reaches the content. */
export type AgentAccess =
  | "raw-text" // bytes decoded as UTF-8 (html / code / config / svg included)
  | "ocr-sidecar" // `{basename}.md` sidecar produced by OCR extraction
  | "email-sidecar" // `{basename}.md` sidecar (headers/body/attachment list)
  | "image" // vision tool (plus sidecar when OCR found text)
  | "tabular" // python/pandas
  | "opaque"; // no text access (video → vision)

/** Upload surfaces a type can be accepted by. */
export type FileSurface =
  "drive" | "chatbot" | "context" | "workflow-form" | "avatar";

/**
 * Presentation color as an abstract token. The frontend maps tokens to
 * literal Tailwind classes (`fileTypePresentation.ts`) — classes cannot
 * live here because this file sits outside Tailwind's content scan.
 */
export type FileColorToken =
  | "red"
  | "blue"
  | "green"
  | "orange"
  | "purple"
  | "pink"
  | "teal"
  | "amber"
  | "cyan"
  | "neutral";

/** When the extraction pipeline persists a markdown sidecar next to the original. */
export type SidecarPolicy = "always" | "when-ocr-text" | "never";

export interface FileTypeDef {
  /** Stable identifier (`"pdf"`, `"docx"`, `"eml"`, …). */
  readonly id: string;
  /** Canonical MIME persisted in the DB for this type. */
  readonly mime: string;
  /** Other MIMEs normalised into `mime` at detection time. */
  readonly aliasMimes: readonly string[];
  /** Extensions (with leading dot); first entry is the canonical one. */
  readonly extensions: readonly string[];
  readonly family: FileFamily;
  /**
   * The raw bytes ARE UTF-8 text (source, markup, mail, CSV) rather than
   * a binary container. Load-bearing for detection: textual formats carry
   * no magic bytes, so `detect.ts` resolves them from the extension after
   * a UTF-8 sniff. Not derivable from `family` — `svg` is textual but
   * belongs to `image`, `msg` is binary but belongs to `email`.
   */
  readonly textual: boolean;
  /** Phosphor icon name (`i-ph-*`). */
  readonly icon: string;
  readonly color: FileColorToken;
  readonly extraction: ExtractionStrategy;
  readonly thumbnail: ThumbnailStrategy;
  readonly viewer: ViewerStrategy;
  readonly agentAccess: AgentAccess;
  readonly surfaces: readonly FileSurface[];
  readonly sidecar: SidecarPolicy;
  /**
   * Set when this def shares its MIME with another one and does NOT own
   * it: `typeForMime` skips it, so it is reachable only through
   * extension refinement in `resolveTypeForFile`. `text/plain` is owned
   * by `txt`; a `.py` file is stored as `text/plain` and resolves to
   * `code` through its extension. Storing a real IANA MIME and refining
   * on the extension keeps the persisted type honest — we never invent
   * `text/x-python`.
   */
  readonly extensionOnly?: boolean;
}
