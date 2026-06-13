/**
 * B2B office-employee efficiency suite (C11) — realistic generalist
 * tasks (Contrôle de gestion, Comptabilité, Admin, Finance, Commercial…)
 * chosen to exercise the tool-calling EFFICIENCY metrics, not just
 * correctness. Every case declares a `budget` (maxToolCalls /
 * expectedTools): the budget feeds the INFORMATIONAL efficiency scores
 * (`tool-budget-overage`, `avg-tool-calls`, `tool-error-rate`,
 * `redundant-call-rate`) and never folds into `correctness` — so the
 * correctness assertions stay achievable (the model still passes when it
 * answers right, the budget only measures HOW it got there).
 *
 * Industry-agnostic by construction (CLAUDE.md): generic office tasks,
 * generic fixtures (`ventes.csv`, `contacts.csv`, `rapport.md` — see
 * `evals/fixtures/README.md`), no vertical vocabulary.
 *
 * Coverage gaps this suite closes vs the existing set: file MODIFICATION,
 * irrelevance / "don't call a tool" (BFCL IrrelAcc), and persona-framed
 * over-calling temptation on deterministic compute.
 */

import { checkGeneratedCsv } from "../file-content-check";
import type { EvalSuite } from "../types";

export const b2bEfficiencySuite: EvalSuite = {
  name: "b2b-efficiency",
  summary:
    "Realistic B2B office tasks with declared tool-call budgets (compute, file gen/modify, structured lookup, summary, irrelevance) — drives the efficiency scores.",
  cases: [
    {
      id: "b2b-cdg-csv-total",
      description:
        "Compute a column total from an attached CSV → one python call, not row-by-row browsing",
      prompt:
        "Tu assistes le contrôle de gestion. Le fichier ventes.csv est joint. Calcule le montant total de toutes les ventes (colonne « montant ») et donne-moi le résultat.",
      tags: ["b2b-efficiency", "compute"],
      fixtures: ["ventes.csv"],
      budget: { maxToolCalls: 2, expectedTools: ["python", "read"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python", "read"], mode: "any" },
        { type: "regex", value: "42[\\s.,\\u00a0]?000" },
      ],
    },
    {
      id: "b2b-cdg-csv-groupby",
      description:
        "Aggregate an attached CSV by a key → grouped totals, exact values",
      prompt:
        "À partir du fichier joint ventes.csv, donne-moi le total des ventes par produit (un total pour « Logiciel », un pour « Service »).",
      tags: ["b2b-efficiency", "compute"],
      fixtures: ["ventes.csv"],
      budget: { maxToolCalls: 2, expectedTools: ["python", "read"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python", "read"], mode: "any" },
        { type: "regex", value: "29[\\s.,\\u00a0]?500" },
        { type: "regex", value: "12[\\s.,\\u00a0]?500" },
      ],
    },
    {
      id: "b2b-compta-csv-deliverable",
      description:
        "Produce a recap file from attached data → file written + presentFiles card",
      prompt:
        "Tu es comptable. À partir du fichier joint ventes.csv, génère un fichier recap.csv donnant le total des ventes par région (colonnes : region, total), enregistre-le dans outputs/ et présente-le-moi.",
      tags: ["b2b-efficiency", "deliverable"],
      fixtures: ["ventes.csv"],
      budget: {
        maxToolCalls: 4,
        expectedTools: ["python", "bash", "read", "presentFiles"],
      },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python", "bash"], mode: "any" },
        { type: "toolUsed", tools: ["presentFiles"], mode: "any" },
        {
          type: "custom",
          name: "recap.csv carries the correct per-region totals (Nord 17000, Sud 15500, Est 9500)",
          fn: (result, ctx) =>
            checkGeneratedCsv(result, ctx, {
              filename: /recap.*\.csv$/i,
              requiredColumns: ["region", "total"],
              rows: [
                { region: "Nord", total: 17000 },
                { region: "Sud", total: 15500 },
                { region: "Est", total: 9500 },
              ],
            }),
        },
      ],
    },
    {
      id: "b2b-admin-csv-modify",
      description:
        "Modify an attached file (add a column) and present the updated version",
      prompt:
        "Tu es assistant administratif. Le fichier contacts.csv est joint. Ajoute une colonne « statut » dont la valeur est « actif » pour chaque contact, enregistre le résultat sous contacts_maj.csv dans outputs/ et présente-le-moi.",
      tags: ["b2b-efficiency", "file-modify"],
      fixtures: ["contacts.csv"],
      budget: {
        maxToolCalls: 4,
        expectedTools: ["python", "bash", "read", "presentFiles"],
      },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["python", "bash"], mode: "any" },
        { type: "toolUsed", tools: ["presentFiles"], mode: "any" },
        {
          type: "custom",
          name: "updated CSV preserves the 3 contacts and adds statut=actif to each",
          fn: (result, ctx) =>
            checkGeneratedCsv(result, ctx, {
              requiredColumns: ["nom", "email", "entreprise", "statut"],
              rowCount: 3,
              rows: [
                { nom: "Alice Martin", statut: "actif" },
                { nom: "Bob Durand", statut: "actif" },
                { nom: "Carla Petit", statut: "actif" },
              ],
            }),
        },
      ],
    },
    {
      id: "b2b-finance-doc-count",
      description:
        "Workspace count → one structured lookup, not row-by-row browsing",
      prompt:
        "Tu es au service financier. Combien de documents l'équipe possède-t-elle au total dans l'espace de travail ? Donne juste le nombre.",
      tags: ["b2b-efficiency", "structured-lookup"],
      budget: { maxToolCalls: 2, expectedTools: ["querySql", "listDocuments"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["querySql", "listDocuments"], mode: "any" },
      ],
    },
    {
      id: "b2b-commercial-doc-summary",
      description:
        "Summarise an attached report in 3 points → read once, no redundant re-reads",
      prompt:
        "Tu es commercial. Résume le rapport joint (rapport.md) en exactement 3 points clés, en français.",
      tags: ["b2b-efficiency", "summary"],
      fixtures: ["rapport.md"],
      budget: { maxToolCalls: 3, expectedTools: ["read", "python"] },
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["read", "python"], mode: "any" },
        {
          type: "judge",
          rubric:
            "The assistant returns a 3-point summary grounded in the attached quarterly operations review (its real themes: productivity gains, customer-satisfaction increase, controlled costs, or the large-account concentration risk). Any three reasonable points drawn from the report pass. A summary not based on the file's actual content, or one that invents unrelated facts, is a FAIL.",
        },
      ],
    },
    {
      id: "b2b-knowledge-no-tool",
      description:
        "General-knowledge question explicitly scoped to no lookup → answer directly, zero tools",
      prompt:
        "Explique en une phrase, de manière générale, ce qu'est un bon de commande. Réponds directement avec tes connaissances, sans consulter nos documents ni le web.",
      tags: ["b2b-efficiency", "irrelevance"],
      budget: { maxToolCalls: 0, expectedTools: [] },
      assertions: [
        { type: "noError" },
        {
          type: "toolNotUsed",
          tools: [
            "searchWeb",
            "searchKnowledge",
            "querySql",
            "listDocuments",
            "listEntities",
            "webFetch",
          ],
        },
        {
          type: "judge",
          rubric:
            "The assistant defines, in roughly one sentence and from its own knowledge, what a purchase order (« bon de commande ») is: a buyer's document that formally requests/commits to purchasing goods or services from a supplier. A correct general definition passes; calling a tool or refusing is a FAIL.",
        },
      ],
    },
    {
      id: "b2b-admin-email-draft",
      description: "Draft a short business email → pure generation, zero tools",
      prompt:
        "Rédige un court email professionnel (3 à 4 phrases) pour relancer poliment un client au sujet d'une facture en attente de paiement.",
      tags: ["b2b-efficiency", "generation"],
      budget: { maxToolCalls: 0, expectedTools: [] },
      assertions: [
        { type: "noError" },
        {
          type: "toolNotUsed",
          tools: ["searchWeb", "querySql", "python", "searchKnowledge"],
        },
        {
          type: "judge",
          rubric:
            "The assistant writes a short (about 3-4 sentences), polite, professional payment-reminder email in French. It should read as a usable draft (courteous tone, references an outstanding invoice, asks for payment or a status). A reasonable draft passes; an off-topic or non-email answer is a FAIL.",
        },
      ],
    },
  ],
};
