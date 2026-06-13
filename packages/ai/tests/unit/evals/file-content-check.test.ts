/**
 * Unit tests for the deterministic parts of the generated-file content
 * check (`evals/file-content-check.ts`). The S3 read-back is exercised
 * live by the file-generation eval cases; here we pin the pure logic:
 * CSV parsing, record shaping, numeric tolerance, and presented-file
 * extraction from a turn's tool calls.
 */

import { describe, expect, test } from "bun:test";
import {
  asNumber,
  cellEquals,
  csvToRecords,
  getPresentedFiles,
  parseCsv,
} from "../../../evals/file-content-check";
import type { InvokeResult, ToolCallTrace } from "../../../evals/types";

const invoke = (toolCalls: ToolCallTrace[]): InvokeResult => ({
  text: "",
  toolCalls,
  latencyMs: 0,
  toolLatencyMs: 0,
  modelLatencyMs: 0,
});

describe("parseCsv", () => {
  test("simple grid with trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n3,4\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
  test("quoted field with embedded comma and escaped quote", () => {
    expect(parseCsv('name,note\n"Doe, John","he said ""hi"""')).toEqual([
      ["name", "note"],
      ["Doe, John", 'he said "hi"'],
    ]);
  });
  test("CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  test("auto-detects semicolon delimiter (French Excel)", () => {
    expect(parseCsv("produit;prix\nChaise;89,99\n")).toEqual([
      ["produit", "prix"],
      ["Chaise", "89,99"],
    ]);
  });
  test("auto-detects tab delimiter", () => {
    expect(parseCsv("a\tb\n1\t2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("csvToRecords", () => {
  test("keys body rows by header", () => {
    const { header, rows } = csvToRecords([
      ["region", "total"],
      ["Nord", "17000"],
      ["Sud", "15500"],
    ]);
    expect(header).toEqual(["region", "total"]);
    expect(rows).toEqual([
      { region: "Nord", total: "17000" },
      { region: "Sud", total: "15500" },
    ]);
  });
});

describe("asNumber", () => {
  test("plain / spaced / thousands / decimal / currency", () => {
    expect(asNumber("17000")).toBe(17000);
    expect(asNumber("17 000")).toBe(17000);
    expect(asNumber("17,000")).toBe(17000);
    expect(asNumber("17000.5")).toBe(17000.5);
    expect(asNumber("€17000")).toBe(17000);
  });
  test("European comma decimal vs point decimal", () => {
    expect(asNumber("89,99")).toBe(89.99); // EU decimal comma
    expect(asNumber("89.99")).toBe(89.99); // point decimal
    expect(asNumber("1.234,56")).toBe(1234.56); // EU: dot thousands, comma decimal
    expect(asNumber("1,234.56")).toBe(1234.56); // US: comma thousands, dot decimal
    expect(asNumber("1.000")).toBe(1000); // EU thousands
    expect(asNumber("-12,5")).toBe(-12.5);
  });
  test("non-numeric → null", () => {
    expect(asNumber("actif")).toBeNull();
    expect(asNumber("")).toBeNull();
  });
});

describe("cellEquals", () => {
  test("numeric expected tolerates formatting", () => {
    expect(cellEquals(17000, "17 000")).toBe(true);
    expect(cellEquals(17000, "17000.0")).toBe(true);
    expect(cellEquals(17000, "17500")).toBe(false);
  });
  test("string expected is trimmed + case-insensitive", () => {
    expect(cellEquals("actif", " Actif ")).toBe(true);
    expect(cellEquals("actif", "inactif")).toBe(false);
  });
  test("numeric strings on both sides compare numerically", () => {
    expect(cellEquals("1 596", "1596")).toBe(true);
  });
});

describe("getPresentedFiles", () => {
  test("flattens files across presentFiles calls, ignores other tools", () => {
    const files = getPresentedFiles(
      invoke([
        { name: "python", input: {}, output: "ran" },
        {
          name: "presentFiles",
          input: { paths: ["outputs/recap.csv"] },
          output: {
            files: [
              {
                path: "outputs/recap.csv",
                filename: "recap.csv",
                mimeType: "text/csv",
                size: 42,
              },
            ],
          },
        },
      ]),
    );
    expect(files).toEqual([
      {
        path: "outputs/recap.csv",
        filename: "recap.csv",
        mimeType: "text/csv",
      },
    ]);
  });
  test("no presentFiles call → empty", () => {
    expect(
      getPresentedFiles(invoke([{ name: "python", input: {}, output: "x" }])),
    ).toEqual([]);
  });
});
