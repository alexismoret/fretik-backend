/**
 * "The description is the policy" — the sentences the assistant writes that
 * the decision model later judges against.
 *
 * A folder's description decides where the Drive files a document that
 * arrived with nowhere to go; a workflow's trigger criterion decides which
 * firings run. Both are written by the assistant through its tools, so both
 * are prose it must get right: a description that names one file, or a
 * criterion that compares an amount, silently decides wrong on every later
 * input. These cases grade the ROW the turn left behind, then what its
 * sentence DOES — the real filing and gate decisions replayed on documents
 * that belong and documents that do not — and clean up what they created.
 *
 * Coupled to: `manageDrive` (`createFolder`, `describeFolder`), `listFolders`,
 * `manageWorkflow` (`triggerCriterion`), the `<tool_routing>` row for a
 * folder's purpose, and `evals:decisions`, which grades the model that reads
 * these sentences.
 *
 * Run it with `--concurrency 1`. The folder cases work on FIXED names the
 * prompt states, so two repeats in flight seed, describe and delete each
 * other's folder.
 */

import db from "@fretik/shared/db";
import {
  aiMemories,
  aiVectors,
  folders,
  workflowRuns,
  workflows,
} from "@fretik/shared/db/schema";
import { probabilityOf, thresholdFor } from "@fretik/shared/decisions/policy";
import type { DecisionRequest } from "@fretik/shared/schemas/decisions";
import {
  buildFilingQuestion,
  FILING_QUESTION_ID,
  readFilingVerdict,
  type FilingCandidate,
} from "@fretik/shared/services/folders/auto-file";
import { lintCriterion } from "@fretik/shared/services/workflows/criterion-lint";
import {
  buildGateQuestion,
  gateQuestionId,
} from "@fretik/shared/services/workflows/gate-question";
import { deleteWorkflowVectorRows } from "@fretik/shared/services/workflows/vector-refresh";
import { and, eq, ilike, inArray, notExists } from "drizzle-orm";
import { decidePoint } from "../../src/services/decisions/decide-point";
import { inProcessEvaluator } from "../../src/services/decisions/in-process";
import type {
  EvalCase,
  EvalCaseContext,
  EvalSuite,
  InvokeResult,
} from "../types";

const DESCRIBED_FOLDER = "Accords signés";
const CREATED_FOLDER = "Notes de frais";

const folderByName = async (ctx: EvalCaseContext, name: string) =>
  db.query.folders.findFirst({
    where: { teamId: ctx.teamId, name },
    columns: {
      id: true,
      name: true,
      fullPath: true,
      description: true,
      descriptionSource: true,
    },
  });

/** Folders a document could go to instead, each with its own purpose. */
const OTHER_FOLDERS: FilingCandidate[] = [
  {
    id: "other-invoices",
    name: "Factures fournisseurs",
    fullPath: "/Factures fournisseurs",
    description: "Les factures reçues de nos fournisseurs.",
  },
  {
    id: "other-hr",
    name: "RH",
    fullPath: "/RH",
    description:
      "Contrats de travail, fiches de paie et documents du personnel.",
  },
];

/**
 * Where the Drive would file each document, given the folder as the turn
 * described it: the real `drive.file` decision, read the way auto-filing
 * reads it. A description is judged by what it DOES — a pattern over its
 * words would pass a sentence that files nothing and fail a sound one it did
 * not foresee.
 */
const filingMismatches = async (
  folder: FilingCandidate,
  documents: { state: DecisionRequest["state"]; belongs: boolean }[],
  ctx: EvalCaseContext,
): Promise<string[]> => {
  const candidates = [folder, ...OTHER_FOLDERS];
  const mismatches = await Promise.all(
    documents.map(async ({ state, belongs }) => {
      const response = await decidePoint(
        {
          point: "drive.file",
          state,
          questions: { [FILING_QUESTION_ID]: buildFilingQuestion(candidates) },
        },
        { teamId: ctx.teamId, organizationId: ctx.organizationId },
      );
      const verdict = readFilingVerdict(response, candidates);
      const filedHere = verdict.file && verdict.folderId === folder.id;
      if (filedHere === belongs) return null;
      return belongs
        ? `${String(state["filename"])} was not filed in it (${verdict.file ? verdict.folderId : verdict.reason})`
        : `${String(state["filename"])} was filed in it`;
    }),
  );
  return mismatches.filter((m): m is string => m !== null);
};

/** The folder's description, written by the assistant and filing right. */
const describedFolderFiles = async (
  ctx: EvalCaseContext,
  name: string,
  documents: { state: DecisionRequest["state"]; belongs: boolean }[],
): Promise<true | string> => {
  const folder = await folderByName(ctx, name);
  if (!folder) return "the folder is missing after the turn";
  const text = folder.description?.trim() ?? "";
  if (text.length === 0) return "no description was written";
  if (folder.descriptionSource !== "agent") {
    return `description source is ${String(folder.descriptionSource)}, not agent`;
  }
  const mismatches = await filingMismatches(
    { ...folder, description: text },
    documents,
    ctx,
  );
  return mismatches.length === 0
    ? true
    : `with "${text}": ${mismatches.join("; ")}`;
};

/**
 * The folder, and any team memory that mentions it. A turn that answered
 * "noted" by saving a memory instead left it for the next repeat to find —
 * which then replied "already recorded, nothing to change" and wrote no
 * description at all. Measured on this suite's second run. The memory tool
 * does not stamp its conversation, so the folder's name is the handle.
 */
const dropFolders = async (ctx: EvalCaseContext, name: string) => {
  await db
    .delete(folders)
    .where(and(eq(folders.teamId, ctx.teamId), eq(folders.name, name)));
  await db
    .delete(aiMemories)
    .where(
      and(
        eq(aiMemories.teamId, ctx.teamId),
        ilike(aiMemories.content, `%${name}%`),
      ),
    );
};

/**
 * The workflows THIS turn wrote, read off its own `manageWorkflow` outputs.
 *
 * Not "created since the case started": cases and their repeats run
 * concurrently against one team, and a time window then reads — and cleans
 * up — the workflow another turn is still writing. Measured on the first run
 * of this suite: the no-criterion case graded the invoice case's criterion.
 */
const workflowIdsOf = (result: InvokeResult): string[] => [
  ...new Set(
    result.toolCalls.flatMap((call) => {
      if (call.name !== "manageWorkflow") return [];
      const workflow: unknown =
        typeof call.output === "object" && call.output !== null
          ? Reflect.get(call.output, "workflow")
          : undefined;
      const id: unknown =
        typeof workflow === "object" && workflow !== null
          ? Reflect.get(workflow, "id")
          : undefined;
      return typeof id === "string" ? [id] : [];
    }),
  ),
];

/** Per conversation, what cleanup must remove; filled by the assertion. */
const createdByTurn = new Map<string, string[]>();

const eventWorkflowsOf = async (result: InvokeResult, ctx: EvalCaseContext) => {
  const ids = workflowIdsOf(result);
  createdByTurn.set(ctx.conversationId, ids);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      playbook: workflows.playbook,
      triggerType: workflows.triggerType,
      triggerCriterion: workflows.triggerCriterion,
    })
    .from(workflows)
    .where(and(eq(workflows.teamId, ctx.teamId), inArray(workflows.id, ids)));
  return rows.filter((w) => w.triggerType === "event");
};

/**
 * The rows AND their capability cards. A card outliving its workflow is still
 * recalled: the next repeat opened on `manageWorkflow get` for a workflow that
 * no longer existed, and wrote its draft without a criterion. Measured on this
 * suite, 3 of 10 repeats.
 */
const dropTurnWorkflows = async (ctx: EvalCaseContext): Promise<void> => {
  const ids = createdByTurn.get(ctx.conversationId) ?? [];
  createdByTurn.delete(ctx.conversationId);
  if (ids.length === 0) return;
  await db.delete(workflowRuns).where(inArray(workflowRuns.workflowId, ids));
  await db.delete(workflows).where(inArray(workflows.id, ids));
  for (const id of ids) await deleteWorkflowVectorRows(id);
};

/**
 * Every card whose workflow is gone, swept before a case starts. A turn's
 * card is written fire-and-forget after `create_draft`, so it can land AFTER
 * the cleanup above deleted the workflow — measured, 2 of 20 cards on one
 * run. Swept here, a late card never reaches the next turn's recall.
 */
const sweepOrphanWorkflowCards = async (
  ctx: EvalCaseContext,
): Promise<void> => {
  await db
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.teamId, ctx.teamId),
        eq(aiVectors.sourceType, "workflows"),
        notExists(
          db
            .select({ id: workflows.id })
            .from(workflows)
            .where(eq(workflows.id, aiVectors.sourceId)),
        ),
      ),
    );
};

const folderDescribed: EvalCase = {
  id: "desc-folder-purpose-described",
  description:
    "The user says what an existing folder is for → the assistant writes it as the folder's description, naming the KIND of document",
  prompt: `Le dossier « ${DESCRIBED_FOLDER} » sert à ranger les contrats signés avec nos clients et leurs avenants.`,
  tags: ["descriptions", "drive"],
  seed: async (ctx) => {
    await dropFolders(ctx, DESCRIBED_FOLDER);
    await db.insert(folders).values({
      teamId: ctx.teamId,
      name: DESCRIBED_FOLDER,
      fullPath: `/${DESCRIBED_FOLDER}`,
    });
  },
  cleanup: (ctx) => dropFolders(ctx, DESCRIBED_FOLDER),
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageDrive"] },
    {
      type: "custom",
      name: "description-files-client-contracts-here",
      fn: (_result, ctx) =>
        describedFolderFiles(ctx, DESCRIBED_FOLDER, [
          {
            belongs: true,
            state: {
              filename: "avenant-2-northwind.pdf",
              extension: "pdf",
              documentLanguage: "fr",
              documentSummary:
                "Avenant n°2 au contrat de prestation signé entre notre société et son client Northwind Traders, prolongeant la mission de six mois.",
              mentionedOrganizations: ["Northwind Traders"],
            },
          },
          {
            belongs: false,
            state: {
              filename: "facture-contoso-0417.pdf",
              extension: "pdf",
              documentLanguage: "fr",
              documentSummary:
                "Facture de Contoso Fournitures pour 24 chaises de bureau, 5 760 € HT, payable à 30 jours.",
              mentionedOrganizations: ["Contoso Fournitures"],
            },
          },
        ]),
    },
    {
      type: "judge",
      rubric:
        "Read the assistant's tool calls. PASS if it saved a description on the folder that says, in one short sentence, what KIND of document belongs there — signed client contracts and their amendments — and briefly confirms it to the user. FAIL if no description was saved, if it describes one specific document instead of a kind, or if it asks the user to do it themselves.",
    },
  ],
};

const folderCreatedWithPurpose: EvalCase = {
  id: "desc-folder-created-with-purpose",
  description:
    "Creating a folder whose purpose the user states → the description is set at creation, not left for later",
  prompt: `Crée un dossier « ${CREATED_FOLDER} » à la racine du Drive, pour ranger les justificatifs de dépenses des salariés : tickets de caisse, notes de restaurant, billets de train.`,
  tags: ["descriptions", "drive"],
  seed: (ctx) => dropFolders(ctx, CREATED_FOLDER),
  cleanup: (ctx) => dropFolders(ctx, CREATED_FOLDER),
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageDrive"] },
    {
      type: "custom",
      name: "created-with-a-description-that-files-expenses",
      fn: (_result, ctx) =>
        describedFolderFiles(ctx, CREATED_FOLDER, [
          {
            belongs: true,
            state: {
              filename: "ticket-restaurant-12-09.jpg",
              extension: "jpg",
              documentLanguage: "fr",
              documentSummary:
                "Note de restaurant d'un déjeuner client réglé par une salariée, 84,50 € TTC, à se faire rembourser.",
            },
          },
          {
            belongs: false,
            state: {
              filename: "facture-contoso-0417.pdf",
              extension: "pdf",
              documentLanguage: "fr",
              documentSummary:
                "Facture de Contoso Fournitures pour 24 chaises de bureau, 5 760 € HT, payable à 30 jours.",
              mentionedOrganizations: ["Contoso Fournitures"],
            },
          },
        ]),
    },
  ],
};

const workflowWithCriterion: EvalCase = {
  id: "desc-workflow-criterion",
  description:
    "An event workflow meant for one kind of input carries a trigger criterion that names that kind, passes the criterion lint, and lets through that kind alone",
  prompt:
    "Crée directement, sans me poser de question et sans lancer de test, un workflow qui se déclenche à chaque document ajouté au Drive : quand c'est une facture fournisseur, il en extrait le fournisseur, le montant TTC et la date d'échéance, et me les résume dans une note.",
  tags: ["descriptions", "workflows"],
  seed: sweepOrphanWorkflowCards,
  cleanup: dropTurnWorkflows,
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageWorkflow"] },
    {
      type: "custom",
      name: "event-workflow-with-a-valid-criterion",
      fn: async (result, ctx) => {
        const event = await eventWorkflowsOf(result, ctx);
        if (event.length === 0)
          return "no event-triggered workflow was created";
        const workflow = event[0];
        const criterion = workflow?.triggerCriterion?.trim() ?? "";
        if (workflow === undefined || criterion.length === 0)
          return "the workflow has no trigger criterion";
        const lint = await lintCriterion({
          criterion,
          context: { teamId: ctx.teamId, organizationId: ctx.organizationId },
          evaluator: inProcessEvaluator,
        });
        if (lint !== null)
          return `criterion fails the lint (${lint}): ${criterion}`;
        // Graded on what it does: the invoice runs, the rest is filtered.
        const outcomes = await gateOutcomes(workflow, ctx);
        const wrong = [...outcomes]
          .filter(([filename, outcome]) =>
            filename === INVOICE_FILENAME
              ? outcome !== "allowed"
              : outcome !== "filtered",
          )
          .map(([filename, outcome]) => `${filename} → ${outcome}`);
        return wrong.length === 0
          ? true
          : `the criterion "${criterion}" gates wrong: ${wrong.join(", ")}`;
      },
    },
    {
      type: "judge",
      rubric:
        "Read the manageWorkflow call. PASS if the workflow is triggered by documents added to the Drive AND its trigger criterion describes the KIND of input that should run it — a supplier invoice — in a short positive sentence, with no filename, no amount and no date in it. FAIL if there is no criterion, if the criterion restates the playbook's steps instead of what the input is, or if it names a specific file, supplier or amount.",
    },
  ],
};

/**
 * Documents of every kind: a workflow meant for all of them must refuse none.
 */
const INVOICE_FILENAME = "INV-2026-0417.pdf";

const EVERY_KIND: DecisionRequest["state"][] = [
  {
    eventType: "document.uploaded",
    filename: INVOICE_FILENAME,
    documentSummary:
      "Invoice from Contoso Office Supplies for 24 ergonomic chairs, total 5,760 EUR excluding VAT.",
  },
  {
    eventType: "document.uploaded",
    filename: "employment-contract-j-martin.pdf",
    documentSummary:
      "Permanent employment contract between the company and Julie Martin for a project manager position.",
  },
  {
    eventType: "document.revised",
    filename: "IMG_4821.jpg",
    documentSummary:
      "Photograph of a mountain lake at sunset, taken on a personal hiking trip.",
  },
];

type GateOutcome = "allowed" | "filtered" | "no_answer";

/**
 * What the gate would do with this workflow's criterion on each kind of
 * document, by filename. Asked of the real engine, read the way the jobs gate
 * reads it.
 */
const gateOutcomes = async (
  workflow: Parameters<typeof buildGateQuestion>[0] & { id: string },
  ctx: EvalCaseContext,
): Promise<Map<string, GateOutcome>> => {
  const id = gateQuestionId(workflow.id);
  const outcomes = await Promise.all(
    EVERY_KIND.map(async (state): Promise<[string, GateOutcome]> => {
      const response = await decidePoint(
        {
          point: "workflow.gate",
          state,
          questions: { [id]: buildGateQuestion(workflow) },
        },
        { teamId: ctx.teamId, organizationId: ctx.organizationId },
      );
      const filename = String(state["filename"]);
      if (response.status !== "answered") return [filename, "no_answer"];
      const p = probabilityOf(response.answers[id]);
      const bar = thresholdFor(response.policy, id);
      if (p === null || bar === undefined) return [filename, "no_answer"];
      return [filename, p >= bar ? "allowed" : "filtered"];
    }),
  );
  return new Map(outcomes);
};

const workflowWithoutCriterion: EvalCase = {
  id: "desc-workflow-no-criterion",
  description:
    "An event workflow meant for EVERY firing filters none of them out: no criterion, or one the gate lets every kind of document through (graded on the gate's real verdicts, since that is the only harm a criterion here can do)",
  prompt:
    "Crée directement, sans me poser de question et sans lancer de test, un workflow qui, à chaque document ajouté au Drive, quel qu'il soit, m'en écrit un résumé en trois lignes dans une note.",
  tags: ["descriptions", "workflows"],
  seed: sweepOrphanWorkflowCards,
  cleanup: dropTurnWorkflows,
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageWorkflow"] },
    {
      type: "custom",
      name: "event-workflow-filters-nothing",
      fn: async (result, ctx) => {
        const event = await eventWorkflowsOf(result, ctx);
        const workflow = event[0];
        if (workflow === undefined) {
          return "no event-triggered workflow was created";
        }
        const criterion = workflow.triggerCriterion?.trim() ?? "";
        if (criterion.length === 0) return true;
        const outcomes = await gateOutcomes(workflow, ctx);
        const filtered = [...outcomes]
          .filter(([, outcome]) => outcome === "filtered")
          .map(([filename]) => filename);
        return filtered.length === 0
          ? true
          : `the criterion "${criterion}" would filter out: ${filtered.join(", ")}`;
      },
    },
  ],
};

export const descriptionsSuite: EvalSuite = {
  name: "descriptions",
  summary:
    "Folder descriptions and trigger criteria the assistant writes — the sentences the decision model judges against",
  cases: [
    folderDescribed,
    folderCreatedWithPurpose,
    workflowWithCriterion,
    workflowWithoutCriterion,
  ],
};
