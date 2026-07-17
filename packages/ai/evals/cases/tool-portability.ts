/**
 * Tool-portability eval suite (C3 model gate) — one probe per core
 * tool with NON-TRIVIAL arguments, scored mechanically wherever
 * possible (assertions on `toolCalls[].input`, exact text from
 * synthetic fixtures). Method borrowed from BFCL (AST-style argument
 * checking) but every case targets OUR tools and OUR schemas — no
 * imported benchmark data.
 *
 * These cases are the per-model portability signal: a model that
 * passes them produces syntactically AND semantically correct calls
 * against the production tool registry. The `tool-call-validity`
 * score (Zod safeParse over recorded inputs) runs on top of every
 * case automatically.
 *
 * The three `parallel`-tagged probes ask for independent lookups in
 * one breath. Their ASSERTIONS only require that both lookups happen
 * (blocking-safe on models without parallel calls).
 */

import { checkGeneratedCsv } from "../file-content-check";
import type { EvalSuite } from "../types";

export const toolPortabilitySuite: EvalSuite = {
  name: "tool-portability",
  summary:
    "Per-tool argument-precision probes (sql quoting/aggregates, python multi-line, read offset/limit, memory, searchTools activation, presentFiles, dispatchAgent cheap, webSearch date) + parallel-batching probes.",
  cases: [
    {
      id: "tp-sql-quoting",
      description:
        "SQL with an embedded apostrophe → properly quoted query, valid and bounded",
      prompt:
        "Combien de documents de l'équipe ont un nom de fichier qui contient exactement le texte « d'expédition » (avec l'apostrophe) ? Donne juste le nombre.",
      tags: ["tool-portability", "sql"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["querySql"], mode: "any" },
        {
          type: "custom",
          name: "every row-returning querySql call carries a LIMIT",
          fn: (result) => {
            const calls = result.toolCalls.filter((c) => c.name === "querySql");
            if (calls.length === 0) return "no querySql call observed";
            for (const call of calls) {
              const input = call.input as { sql_query?: unknown };
              const sql =
                typeof input?.sql_query === "string" ? input.sql_query : "";
              // Single-row aggregates (COUNT/SUM/… without GROUP BY) return one
              // row — a LIMIT is pointless, so don't require it. The LIMIT guard
              // only protects the context window on row-returning queries.
              const isSingleRowAggregate =
                /^\s*select\s+(count|sum|avg|min|max)\s*\(/i.test(sql) &&
                !/group\s+by/i.test(sql);
              if (!isSingleRowAggregate && !/limit\s+\d+/i.test(sql)) {
                return `querySql without LIMIT: ${sql.slice(0, 80)}`;
              }
            }
            return true;
          },
        },
      ],
    },
    {
      id: "tp-sql-aggregate",
      description: "Aggregation ask → GROUP BY query, not row-by-row browsing",
      prompt:
        "Compte les documents de l'équipe par type de document et donne-moi la répartition (type → nombre).",
      tags: ["tool-portability", "sql"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["querySql"], mode: "any" },
        {
          type: "custom",
          name: "at least one querySql call aggregates (GROUP BY or COUNT)",
          fn: (result) => {
            const calls = result.toolCalls.filter((c) => c.name === "querySql");
            if (calls.length === 0) return "no querySql call observed";
            const aggregated = calls.some((call) => {
              const input = call.input as { sql_query?: unknown };
              const sql =
                typeof input?.sql_query === "string" ? input.sql_query : "";
              return /group\s+by/i.test(sql) || /count\s*\(/i.test(sql);
            });
            return aggregated || "no GROUP BY / COUNT(...) in any querySql";
          },
        },
      ],
    },
    {
      id: "tp-python-multiline",
      description: "Computation ask → multi-line python script, exact result",
      prompt:
        "Avec un script Python : calcule les 15 premiers nombres de la suite de Fibonacci (en commençant par 1, 1) et donne-moi leur somme exacte.",
      tags: ["tool-portability", "python"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python"], mode: "any" },
        { type: "contains", value: "1596" },
        {
          type: "custom",
          name: "at least one python call carries a multi-line script",
          fn: (result) => {
            const calls = result.toolCalls.filter((c) => c.name === "python");
            if (calls.length === 0) return "no python call observed";
            const multiline = calls.some((call) => {
              const input = call.input as { code?: unknown };
              const code = typeof input?.code === "string" ? input.code : "";
              return code.trim().split("\n").length >= 2;
            });
            return multiline || "every python call was a one-liner";
          },
        },
      ],
    },
    {
      id: "tp-read-offset",
      description:
        "Windowed read of a long file → offset/limit args, exact line surfaced",
      prompt:
        "Dans le fichier joint long-report.md, lis UNIQUEMENT les lignes 40 à 60 (utilise les paramètres offset et limit de l'outil de lecture) et dis-moi quel est le numéro de note de la première ligne de cette plage.",
      tags: ["tool-portability", "read"],
      fixtures: ["long-report.md"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["read"], mode: "any" },
        { type: "contains", value: "#40" },
        {
          type: "custom",
          name: "a read call windows the file (offset ≈ 40, limit ≈ 21)",
          fn: (result) => {
            const calls = result.toolCalls.filter((c) => c.name === "read");
            if (calls.length === 0) return "no read call observed";
            const windowed = calls.some((call) => {
              const input = call.input as { offset?: unknown; limit?: unknown };
              const offset =
                typeof input?.offset === "number" ? input.offset : undefined;
              const limit =
                typeof input?.limit === "number" ? input.limit : undefined;
              return (
                offset !== undefined &&
                offset >= 38 &&
                offset <= 42 &&
                limit !== undefined &&
                limit >= 15 &&
                limit <= 30
              );
            });
            return windowed || "no read call used offset≈40 / limit≈21";
          },
        },
      ],
    },
    {
      id: "tp-xlsx-python",
      description:
        "Spreadsheet attachment → routed to python (pandas/openpyxl), not read",
      prompt:
        "Ouvre le fichier joint data.xlsx et dis-moi combien de lignes de données contient la première feuille.",
      tags: ["tool-portability", "routing"],
      fixtures: ["data.xlsx"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python"], mode: "any" },
        {
          type: "judge",
          rubric:
            "The assistant opens data.xlsx with python (pandas.read_excel or openpyxl) and reports a CONCRETE row count for the first sheet. Reporting a number obtained any other way (guessing, describing the file without opening it) is a FAIL. The exact number is not graded — only that it comes from actually parsing the spreadsheet.",
        },
      ],
    },
    {
      id: "tp-memory-view",
      description: "Memory introspection ask → memory(view) on a directory",
      prompt:
        "Montre-moi la liste des fichiers actuellement stockés dans ta mémoire (la mienne et celle de l'équipe). Si elle est vide, dis-le simplement.",
      tags: ["tool-portability", "memory"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["memory"], mode: "any" },
        {
          type: "custom",
          name: "at least one memory call uses command=view",
          fn: (result) => {
            const calls = result.toolCalls.filter((c) => c.name === "memory");
            if (calls.length === 0) return "no memory call observed";
            const viewed = calls.some((call) => {
              const input = call.input as { command?: unknown };
              return input?.command === "view";
            });
            return viewed || "no memory call used command=view";
          },
        },
      ],
    },
    {
      id: "tp-searchtools-activation",
      description:
        "Domain-tool ask → searchTools activation THEN the activated tool",
      prompt:
        "Utilise l'outil de listing des documents de l'équipe pour me montrer les documents les plus récents du drive (pas de requête SQL).",
      tags: ["tool-portability", "progressive-disclosure"],
      assertions: [
        { type: "noError" },
        {
          type: "toolUsed",
          tools: ["searchTools", "listDocuments"],
          mode: "all",
        },
        { type: "toolNotUsed", tools: ["querySql"] },
      ],
    },
    {
      id: "tp-present-files",
      description:
        "Generated deliverable → file written in sandbox + presentFiles card",
      prompt:
        "Crée un fichier CSV nommé produits.csv avec 3 lignes (colonnes : produit, prix — invente des valeurs plausibles), enregistre-le dans outputs/ et présente-le-moi.",
      tags: ["tool-portability", "deliverable"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python", "bash"], mode: "any" },
        { type: "toolUsed", tools: ["presentFiles"], mode: "any" },
        {
          type: "custom",
          name: "produits.csv is a real CSV with a produit/prix header and 3 rows",
          fn: (result, ctx) =>
            checkGeneratedCsv(result, ctx, {
              filename: /produits\.csv$/i,
              requiredColumns: ["produit", "prix"],
              rowCount: 3,
            }),
        },
      ],
    },
    {
      id: "tp-dispatch-cheap",
      description:
        "Explicitly cheap delegation → dispatchAgent with model='cheap'",
      prompt:
        "Délègue à un sous-agent en mode ÉCONOMIQUE (modèle cheap) la tâche suivante, puis restitue-moi son résultat tel quel : résumer en exactement 3 puces ce texte — « Les équipes achats passent en moyenne 11 heures par semaine à ressaisir des données depuis des PDF fournisseurs. Les erreurs de ressaisie représentent 2 % des lignes et coûtent en moyenne 18 € par correction. L'automatisation de l'extraction réduit la ressaisie de 80 % dès le premier mois. »",
      tags: ["tool-portability", "dispatch"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["dispatchAgent"], mode: "any" },
        {
          type: "custom",
          name: "a dispatchAgent call routes to model='cheap'",
          fn: (result) => {
            const calls = result.toolCalls.filter(
              (c) => c.name === "dispatchAgent",
            );
            if (calls.length === 0) return "no dispatchAgent call observed";
            const cheap = calls.some((call) => {
              const input = call.input as { model?: unknown };
              return input?.model === "cheap";
            });
            return cheap || "no dispatchAgent call used model='cheap'";
          },
        },
      ],
    },
    {
      id: "tp-websearch-date",
      description:
        "Date-bounded web search → start_date parameter, not date-in-query prose",
      prompt:
        "Cherche sur le web les annonces publiées strictement après le 1er janvier 2026 concernant la réglementation européenne sur l'IA, et cite 2 sources.",
      tags: ["tool-portability", "web"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["searchWeb"], mode: "any" },
        {
          type: "custom",
          name: "a searchWeb call sets start_date=2026-01-01 (±1 day)",
          fn: (result) => {
            const calls = result.toolCalls.filter(
              (c) => c.name === "searchWeb",
            );
            if (calls.length === 0) return "no searchWeb call observed";
            const dated = calls.some((call) => {
              const input = call.input as { start_date?: unknown };
              return (
                typeof input?.start_date === "string" &&
                /^2026-01-0[12]$/.test(input.start_date)
              );
            });
            return (
              dated ||
              "no searchWeb call carried start_date≈2026-01-01 — the date constraint stayed in prose"
            );
          },
        },
      ],
    },
    // ── Parallel-batching probes (informational — see suite docblock) ──
    // NOTE: the former `tp-vision-image` probe was removed — since C5 it
    // graded only the answer (never the tool), making it a duplicate of
    // `mm-image-scene-qa` on the same fixture. The multimodal suite owns
    // visual-answer accuracy.
    {
      id: "par-two-sql",
      description:
        "Two independent counts asked at once → ideally batched in parallel",
      prompt:
        "Donne-moi deux chiffres, si possible en lançant les deux requêtes en parallèle : (1) le nombre total de documents de l'équipe, (2) le nombre total de fiches dans nos objets d'équipe (tous types confondus).",
      tags: ["tool-portability", "parallel"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "both counts were actually looked up (≥2 data lookups)",
          fn: (result) => {
            const lookups = result.toolCalls.filter((c) =>
              ["querySql", "listDocuments", "listObjects"].includes(c.name),
            );
            return (
              lookups.length >= 2 ||
              `only ${lookups.length.toString()} data lookup(s) observed`
            );
          },
        },
      ],
    },
    {
      id: "par-sql-web",
      description:
        "Independent internal + external lookups → ideally batched in parallel",
      prompt:
        "J'ai besoin de deux informations indépendantes, lance les deux recherches en même temps si tu peux : (1) combien de documents compte notre équipe, (2) quelle est la dernière version stable de PostgreSQL d'après le web.",
      tags: ["tool-portability", "parallel"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["querySql"], mode: "any" },
        { type: "toolUsed", tools: ["searchWeb"], mode: "any" },
      ],
    },
    {
      id: "par-two-reads",
      description:
        "Two attachments summarised at once → ideally batched in parallel",
      prompt:
        "Résume chacun des deux fichiers joints (notes.txt et invoice.pdf) en une seule ligne chacun.",
      tags: ["tool-portability", "parallel"],
      fixtures: ["notes.txt", "invoice.pdf"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["read"], mode: "any" },
        {
          type: "custom",
          name: "both attachments were opened (≥2 read/vision calls)",
          fn: (result) => {
            const opens = result.toolCalls.filter((c) =>
              ["read", "vision", "python"].includes(c.name),
            );
            return (
              opens.length >= 2 ||
              `only ${opens.length.toString()} file-open call(s) observed`
            );
          },
        },
      ],
    },
  ],
};
