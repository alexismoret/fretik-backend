/**
 * Instruction-following eval suite (C3 model gate) — verifiable
 * output constraints checked by MECHANICAL validators (regex / custom
 * fns), no judge. Method borrowed from IFEval (each instruction is a
 * machine-checkable rule: counts, casing, forbidden words, prefixes,
 * raw-JSON shape) but every prompt is written for OUR product voice —
 * no imported benchmark data.
 *
 * The two `structured-output`-tagged probes additionally feed the
 * gate's `structuredOutput.grade` suggestion: they JSON.parse the
 * answer and shape-check it. Note: MiniMax M3's catalog does NOT
 * expose `structured_outputs` — these probes are the detector for
 * what that costs in practice.
 */

import type { EvalSuite } from "../types";

const countWords = (text: string): number =>
  text.trim().split(/\s+/).filter(Boolean).length;

const countBullets = (text: string): number =>
  text.split(/\r?\n/).filter((line) => /^\s*[-•*]\s+\S/.test(line)).length;

export const instructionFollowingSuite: EvalSuite = {
  name: "instruction-following",
  summary:
    "IFEval-style mechanical validators: exact bullet count, forbidden word, all-caps, word limit, prefix/suffix, no-tools discipline, raw-JSON and fenced-JSON fidelity.",
  cases: [
    {
      id: "if-bullet-count",
      description: "Exactly 5 bullets — counted mechanically",
      prompt:
        "Donne-moi des idées de noms pour une newsletter interne, sous forme de liste à puces : EXACTEMENT 5 puces, une idée par puce, rien d'autre.",
      tags: ["instruction-following"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "answer contains exactly 5 bullet lines",
          fn: (result) => {
            const n = countBullets(result.text);
            return n === 5 || `expected exactly 5 bullets, got ${n.toString()}`;
          },
        },
      ],
    },
    {
      id: "if-forbidden-word",
      description: "Forbidden word never appears — substring check",
      prompt:
        "Explique ce qu'est un bilan comptable en trois phrases, SANS JAMAIS utiliser le mot « entreprise » (ni au singulier ni au pluriel).",
      tags: ["instruction-following"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "the word « entreprise » never appears",
          fn: (result) =>
            !result.text.toLowerCase().includes("entreprise") ||
            "the forbidden word « entreprise » appears in the answer",
        },
      ],
    },
    {
      id: "if-uppercase",
      description: "All-caps constraint — letter-casing ratio check",
      prompt:
        "Réponds UNIQUEMENT EN LETTRES MAJUSCULES : quels sont les trois ingrédients d'une bonne réunion d'équipe ?",
      tags: ["instruction-following"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "≥95% of letters are uppercase",
          fn: (result) => {
            const letters = result.text.match(/\p{L}/gu) ?? [];
            if (letters.length < 20) return "answer too short to grade";
            const lower = letters.filter(
              (ch) => ch !== ch.toUpperCase(),
            ).length;
            const ratio = 1 - lower / letters.length;
            return (
              ratio >= 0.95 ||
              `only ${(ratio * 100).toFixed(0)}% of letters are uppercase`
            );
          },
        },
      ],
    },
    {
      id: "if-word-limit",
      description: "Hard word budget — mechanical word count",
      prompt:
        "Décris l'utilité d'un CRM pour une équipe commerciale en AU PLUS 25 mots.",
      tags: ["instruction-following"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "answer is between 5 and 25 words",
          fn: (result) => {
            const n = countWords(result.text);
            if (n > 25) return `answer has ${n.toString()} words (max 25)`;
            if (n < 5) return `answer has only ${n.toString()} words`;
            return true;
          },
        },
      ],
    },
    {
      id: "if-prefix-suffix",
      description: "Exact prefix + exact final word — anchored regex",
      prompt:
        "Réponds à la question « pourquoi documenter ses processus ? ». Ta réponse doit commencer EXACTEMENT par « En bref : » et son tout dernier mot doit être « efficacité ».",
      tags: ["instruction-following"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "answer starts with « En bref : » and ends with « efficacité »",
          fn: (result) => {
            const text = result.text.trim();
            if (!/^En bref\s?:/u.test(text)) {
              return `answer does not start with « En bref : » (starts: ${text.slice(0, 30)})`;
            }
            if (!/efficacité\s*[.!]?\s*$/iu.test(text)) {
              return `answer does not end with « efficacité » (ends: ${text.slice(-30)})`;
            }
            return true;
          },
        },
      ],
    },
    {
      id: "if-no-tools",
      description: "Explicit no-tools constraint — knowledge-only answer",
      prompt:
        "SANS utiliser aucun outil (pas de recherche, pas de requête, pas de code) : explique-moi en quelques phrases la différence entre marge brute et marge nette.",
      tags: ["instruction-following"],
      assertions: [
        { type: "noError" },
        {
          type: "toolNotUsed",
          tools: [
            "querySql",
            "searchKnowledge",
            "searchWeb",
            "python",
            "bash",
            "read",
            "vision",
            "dispatchAgent",
            "searchTools",
          ],
        },
        { type: "contains", value: "marge", caseInsensitive: true },
      ],
    },
    // ── Structured-output probes (feed structuredOutput.grade) ──────
    {
      id: "if-json-only",
      description:
        "Raw JSON object, no prose, no fences — parsed + shape-checked",
      prompt:
        "Renvoie UNIQUEMENT un objet JSON brut — pas de texte autour, pas de bloc de code markdown — avec exactement ces clés : `name` (string), `founded` (number, une année), `tags` (tableau d'exactement 3 strings). Le contenu décrit une société fictive de ton choix.",
      tags: ["instruction-following", "structured-output"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "raw answer parses as JSON with the exact expected shape",
          fn: (result) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(result.text.trim());
            } catch {
              return `answer is not raw parseable JSON (starts: ${result.text.trim().slice(0, 40)})`;
            }
            if (typeof parsed !== "object" || parsed === null) {
              return "parsed JSON is not an object";
            }
            const obj = parsed as Record<string, unknown>;
            if (typeof obj.name !== "string") return "`name` is not a string";
            if (typeof obj.founded !== "number") {
              return "`founded` is not a number";
            }
            if (
              !Array.isArray(obj.tags) ||
              obj.tags.length !== 3 ||
              obj.tags.some((t) => typeof t !== "string")
            ) {
              return "`tags` is not an array of exactly 3 strings";
            }
            return true;
          },
        },
      ],
    },
    {
      id: "if-json-fenced",
      description: "Fenced ```json block — extracted, parsed, shape-checked",
      prompt:
        'Donne-moi un tableau JSON de 3 objets de la forme {"id": number, "label": string} (des étapes d\'onboarding fictives), présenté dans un bloc de code ```json.',
      tags: ["instruction-following", "structured-output"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "a ```json fence contains an array of 3 {id, label} objects",
          fn: (result) => {
            const match = /```json\s*([\s\S]*?)```/.exec(result.text);
            if (!match?.[1]) return "no ```json fenced block in the answer";
            let parsed: unknown;
            try {
              parsed = JSON.parse(match[1].trim());
            } catch {
              return "fenced block is not parseable JSON";
            }
            if (!Array.isArray(parsed) || parsed.length !== 3) {
              return "fenced JSON is not an array of exactly 3 items";
            }
            for (const item of parsed) {
              if (typeof item !== "object" || item === null) {
                return "an item is not an object";
              }
              const rec = item as Record<string, unknown>;
              if (typeof rec.id !== "number") return "`id` is not a number";
              if (typeof rec.label !== "string") {
                return "`label` is not a string";
              }
            }
            return true;
          },
        },
      ],
    },
  ],
};
