/**
 * Structured-extraction eval suite. Validates the `extract` tool is the
 * agent's path for "data out of a document" — the anti-pattern being
 * regression-tested is the observed prod failure where the agent
 * iterated layout-specific python parsing scripts (pdfplumber / regex)
 * against an attached PDF for minutes instead of extracting.
 *
 * Cases reuse the light `invoice.pdf` fixture (already provisioned for
 * `file-attachments`) — per `curation.ts`, heavy multi-doc extraction
 * cases grow from real prod documents via `promoteTrace`, not from
 * synthetic fixtures.
 */

import type { EvalSuite } from "../types";

export const extractionSuite: EvalSuite = {
  name: "extraction",
  summary:
    "Schema-driven document extraction routes through the extract tool, completely and literally.",
  cases: [
    {
      id: "ex-pdf-line-items",
      description:
        "Extracting every line item of an attached PDF goes through `extract` (records shape), not an ad-hoc parsing script",
      prompt:
        "Extrais toutes les lignes de la facture invoice.pdf en JSON : description, quantité, prix unitaire, montant. Ne rate aucune ligne.",
      tags: ["files", "extract", "extraction"],
      fixtures: ["invoice.pdf"],
      budget: {
        maxToolCalls: 6,
        expectedTools: ["read", "extract", "python", "presentFiles"],
      },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["extract"], mode: "any" },
        {
          type: "judge",
          rubric:
            "PASS if the assistant obtains the invoice's line items through the `extract` tool and presents them as a structured set (JSON or table) with literal values from the document (descriptions not translated or paraphrased, numbers as printed). FAIL if it parses the PDF with a layout-specific python script (pdfplumber / regex / coordinates), if it visibly invents or paraphrases values, if it presents an obviously partial set without flagging it, or if it claims the file is unreadable.",
        },
      ],
    },
    {
      id: "ex-record-header-fields",
      description:
        "Extracting a document's header fields uses `extract` (record shape) and returns literal values",
      prompt:
        "Donne-moi en JSON les champs d'en-tête de invoice.pdf : numéro de facture, date, devise, montant total TTC.",
      tags: ["files", "extract", "extraction"],
      fixtures: ["invoice.pdf"],
      budget: { maxToolCalls: 4, expectedTools: ["read", "extract"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["extract"], mode: "any" },
        {
          type: "judge",
          rubric:
            "PASS if the assistant returns the invoice's header fields as structured values with a total TTC of 10 364,32 USD (accept 10364.32 and either decimal/thousands formatting; currency USD). FAIL if the total or currency is wrong, if values are guessed without a tool call on the file, or if the answer is prose with no structured fields.",
        },
      ],
    },
    {
      id: "ex-extract-not-python",
      description:
        "A pure extraction ask needs no python at all — extract answers it directly",
      prompt:
        "Liste-moi sous forme de tableau toutes les lignes de invoice.pdf avec leur montant.",
      tags: ["files", "extract", "routing"],
      fixtures: ["invoice.pdf"],
      budget: { maxToolCalls: 4, expectedTools: ["read", "extract"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["extract"], mode: "any" },
        { type: "toolNotUsed", tools: ["python"] },
        {
          type: "judge",
          rubric:
            "PASS if the assistant presents the invoice's line items as a table built from the `extract` tool's output, without running any python code. FAIL if it writes python to parse the PDF, transcribes values into a script, or answers without reading the document.",
        },
      ],
    },
  ],
};
