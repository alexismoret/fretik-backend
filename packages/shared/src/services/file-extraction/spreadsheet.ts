import ExcelJS from "exceljs";
import { Readable } from "node:stream";

/**
 * Spreadsheet branch — turns an XLSX / XLS / CSV workbook into a
 * markdown document. Each worksheet becomes a `## Sheet: X` section
 * followed by a markdown table. Empty trailing rows / columns are
 * trimmed, and very large sheets are truncated with a visible marker
 * so downstream consumers know content is missing.
 */

const MAX_ROWS_PER_SHEET = 2000;

const escapeCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === "string") {
    str = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    str = String(value);
  } else if (typeof value === "object") {
    // ExcelJS cell values can be rich-text, hyperlinks or formula
    // results. Coerce to a printable string without exposing raw
    // JSON unless that is all we have.
    const obj = value as { text?: unknown; result?: unknown };
    if (typeof obj.text === "string") {
      str = obj.text;
    } else if (
      typeof obj.result === "string" ||
      typeof obj.result === "number"
    ) {
      str = String(obj.result);
    } else {
      try {
        str = JSON.stringify(value);
      } catch {
        str = "";
      }
    }
  } else {
    str = "";
  }
  return str.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
};

interface ParsedSheet {
  name: string;
  markdown: string;
  truncated: boolean;
  rowCountFull: number;
}

const parseSheet = (worksheet: ExcelJS.Worksheet): ParsedSheet => {
  const rows: string[][] = [];
  let colCount = 0;
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      while (cells.length < colNumber - 1) cells.push("");
      cells.push(escapeCell(cell.value));
    });
    if (cells.length > colCount) colCount = cells.length;
    if (cells.some((c) => c.length > 0)) rows.push(cells);
  });

  if (rows.length === 0 || colCount === 0) {
    return {
      name: worksheet.name,
      markdown: "_Empty sheet._",
      truncated: false,
      rowCountFull: 0,
    };
  }

  const padded = rows.map((row) => {
    while (row.length < colCount) row.push("");
    return row;
  });

  const rowCountFull = padded.length;
  const truncated = rowCountFull > MAX_ROWS_PER_SHEET;
  const kept = truncated ? padded.slice(0, MAX_ROWS_PER_SHEET) : padded;

  const [header, ...body] = kept;
  const headerRow = header ?? [];
  const lines: string[] = [];
  lines.push(`| ${headerRow.join(" | ")} |`);
  lines.push(`| ${headerRow.map(() => "---").join(" | ")} |`);
  for (const row of body) {
    lines.push(`| ${row.join(" | ")} |`);
  }

  if (truncated) {
    lines.push("");
    lines.push(
      `_…truncated: kept the first ${MAX_ROWS_PER_SHEET.toString()} rows of ${rowCountFull.toString()} total._`,
    );
  }

  return {
    name: worksheet.name,
    markdown: lines.join("\n"),
    truncated,
    rowCountFull,
  };
};

export interface SpreadsheetParsingResult {
  content: string;
  sheetCount: number;
  warnings: string[];
}

export const parseSpreadsheet = async (args: {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}): Promise<SpreadsheetParsingResult> => {
  const workbook = new ExcelJS.Workbook();

  try {
    const arrayBuffer = new ArrayBuffer(args.bytes.byteLength);
    new Uint8Array(arrayBuffer).set(args.bytes);

    if (
      args.mimeType === "text/csv" ||
      args.filename.toLowerCase().endsWith(".csv")
    ) {
      // Readable.from of a typed array iterates byte-by-byte — wrap
      // in a single-element array so exceljs receives one chunk.
      const chunk = Buffer.alloc(args.bytes.byteLength);
      chunk.set(args.bytes);
      await workbook.csv.read(Readable.from([chunk]));
    } else {
      await workbook.xlsx.load(arrayBuffer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse spreadsheet: ${message}`, {
      cause: error,
    });
  }

  const sections: string[] = [];
  const warnings: string[] = [];
  let sheetCount = 0;

  workbook.worksheets.forEach((worksheet) => {
    sheetCount += 1;
    const parsed = parseSheet(worksheet);
    sections.push(`## Sheet: ${parsed.name}`);
    sections.push("");
    sections.push(parsed.markdown);
    sections.push("");
    if (parsed.truncated) {
      warnings.push(
        `Sheet "${parsed.name}" truncated at ${MAX_ROWS_PER_SHEET.toString()} rows (full size: ${parsed.rowCountFull.toString()}).`,
      );
    }
  });

  if (sheetCount === 0) {
    return {
      content: "_Workbook contained no worksheets._",
      sheetCount: 0,
      warnings,
    };
  }

  return {
    content: sections.join("\n").trimEnd(),
    sheetCount,
    warnings,
  };
};
