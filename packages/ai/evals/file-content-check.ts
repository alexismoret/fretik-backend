/**
 * Strong content checks for FILES the chatbot generates (`presentFiles`).
 *
 * `presentFiles` mirrors every deliverable to the S3 session store under
 * its workspace-relative path (`uploadSessionFile`), precisely so it
 * survives the sandbox pausing — which is what lets a `custom` eval
 * assertion (run AFTER the turn) read the produced bytes back and verify
 * their CONTENTS, not merely that a file was presented.
 *
 * v1 implements deterministic CSV/text verification (exact rows/columns,
 * numeric-tolerant). The retrieval layer (`getPresentedFiles` +
 * `readPresentedBytes`) is format-agnostic, so xlsx / docx / pdf / pptx
 * checks are added by plugging a parser for those bytes — see the
 * `// EXTENSION POINT` notes. Mechanical by design (BFCL/IFEval style):
 * a machine-written file has stable bytes, so an exact check is both
 * fair and far stronger than an LLM judge over the assistant's prose.
 */

import { readSessionFile } from "@fretik/shared/lib/chatbot-session-storage";
import type { EvalCaseContext, InvokeResult } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Trim + lowercase + strip accents — incidental differences, not content. */
const fold = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

/** One file the agent surfaced via `presentFiles` (from its tool output). */
export interface PresentedFile {
  /** Workspace-relative path the S3 mirror is keyed by (e.g. `outputs/recap.csv`). */
  path: string;
  filename: string;
  mimeType: string;
}

/** Every file presented in the turn (flattened across all presentFiles calls). */
export const getPresentedFiles = (result: InvokeResult): PresentedFile[] => {
  const out: PresentedFile[] = [];
  for (const call of result.toolCalls) {
    if (call.name !== "presentFiles") continue;
    const output = call.output;
    if (!isRecord(output) || !Array.isArray(output.files)) continue;
    for (const f of output.files) {
      if (!isRecord(f)) continue;
      const { path, filename, mimeType } = f;
      if (typeof path === "string" && typeof filename === "string") {
        out.push({
          path,
          filename,
          mimeType: typeof mimeType === "string" ? mimeType : "",
        });
      }
    }
  }
  return out;
};

/** Raw bytes of a presented deliverable, read back from the S3 session mirror. */
export const readPresentedBytes = async (
  ctx: EvalCaseContext,
  file: PresentedFile,
): Promise<Uint8Array | null> => readSessionFile(ctx.conversationId, file.path);

// ─────────────────────────── CSV / text layer ───────────────────────────

/**
 * Sniff the delimiter from the header line. Comma is the RFC default,
 * but machine/Excel CSVs routinely use `;` (European/French locale) or
 * tab — a robust content check must accept all three.
 */
const detectDelimiter = (text: string): string => {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [";", ",", "\t"]) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
};

/**
 * RFC-4180-ish CSV parse: quoted fields, escaped quotes (`""`), CRLF,
 * trailing newline, and `,` / `;` / tab delimiters (auto-detected from
 * the header unless `delimiter` is given). Returns a grid of string
 * cells (empty trailing rows dropped). Not a full dialect engine.
 */
export const parseCsv = (text: string, delimiter?: string): string[][] => {
  const delim = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (sawAny && (field.length > 0 || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
};

export interface CsvRecords {
  header: string[];
  /** Data rows keyed by their (original-case) header column. */
  rows: Record<string, string>[];
}

export const csvToRecords = (grid: string[][]): CsvRecords => {
  const [header = [], ...body] = grid;
  const rows = body.map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((col, i) => {
      rec[col] = cells[i] ?? "";
    });
    return rec;
  });
  return { header, rows };
};

/**
 * Parse a numeric cell across locales: tolerates spaces / NBSP / currency
 * and BOTH decimal conventions — European comma (`89,99`) and point
 * (`89.99`) — plus thousands separators in either style. When both `,`
 * and `.` appear, the last-occurring one is the decimal (`1.234,56` →
 * 1234.56, `1,234.56` → 1234.56); a lone comma/point forming pure 3-digit
 * groups (`17,000`, `1.000`) is thousands, otherwise it is the decimal.
 */
export const asNumber = (s: string): number | null => {
  const cleaned = s.replace(/[\s ]/g, "").replace(/[€$£%]/g, "");
  if (cleaned === "") return null;
  const neg = cleaned.startsWith("-");
  let t = cleaned.replace(/^[+-]/, "");
  const hasComma = t.includes(",");
  const hasDot = t.includes(".");
  if (hasComma && hasDot) {
    // Both present: the last-occurring separator is the decimal.
    const decimal = t.lastIndexOf(",") > t.lastIndexOf(".") ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    t = t.split(thousands).join("").replace(decimal, ".");
  } else if (hasComma) {
    // Lone comma: pure 3-digit groups = thousands, else decimal.
    t = /^\d{1,3}(,\d{3})+$/.test(t)
      ? t.split(",").join("")
      : t.replace(",", ".");
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(t)) {
    // Lone dot forming pure 3-digit groups = European thousands.
    t = t.split(".").join("");
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return neg ? -Number(t) : Number(t);
};

/**
 * Cell equality: numeric when both sides parse as numbers (so `17000`
 * == `17 000` == `17,000.0`), else trimmed case-insensitive string match
 * (incidental case/whitespace is not a content difference).
 */
export const cellEquals = (
  expected: string | number,
  actual: string,
): boolean => {
  if (typeof expected === "number") {
    const a = asNumber(actual);
    return a !== null && Math.abs(a - expected) < 1e-6;
  }
  const en = asNumber(expected);
  const an = asNumber(actual);
  if (en !== null && an !== null) return Math.abs(en - an) < 1e-6;
  return fold(expected) === fold(actual);
};

const colValue = (
  rec: Record<string, string>,
  col: string,
): string | undefined => {
  const target = fold(col);
  for (const [k, v] of Object.entries(rec)) {
    if (fold(k) === target) return v;
  }
  return undefined;
};

export interface CsvExpectation {
  /** Which presented file to check (default: the first `*.csv`). */
  filename?: RegExp;
  /** Columns the header MUST contain (case-insensitive; extra columns allowed). */
  requiredColumns?: string[];
  /** Exact data-row count. */
  rowCount?: number;
  /** Minimum data-row count. */
  minRows?: number;
  /**
   * Each expected record must match SOME data row on all the fields it
   * names (order-independent, numeric-tolerant). Use a key field +
   * the value(s) you assert, e.g. `{ region: "Nord", total: 17000 }`.
   */
  rows?: Record<string, string | number>[];
}

/**
 * Strong content check for a generated CSV: reads the presented file
 * back from session storage, parses it, and verifies columns / row
 * count / specific rows. Returns `true` (pass) or a failure string
 * (the `custom` assertion contract).
 */
export const checkGeneratedCsv = async (
  result: InvokeResult,
  ctx: EvalCaseContext,
  expect: CsvExpectation,
): Promise<true | string> => {
  const presented = getPresentedFiles(result);
  if (presented.length === 0) return "no file was presented (presentFiles)";
  const file = presented.find((f) =>
    expect.filename
      ? expect.filename.test(f.filename)
      : /\.csv$/i.test(f.filename),
  );
  if (!file) {
    return `no presented file matched ${expect.filename?.source ?? "*.csv"} (got: ${presented.map((f) => f.filename).join(", ")})`;
  }
  const bytes = await readPresentedBytes(ctx, file);
  if (!bytes) return `presented file ${file.path} not found in session storage`;

  const grid = parseCsv(new TextDecoder().decode(bytes));
  if (grid.length === 0) return `presented file ${file.filename} is empty`;
  const { header, rows } = csvToRecords(grid);

  for (const col of expect.requiredColumns ?? []) {
    if (!header.some((h) => fold(h) === fold(col))) {
      return `missing column "${col}" (header: ${header.join(", ")})`;
    }
  }
  if (expect.rowCount !== undefined && rows.length !== expect.rowCount) {
    return `expected ${expect.rowCount.toString()} data rows, got ${rows.length.toString()}`;
  }
  if (expect.minRows !== undefined && rows.length < expect.minRows) {
    return `expected ≥${expect.minRows.toString()} data rows, got ${rows.length.toString()}`;
  }
  for (const want of expect.rows ?? []) {
    const matched = rows.some((rec) =>
      Object.entries(want).every(([col, val]) => {
        const cell = colValue(rec, col);
        return cell !== undefined && cellEquals(val, cell);
      }),
    );
    if (!matched) {
      const desc = Object.entries(want)
        .map(([k, v]) => `${k}=${v.toString()}`)
        .join(", ");
      return `no row matched { ${desc} }`;
    }
  }
  return true;
};

// EXTENSION POINT (xlsx / docx / pdf / pptx):
//   getPresentedFiles + readPresentedBytes already return the raw bytes
//   for ANY format. To add e.g. xlsx, write a deterministic parser
//   (bytes → sheet rows) and a `checkGeneratedXlsx(result, ctx, expect)`
//   mirroring `checkGeneratedCsv`. For pdf/docx/pptx prefer extracting
//   text and asserting `contains`/structure (OCR/layout variance makes
//   exact-byte checks unfair there). Keep the deterministic path for
//   anything machine-written (csv, xlsx, json).
