import ExcelJS from "exceljs";

/**
 * Structured preview of a user-uploaded chat file. Computed once at
 * upload time and persisted to `ai_chat_files.snapshot`. The chatbot
 * handler injects it into the `<attached_file>` block of the system
 * prompt at every turn so the model can route to the right tool
 * (`read` / `python` / `vision`) without having to discover the file's
 * shape via paginated reads.
 *
 * Design note (verified 2026-05-04 against Claude.ai, ChatGPT, Gemini
 * leaked prompts): none of the big-three exposes a rich structured
 * metadata block. Claude.ai = path + bytes-as-image, ChatGPT = chunked
 * RAG snippets + screenshot tool, Gemini = pixels + native text. This
 * snapshot is a *net-new affordance* sized to our stack's tool surface
 * (`read` / `python` / `vision`) — it surfaces the routing signals the
 * big-three force their models to discover with extra tool calls.
 *
 * 4 kinds, intentional:
 *   - `tabular` — CSV / TSV / XLSX → rows, columns, head
 *   - `document` — PDF / DOCX / PPTX (anything with an OCR sidecar) →
 *      pages, excerpt, headings, image count, table head, etc.
 *   - `text` — markdown / json / xml / plain text → lines + head
 *   - `opaque` — images / audio / binary / parse error → only a hint
 *      string. The renderer maps `mime: image/*` to a vision-tool
 *      hint, etc. — no separate `image` kind because the snapshot's
 *      job is to point the model at the right *next* tool, not to
 *      preview pixel data.
 */
export type ChatFileSnapshot =
  TabularSnapshot | DocumentSnapshot | TextSnapshot | OpaqueSnapshot;

export interface TabularSnapshot {
  kind: "tabular";
  /** Total data rows. Header row excluded. */
  rows: number;
  columns: Array<{ name: string; dtype: string }>;
  /** Up to {@link MAX_TABULAR_HEAD_ROWS} data rows, CSV-rendered. */
  head: string[];
}

/**
 * OCR-sidecar-backed documents (PDF / DOCX / PPTX). Includes routing
 * signals for `read` (excerpt + headings + size), `python` (tables
 * count + first table head), and `vision` (image count). Models pick.
 */
export interface DocumentSnapshot {
  kind: "document";
  /** Page count from Mistral OCR when known; undefined otherwise. */
  pages: number | undefined;
  /**
   * Total size of the OCR sidecar markdown in characters. Surfaces
   * the cost of a default-full `read` so the model can pre-emptively
   * prefer paginated reads (`read(path, offset, limit)`) on huge files.
   */
  sidecarChars: number;
  /** Total lines of the OCR sidecar markdown (`\n`-delimited). */
  sidecarLines: number;
  /**
   * First ~{@link DOCUMENT_EXCERPT_CHARS} characters of prose,
   * markdown-table blocks excluded. Often answers single-fact
   * questions without any tool call.
   */
  excerpt: string;
  /** Number of `![alt](src)` markdown image references in the sidecar. */
  imageCount: number;
  /** Convenience for the renderer / consumers. Equivalent to `imageCount > 0`. */
  hasImages: boolean;
  /** Distinct markdown tables (≥ 3 consecutive `|`-prefixed lines) detected in the sidecar. */
  tablesDetected: number;
  /**
   * First table's first rows verbatim (header + separator + up to
   * {@link MAX_TABULAR_HEAD_ROWS} data lines). Empty when no tables.
   */
  firstTableHead: string[];
  /**
   * Top-level structural headings (h1 / h2) extracted from the
   * markdown sidecar. Up to {@link MAX_HEADINGS}. Helps `read` target
   * a section instead of paginated browsing.
   */
  headings: string[];
}

export interface TextSnapshot {
  kind: "text";
  lines: number;
  /** Up to {@link MAX_TEXT_HEAD_LINES} lines, verbatim. */
  headLines: string[];
}

export interface OpaqueSnapshot {
  kind: "opaque";
  /**
   * Free-form hint, surfaced as-is by the renderer. Conventions:
   *   - "image (use vision tool)"  for image/* mime
   *   - "audio (no in-context preview)" for audio/*
   *   - "<mime> (binary)" for everything else
   *   - "parse error: <message>" on extractor failure
   *   - "pdf without OCR sidecar" when OCR didn't run
   */
  reason: string;
}

const MAX_TABULAR_HEAD_ROWS = 5;
const MAX_TEXT_HEAD_LINES = 30;
const MAX_HEADINGS = 12;
const MAX_CELL_LEN = 200;
const DOCUMENT_EXCERPT_CHARS = 500;
const CSV_PARSE_BYTES = 64 * 1024;
const HEADING_LINE_MAX = MAX_CELL_LEN;

const truncate = (raw: string, max: number): string =>
  raw.length > max ? `${raw.slice(0, max)}…` : raw;

const truncateCell = (raw: string): string => truncate(raw, MAX_CELL_LEN);

const isOnlyDigits = (s: string): boolean => /^-?\d+$/.test(s);
const isOnlyFloat = (s: string): boolean =>
  /^-?\d+([.,]\d+)?(e[-+]?\d+)?$/i.test(s);
const isIsoDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(
    s,
  );
const isCommonDate = (s: string): boolean =>
  /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s);

const inferDtype = (samples: readonly string[]): string => {
  const nonEmpty = samples.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return "string";
  if (nonEmpty.every(isOnlyDigits)) return "int64";
  if (nonEmpty.every((s) => isOnlyDigits(s) || isOnlyFloat(s)))
    return "float64";
  if (nonEmpty.every((s) => isIsoDate(s) || isCommonDate(s))) return "datetime";
  return "string";
};

const detectSeparator = (firstLine: string): string => {
  const counts: Record<string, number> = {
    ",": (firstLine.match(/,/g) ?? []).length,
    ";": (firstLine.match(/;/g) ?? []).length,
    "\t": (firstLine.match(/\t/g) ?? []).length,
  };
  let best = ",";
  let bestCount = counts[","] ?? 0;
  for (const sep of [";", "\t"] as const) {
    const count = counts[sep] ?? 0;
    if (count > bestCount) {
      best = sep;
      bestCount = count;
    }
  }
  return best;
};

/**
 * Minimal CSV row parser that handles double-quoted fields with
 * embedded separators. Sufficient for snapshot purposes — pandas
 * will do real parsing in the sandbox.
 */
const parseCsvRow = (line: string, sep: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === sep) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch ?? "";
  }
  out.push(cur);
  return out;
};

const countNewlines = (bytes: Uint8Array): number => {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) count++;
  }
  return count;
};

const parseCsvSnapshot = (bytes: Uint8Array): ChatFileSnapshot => {
  if (bytes.length === 0) return { kind: "opaque", reason: "empty file" };
  const head = bytes.slice(0, Math.min(bytes.length, CSV_PARSE_BYTES));
  const headText = new TextDecoder("utf-8", { fatal: false }).decode(head);
  const lines = headText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { kind: "opaque", reason: "no lines" };
  const firstLine = lines[0] ?? "";
  const sep = detectSeparator(firstLine);
  const headerRow = parseCsvRow(firstLine, sep).map(truncateCell);
  const dataRows = lines
    .slice(1, 1 + MAX_TABULAR_HEAD_ROWS)
    .map((l) => parseCsvRow(l, sep).map(truncateCell));
  const columns = headerRow.map((name, idx) => ({
    name: name || `col_${idx}`,
    dtype: inferDtype(
      dataRows.map((r) => r[idx] ?? "").filter((s) => s.length > 0),
    ),
  }));
  const totalNewlines = countNewlines(bytes);
  // Header row excluded; clamp to 0 minimum (file with header only).
  const rows = Math.max(0, totalNewlines - 1);
  return {
    kind: "tabular",
    rows,
    columns,
    head: dataRows.map((r) => r.join(",")),
  };
};

const parseXlsxSnapshot = async (
  bytes: Uint8Array,
): Promise<ChatFileSnapshot> => {
  const workbook = new ExcelJS.Workbook();
  // Copy through to a fresh ArrayBuffer to satisfy ExcelJS type
  // (Uint8Array.buffer can be SharedArrayBuffer in some runtimes).
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  await workbook.xlsx.load(buf);
  const ws = workbook.worksheets[0];
  if (!ws) return { kind: "opaque", reason: "no worksheet" };
  const totalDataRows = Math.max(0, ws.rowCount - 1);
  const colCount = ws.columnCount;
  if (colCount === 0) return { kind: "opaque", reason: "empty worksheet" };
  const headerRow = ws.getRow(1);
  const columnNames: string[] = [];
  for (let c = 1; c <= colCount; c++) {
    const v = headerRow.getCell(c).value;
    const name =
      typeof v === "string"
        ? v
        : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : `col_${c}`;
    columnNames.push(truncateCell(name));
  }
  const dataRows: string[][] = [];
  const lastRow = Math.min(ws.rowCount, 1 + MAX_TABULAR_HEAD_ROWS);
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      const v = row.getCell(c).value;
      const text =
        v === null || v === undefined
          ? ""
          : typeof v === "string"
            ? v
            : typeof v === "number" || typeof v === "boolean"
              ? String(v)
              : v instanceof Date
                ? v.toISOString()
                : JSON.stringify(v);
      cells.push(truncateCell(text));
    }
    dataRows.push(cells);
  }
  const columns = columnNames.map((name, idx) => ({
    name: name || `col_${idx}`,
    dtype: inferDtype(
      dataRows.map((r) => r[idx] ?? "").filter((s) => s.length > 0),
    ),
  }));
  return {
    kind: "tabular",
    rows: totalDataRows,
    columns,
    head: dataRows.map((r) => r.join(",")),
  };
};

const HEADING_RE = /^(#{1,2})\s+(.+?)\s*$/;
const IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g;
const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;

const parseDocumentSnapshot = (
  markdown: string,
  pages: number | undefined,
): ChatFileSnapshot => {
  if (markdown.length === 0) {
    return { kind: "opaque", reason: "empty OCR sidecar" };
  }
  const lines = markdown.split(/\r?\n/);

  // 1. Tables — runs of ≥ 3 consecutive `|`-prefixed lines.
  const tableRuns: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (TABLE_LINE_RE.test(line)) {
      current.push(i);
    } else if (current.length > 0) {
      if (current.length >= 3) tableRuns.push(current);
      current = [];
    }
  }
  if (current.length >= 3) tableRuns.push(current);
  const firstTable = tableRuns[0];
  const firstTableHead: string[] = [];
  if (firstTable) {
    const sliceCount = Math.min(firstTable.length, MAX_TABULAR_HEAD_ROWS + 2);
    for (let k = 0; k < sliceCount; k++) {
      const idx = firstTable[k];
      if (idx === undefined) break;
      const raw = lines[idx] ?? "";
      firstTableHead.push(truncate(raw, MAX_CELL_LEN * 4));
    }
  }

  // 2. Headings — `^#{1,2} ` lines.
  const tableLineSet = new Set<number>(tableRuns.flat());
  const headings: string[] = [];
  for (let i = 0; i < lines.length && headings.length < MAX_HEADINGS; i++) {
    if (tableLineSet.has(i)) continue;
    const m = HEADING_RE.exec(lines[i] ?? "");
    if (m) {
      const text = m[2] ?? "";
      headings.push(truncate(text, HEADING_LINE_MAX));
    }
  }

  // 3. Image references — `![alt](src)` count.
  const imageCount = (markdown.match(IMAGE_RE) ?? []).length;

  // 4. Excerpt — first DOCUMENT_EXCERPT_CHARS of prose, table lines
  //    excluded, image refs collapsed, image alt-text preserved.
  const proseLines: string[] = [];
  let proseChars = 0;
  for (let i = 0; i < lines.length; i++) {
    if (tableLineSet.has(i)) continue;
    const line = (lines[i] ?? "").replace(IMAGE_RE, "[image]").trim();
    if (line.length === 0) continue;
    proseLines.push(line);
    proseChars += line.length + 1; // include newline
    if (proseChars >= DOCUMENT_EXCERPT_CHARS) break;
  }
  const excerpt = truncate(proseLines.join("\n"), DOCUMENT_EXCERPT_CHARS);

  return {
    kind: "document",
    pages,
    sidecarChars: markdown.length,
    sidecarLines: lines.length,
    excerpt,
    imageCount,
    hasImages: imageCount > 0,
    tablesDetected: tableRuns.length,
    firstTableHead,
    headings,
  };
};

const parseTextSnapshotFromString = (text: string): ChatFileSnapshot => {
  const lines = text.split(/\r?\n/);
  // Drop a single trailing empty line if the file ended with `\n`.
  const lineCount =
    lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const headLines = lines
    .slice(0, MAX_TEXT_HEAD_LINES)
    .map((l) => truncate(l, MAX_CELL_LEN * 4));
  return { kind: "text", lines: lineCount, headLines };
};

const parseTextSnapshot = (bytes: Uint8Array): ChatFileSnapshot => {
  if (bytes.length === 0) return { kind: "opaque", reason: "empty file" };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return parseTextSnapshotFromString(text);
};

const isCsvMime = (mimeType: string): boolean =>
  mimeType === "text/csv" ||
  mimeType === "application/csv" ||
  mimeType === "text/tab-separated-values";

const isXlsxMime = (mimeType: string): boolean =>
  mimeType.includes("spreadsheet") ||
  mimeType.includes("excel") ||
  mimeType === "application/vnd.ms-excel" ||
  mimeType ===
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const isOcrSidecarMime = (mimeType: string): boolean =>
  mimeType === "application/pdf" ||
  mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
  mimeType ===
    "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
  mimeType === "application/msword" ||
  mimeType === "application/vnd.ms-powerpoint";

const isPlainTextMime = (mimeType: string): boolean =>
  mimeType.startsWith("text/") ||
  mimeType === "application/json" ||
  mimeType === "application/xml" ||
  mimeType === "application/x-yaml";

const opaqueHint = (mimeType: string): string => {
  if (mimeType.startsWith("image/")) return "image (use vision tool)";
  if (mimeType.startsWith("audio/")) return "audio (no in-context preview)";
  if (mimeType.startsWith("video/")) return "video (use vision tool)";
  return `${mimeType || "unknown mime"} (binary)`;
};

/**
 * Compute a structured preview of a chat-file. Pure function — no I/O,
 * no DB, no sandbox. Caller reads bytes (and the OCR sidecar text +
 * page count when applicable) and passes them in.
 *
 * Failure mode: returns `{ kind: "opaque", reason }` instead of
 * throwing so the upload pipeline never aborts because of snapshot
 * extraction.
 */
export const extractChatFileSnapshot = async (
  bytes: Uint8Array,
  mimeType: string,
  ocrSidecar: { markdown: string; pageCount: number | undefined } | undefined,
): Promise<ChatFileSnapshot> => {
  try {
    if (isCsvMime(mimeType)) return parseCsvSnapshot(bytes);
    if (isXlsxMime(mimeType)) return await parseXlsxSnapshot(bytes);
    if (isOcrSidecarMime(mimeType)) {
      if (ocrSidecar) {
        return parseDocumentSnapshot(ocrSidecar.markdown, ocrSidecar.pageCount);
      }
      return { kind: "opaque", reason: "call read(path) to view the text" };
    }
    if (isPlainTextMime(mimeType)) return parseTextSnapshot(bytes);
    return { kind: "opaque", reason: opaqueHint(mimeType) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "opaque",
      reason: `parse error: ${message.slice(0, 100)}`,
    };
  }
};

/**
 * Render a snapshot as the inner body of an `<attached_file>` block.
 * Caller wraps with `<attached_file path="..." mime="..."> ... </attached_file>`.
 *
 * Rendering is deterministic + line-stable so the chatbot system
 * prompt diffs cleanly across requests (good for OpenRouter's prompt
 * cache).
 */
export const renderSnapshot = (snapshot: ChatFileSnapshot): string => {
  switch (snapshot.kind) {
    case "tabular": {
      const headBlock =
        snapshot.head.length > 0
          ? `head (${snapshot.head.length} rows):\n  ${snapshot.columns
              .map((c) => c.name)
              .join(",")}\n  ${snapshot.head.join("\n  ")}`
          : "head: (empty — header only)";
      return [
        `rows: ${snapshot.rows}`,
        `columns: ${snapshot.columns
          .map((c) => `${c.name} (${c.dtype})`)
          .join(", ")}`,
        headBlock,
      ].join("\n");
    }
    case "document": {
      const out: string[] = [];
      if (snapshot.pages !== undefined) out.push(`pages: ${snapshot.pages}`);
      out.push(
        `extracted text: ${snapshot.sidecarChars} chars / ${snapshot.sidecarLines} lines${
          snapshot.sidecarLines > 1000
            ? " — large file: prefer paginated `read(path, offset, limit)` over a default full read"
            : ""
        }`,
      );
      if (snapshot.headings.length > 0) {
        out.push(
          `headings:\n  - ${snapshot.headings.slice(0, MAX_HEADINGS).join("\n  - ")}`,
        );
      }
      if (snapshot.excerpt.length > 0) {
        out.push(`excerpt:\n  ${snapshot.excerpt.split("\n").join("\n  ")}`);
      }
      out.push(
        `tables detected: ${snapshot.tablesDetected}, images: ${snapshot.imageCount}`,
      );
      if (snapshot.firstTableHead.length > 0) {
        out.push(
          `first table head:\n  ${snapshot.firstTableHead.join("\n  ")}`,
        );
      }
      return out.join("\n");
    }
    case "text":
      return [
        `lines: ${snapshot.lines}`,
        snapshot.headLines.length > 0
          ? `head (${snapshot.headLines.length} lines):\n  ${snapshot.headLines.join("\n  ")}`
          : "head: (empty)",
      ].join("\n");
    case "opaque":
      return `(no structured preview — ${snapshot.reason})`;
    default: {
      // Exhaustiveness check — fails the build if a new kind is added
      // without updating this switch. ESLint's `consistent-return`
      // also requires a path that doesn't fall off the end.
      const _exhaustive: never = snapshot;
      return _exhaustive;
    }
  }
};
