/**
 * Tabular-extraction eval suite. Validates the `tabular-extraction`
 * skill behaviour on the two failure modes that bit a real
 * conversation (`019dd9d6-f908-710f-ad2c-0dd7d6f5e573`) and that the
 * skill explicitly targets:
 *
 *   1. **Row-count completeness** — when the user asks for "every X",
 *      the deliverable must contain every X. The conv we're imitating
 *      shipped 9 rows for a 44-row source on first try.
 *   2. **Literal value preservation** — extracted strings must match
 *      the source byte-for-byte. No casing change, no translation, no
 *      number-locale flip.
 *
 * Plus one anti-trigger case: a prose-summary request must NOT pull
 * in the skill or call `presentFiles` — the deliverable is text.
 *
 * The suite reuses the `invoice.pdf` fixture (already on disk for the
 * `file-attachments` suite); a future iteration can add a
 * multi-row table fixture for a more aggressive row-count test.
 *
 * Each case is intentionally a single turn / single deliverable so a
 * full run stays under ~90s wall-clock total.
 */

import { readSessionFile } from "@fretik/shared/lib/chatbot-session-storage";
import type { EvalSuite } from "../types";

export const tabularExtractionSuite: EvalSuite = {
  name: "tabular-extraction",
  summary:
    "Skill behaviour on structured-data extraction tasks (row-count completeness, literal value preservation, anti-trigger on prose).",
  cases: [
    {
      id: "tabular-references-listing",
      description:
        "Multi-row extraction from a free-text field — every reference must appear, none invented",
      // The 'Références' field in invoice.md packs 8 numeric refs +
      // 2 mixed-format codes inside one cell, semicolon-separated.
      // The skill MUST count them, extract them all, and ship a CSV
      // with one row per reference — no normalisation of the alpha
      // codes (PBP-HOUSE*2567*20251114, *251112A271789 must survive
      // verbatim, asterisks and all).
      prompt:
        "Lis invoice.pdf et extrais TOUTES les références présentes dans le champ 'Références' du tableau 'Coordonnées du voyage' dans un CSV à une seule colonne `reference`, une par ligne. Conserve le texte exact de chaque référence sans modification.",
      tags: ["tabular-extraction", "completeness", "literal"],
      fixtures: ["invoice.pdf"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["read"], mode: "any" },
        { type: "toolUsed", tools: ["python"], mode: "any" },
        { type: "toolUsed", tools: ["presentFiles"], mode: "any" },
        {
          type: "judge",
          rubric:
            "The assistant produces a CSV (via python + presentFiles) containing a `reference` column with EVERY reference from the 'Références' field of invoice.md: the 8 numeric references (81288065, 81288241, 81290996, 81292414, 81293743, 81288265, 81288275, 81288224) AND the 2 mixed-format codes (PBP-HOUSE*2567*20251114 and *251112A271789, asterisks preserved). The assistant's caption mentions the row count (10). No reference is dropped, no reference is invented, no reference is paraphrased / sanitised (asterisks stay, hyphens stay, leading zeros stay).",
        },
      ],
    },
    {
      id: "tabular-literal-totals",
      description:
        "Single-row literal-preservation test — number locale and currency string must survive verbatim",
      prompt:
        "Lis invoice.pdf et génère un CSV à deux colonnes (`champ`, `valeur`) reprenant exactement les 5 lignes du tableau 'Totaux' (Échéance / Due to, Non soumis à TVA, Soumis à TVA, TVA / VAT, TOTAL TTC) avec leurs valeurs telles qu'écrites dans la facture, sans rien reformater.",
      tags: ["tabular-extraction", "literal"],
      fixtures: ["invoice.pdf"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["read"], mode: "any" },
        { type: "toolUsed", tools: ["presentFiles"], mode: "any" },
        {
          type: "judge",
          rubric:
            "The assistant produces a CSV with EXACTLY 5 rows (one per Totaux column from the source), and the values are LITERAL: 'CHEQUE A 30 JOURS — 30/12/2025' (with the em-dash, not a hyphen; uppercase preserved), '10 364,32' for the non-VAT amount (French decimal comma + non-breaking-space-style thousand separator preserved — NOT '10364.32' nor '10,364.32'), '0,00' for the VAT amounts (NOT '0' or '0.00'), '10 364,32 USD' for the TOTAL TTC (currency suffix preserved). Any locale flip, casing change, dash-character change, or rounding fails this assertion.",
        },
      ],
    },
    {
      id: "tabular-kernel-state-reuse",
      description:
        "Cross-call kernel persistence — a single python load must satisfy three follow-up questions in the same turn (no re-import, no re-read).",
      // The skill body now teaches "load each source ONCE into a named
      // DataFrame, reuse it across cells". This case probes that the
      // model actually exploits the persistent Jupyter kernel: one
      // turn that asks three questions over the same XLSX, expecting
      // a single `pd.read_excel` (or equivalent) and the rest of the
      // python calls to operate on the in-memory DataFrame.
      prompt:
        "Charge attachments/data.xlsx en pandas. Réponds aux trois questions ci-dessous dans la même réponse, en réutilisant le DataFrame déjà chargé : (1) combien de lignes au total ? (2) quelles sont les colonnes ? (3) si une colonne numérique contient les mots 'amount', 'total' ou 'price' (insensible à la casse), donne-moi la somme de cette colonne — sinon dis-le explicitement.",
      tags: ["tabular-extraction", "kernel-state"],
      fixtures: ["data.xlsx"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python"], mode: "any" },
        {
          type: "custom",
          name: "at-most-one-read_excel-across-python-calls",
          fn: (result) => {
            const pythonCalls = result.toolCalls.filter(
              (c) => c.name === "python",
            );
            // Count how many python calls re-read the file. Once is
            // expected (the initial load); twice or more means the
            // model ignored the persistent kernel and reloaded.
            const extractCode = (input: unknown): string => {
              if (typeof input !== "object" || input === null) return "";
              if (!("code" in input)) return "";
              const codeField: unknown = input.code;
              return typeof codeField === "string" ? codeField : "";
            };
            const reads = pythonCalls.filter((c) =>
              /pd\.read_excel|pandas\.read_excel/i.test(extractCode(c.input)),
            ).length;
            if (reads <= 1) return true;
            return `model re-read data.xlsx ${String(reads)}× across ${String(pythonCalls.length)} python calls — kernel state was not reused (load once, then refer to the DataFrame by name)`;
          },
        },
        {
          type: "judge",
          rubric:
            "The assistant gives a single coherent answer covering: (1) the total number of rows in data.xlsx as a number, (2) the list of column names verbatim, (3) either the sum of an amount-like numeric column with the column name, OR an explicit statement that no such column exists. Partial answers (one or two of the three) fail.",
        },
      ],
    },
    {
      id: "tabular-multidoc-cross-reference",
      description:
        "Multi-document join + literal numeric values — proves the model PARSED the source PDFs (with pdfplumber/the OCR sidecar) instead of TRANSCRIBING rows into Python tuple literals (the failure pattern observed on conv `019df045-f39a-76a5-a7fa-c74c7de68551`).",
      // The exact prompt and fixtures from a real production conv:
      //   - DAE (customs declaration) PDF: 43 articles indexed 1..43
      //   - 8 invoices merged into one PDF with `TOTAL HT €` columns
      // The user wants a single CSV joining the two sources on the
      // wine description (string-similarity over OCR-noisy fields).
      //
      // The failure mode this case targets: when the model "writes
      // python", it copy-pastes the data into Python list literals
      // (`dae_items = [(1, "...", 717.60), ...]`) instead of opening
      // the PDFs with `pdfplumber.open(...).extract_tables()`. The
      // transcription drops accents and apostrophes (`Côte d'Or` →
      // `Cote d Or`, `Hautes Côtes` → `Hautes C tes`, `L'Odyssée` →
      // `L Odyssee`), then the substring matcher fails on those rows
      // and ships an empty `Valeur Totale` for them — even though the
      // value is plainly visible in both the .pdf AND the .md sidecar.
      //
      // Three specific HT totals catch this exact regression:
      //   - Article 4  (Bourgogne Côte d'Or Chardonnay 2024 LPR) → 717.60
      //   - Article 38 (Bourgogne Hautes Côtes de Nuits 2023 GROS) → 954.00
      //   - Article 43 (Champagne L'Odyssée HENIN)               → 1740.00
      // All three were SHIPPED EMPTY by the buggy turn. If the model
      // genuinely parses the invoice PDF (or even the .md sidecar
      // through normalised matching), the three values land in the CSV.
      prompt: [
        "Génère un fichier CSV à partir de 2 documents joints : la DAE et la facture PDF.",
        "",
        "Structure du CSV (colonnes dans cet ordre) :NumeroArticle;Nomenclature;Titre Alcoometrique;Description;Marque;Origine;Quantite;Poids Brut;Poids Net;Valeur Totale;NbEmballage;Numero DAE;Date DAE",
        "",
        "Règles :",
        "Extrais les données directement depuis la DAE pour les colonnes : NumeroArticle, Nomenclature (code NC), Titre Alcoometrique, Description, Quantite, Poids Brut, Poids Net, NbEmballage, Numero DAE, Date DAE.",
        "Extrais Valeur Totale depuis une colonne TOTAL HT € ou autre colonne ressemblant, de la facture PDF. Si une même référence apparaît plusieurs fois, additionne les totaux.",
        "Extrais Marque depuis la facture PDF (nom du producteur/vigneron). Origine : laisse vide si non présent.",
        "Vérifie la cohérence entre les données des deux documents (quantités, descriptions, conditionnements). Signale les écarts.",
        "Adapte-toi au format et aux unités de chaque document — ne présume pas d'un format fixe.",
        "Livrables :",
        "Le CSV complet avec toutes les colonnes.",
        "Un rapport court listant les éventuelles incohérences ou anomalies détectées entre la DAE et la facture.",
      ].join("\n"),
      tags: ["tabular-extraction", "multi-doc", "parse-vs-transcribe"],
      fixtures: ["26FRS8592110000744702_1_dae.pdf", "ilovepdf_merged.pdf"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python"], mode: "any" },
        { type: "toolUsed", tools: ["presentFiles"], mode: "any" },
        {
          // The decisive assertion: load the produced CSV from S3 and
          // check that the three "trap" rows were actually filled.
          // Each row is identified by a substring on the Description
          // column to stay robust to minor OCR variations on the wine
          // names.
          type: "custom",
          name: "csv-contains-three-trap-totals",
          fn: async (result, ctx) => {
            const presentCall = result.toolCalls.find(
              (c) => c.name === "presentFiles",
            );
            if (!presentCall) {
              return "presentFiles was never called — no CSV to inspect";
            }
            const input = presentCall.input;
            if (typeof input !== "object" || input === null) {
              return "presentFiles input is not an object";
            }
            const rawPaths = (input as { paths?: unknown }).paths;
            if (!Array.isArray(rawPaths)) {
              return "presentFiles input has no `paths` array";
            }
            const csvPath = rawPaths.find(
              (p): p is string => typeof p === "string" && p.endsWith(".csv"),
            );
            if (!csvPath) {
              return `presentFiles paths did not include a .csv file (got: ${JSON.stringify(rawPaths)})`;
            }
            const bytes = await readSessionFile(ctx.conversationId, csvPath);
            if (!bytes) {
              return `CSV not found in session storage at ${csvPath}`;
            }
            const csv = Buffer.from(bytes).toString("utf8");
            const lines = csv.split(/\r?\n/).filter((l) => l.length > 0);
            // Header + 43 articles. Allow ±1 in case the model adds a
            // synthesis row at the end (some templates do that).
            if (lines.length < 43 || lines.length > 46) {
              return `CSV has ${String(lines.length)} non-empty lines (expected ~44 = header + 43 articles)`;
            }
            // Each trap is identified by a substring on the description
            // and the expected total. We tolerate French (`717,60`) and
            // anglo (`717.60`) decimal separators.
            const traps: {
              name: string;
              descMatch: RegExp;
              totals: RegExp[];
            }[] = [
              {
                name: "Bourgogne Côte d'Or 2024 LPR (article 4)",
                descMatch: /(C[ôo]te\s+d['\s]?Or|Cote\s+d\s?Or)/i,
                totals: [/717[.,]60/, /717[.,]6\b/],
              },
              {
                name: "Bourgogne Hautes Côtes de Nuits 2023 GROS (article 38)",
                descMatch: /Hautes\s+C[ôo]?\s?tes?\s+de\s+Nuits/i,
                totals: [/954[.,]00/, /\b954\b/],
              },
              {
                name: "Champagne L'Odyssée HENIN (article 43)",
                descMatch: /Champagne.*Odys[ée]e|HENIN/i,
                totals: [/1[\s.,]?740[.,]00/, /1[\s.,]?740\b/],
              },
            ];
            const failures: string[] = [];
            for (const trap of traps) {
              const matchedLines = lines.filter((l) => trap.descMatch.test(l));
              if (matchedLines.length === 0) {
                failures.push(`row not found for ${trap.name}`);
                continue;
              }
              const hasTotal = matchedLines.some((l) =>
                trap.totals.some((re) => re.test(l)),
              );
              if (!hasTotal) {
                failures.push(
                  `${trap.name}: row found but Valeur Totale missing — line: ${matchedLines[0]?.slice(0, 200) ?? ""}`,
                );
              }
            }
            if (failures.length > 0) {
              return `${String(failures.length)}/3 trap totals missing — ${failures.join(" | ")}`;
            }
            return true;
          },
        },
      ],
    },
    {
      id: "tabular-anti-trigger-summary",
      description:
        "Anti-trigger — a prose-summary request must NOT pull the tabular skill or produce a file",
      prompt:
        "Résume-moi en 2 phrases ce que contient le document invoice.pdf : qui facture qui, pour quel montant, et avec quelle échéance.",
      tags: ["tabular-extraction", "anti-trigger"],
      fixtures: ["invoice.pdf"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["read"], mode: "any" },
        { type: "toolNotUsed", tools: ["presentFiles"] },
        {
          type: "judge",
          rubric:
            "The assistant answers in 1-3 sentences of natural French prose, naming the issuer (Transports P.FATTON SA), the recipient (FATTON LOGISTICS INC / LONGCHAMP USA), the amount (10 364,32 USD), and the due date (30/12/2025). It does NOT call presentFiles, does NOT generate a CSV / Excel file, and does NOT switch into a structured-extraction workflow. The deliverable is text.",
        },
      ],
    },
  ],
};
