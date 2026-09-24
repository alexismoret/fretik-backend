import type { DecisionPointKey } from "@fretik/shared/decisions/keys";
import {
  chosenOf,
  probabilityOf,
  thresholdFor,
} from "@fretik/shared/decisions/policy";
import type {
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import type { WorkflowPlaybook } from "@fretik/shared/schemas/workflows";
import type { RecordAnchor } from "@fretik/shared/services/collection-records/anchor";
import {
  anchorQuestionId,
  buildAnchorQuestion,
  readAnchorVerdicts,
} from "@fretik/shared/services/collection-records/anchor-verify";
import {
  buildEntityQuestion,
  entityQuestionId,
  readEntityVerdict,
  type EntityCandidate,
} from "@fretik/shared/services/documents/pre-resolve-mentions";
import {
  buildKindQuestion,
  kindQuestionId,
  readKindVerdict,
} from "@fretik/shared/services/external-apps/mcp/suggest-kinds";
import { mcpToolsToDescriptor } from "@fretik/shared/services/external-apps/mcp/to-descriptor";
import {
  buildFilingQuestion,
  FILING_QUESTION_ID,
  readFilingVerdict,
  type FilingCandidate,
} from "@fretik/shared/services/folders/auto-file";
import {
  buildLinkTypeQuestion,
  linkTypeQuestionId,
  readLinkTypeVerdict,
  type LinkTypeCandidate,
} from "@fretik/shared/services/link-types/match-by-meaning";
import {
  CRITERION_LINT_QUESTIONS,
  NARROW_QUESTION,
  NARROW_QUESTION_ID,
  readCriterionLint,
  readNarrowGoal,
  type CriterionLintFlag,
} from "@fretik/shared/services/workflows/criterion-lint";
import {
  buildGateQuestion,
  gateQuestionId,
} from "@fretik/shared/services/workflows/gate-question";
import {
  PRESCREEN_QUESTIONS,
  readPrescreen,
} from "../../src/services/memory/consolidate-prescreen";
import { renderTranscript } from "../../src/services/memory/distill-conversation";
import {
  readWorth,
  WORTH_QUESTION,
} from "../../src/services/memory/distill-worth";
import {
  buildSupportQuestions,
  episodeTag,
  readSupport,
  type ProposedPromotion,
} from "../../src/services/memory/promote-support";
import type { RecallSearchHit } from "../../src/services/recall/candidates";
import {
  buildAnchorSelectQuestions,
  buildRelevanceQuestions,
  readAnchorSelection,
  readRelevance,
} from "../../src/services/recall/decision-select";
import {
  CONTINUATION_QUESTION,
  readContinuation,
} from "../../src/services/turn-continuation/decide";

/**
 * The decision points, asked for real.
 *
 * Every case builds its question with the builder production uses and reads
 * the answer with the reader production uses, so what passes here is what
 * the product does with the same answer. The only thing a case writes by
 * hand is the STATE, in the shape the caller sends it.
 *
 * `expect` lists the outcomes the product can live with. Where the safe
 * direction is to do nothing (leave a document at the root, hand a cluster
 * to the judge), a case that tests "never do the wrong thing" accepts the
 * safe outcome too — and still fails on the wrong one. A case that accepts
 * everything tests nothing, so none does.
 *
 * `no_answer` is never expected: a timeout or an outage is a transport
 * result, not a verdict, and the runner reports it as a failure.
 */

export interface DecisionCase {
  id: string;
  point: DecisionPointKey;
  /** One sentence: what the case pins, and why it matters to the product. */
  why: string;
  request: DecisionRequest;
  /** The product's outcome for this answer, read with production code. */
  read: (response: DecisionResponse | null) => string;
  expect: readonly string[];
}

const NO_ANSWER = "no_answer";

const answered = (response: DecisionResponse | null) =>
  response?.status === "answered" ? response : null;

// ==================== //
// workflow.gate        //
// ==================== //

const playbook = (goal: string): WorkflowPlaybook => ({
  goal,
  tasks: [{ key: "run", title: "Run", description: "", instructions: goal }],
});

const INVOICE_INTAKE = {
  id: "wf-invoices",
  name: "Supplier invoice intake",
  playbook: playbook(
    "Extract the amount, due date and supplier from each supplier invoice and add it to the Payables collection.",
  ),
  triggerCriterion: "The document is an invoice sent by a supplier.",
};

const CLIENT_ONBOARDING = {
  id: "wf-onboarding",
  name: "New client onboarding",
  playbook: playbook(
    "Create the client's folder and send the welcome checklist to the account owner.",
  ),
  triggerCriterion: "A new company record is created for a client.",
};

const EMAIL_TRIAGE = {
  id: "wf-triage",
  name: "Customer issue triage",
  playbook: playbook(
    "Summarise the customer's problem and post it to the support channel.",
  ),
  triggerCriterion:
    "An email from a customer reporting a problem with an order.",
};

/** Allowed or filtered, read the way the jobs gate reads it. */
const readGate =
  (workflowId: string) =>
  (response: DecisionResponse | null): string => {
    const reply = answered(response);
    const id = gateQuestionId(workflowId);
    const p = probabilityOf(reply?.answers[id]);
    const bar = reply ? thresholdFor(reply.policy, id) : undefined;
    if (p === null || bar === undefined) return NO_ANSWER;
    return p >= bar ? "allowed" : "filtered";
  };

const gateCase = (params: {
  id: string;
  why: string;
  workflow: typeof INVOICE_INTAKE;
  state: DecisionRequest["state"];
  expect: "allowed" | "filtered";
}): DecisionCase => ({
  id: params.id,
  point: "workflow.gate",
  why: params.why,
  request: {
    point: "workflow.gate",
    state: params.state,
    questions: {
      [gateQuestionId(params.workflow.id)]: buildGateQuestion(params.workflow),
    },
  },
  read: readGate(params.workflow.id),
  expect: [params.expect],
});

const GATE_CASES: DecisionCase[] = [
  gateCase({
    id: "gate-invoice-runs",
    why: "The event the workflow exists for must run.",
    workflow: INVOICE_INTAKE,
    state: {
      eventType: "document.uploaded",
      filename: "INV-2026-0417.pdf",
      extension: "pdf",
      documentSummary:
        "Invoice from Contoso Office Supplies for 24 ergonomic chairs, total 5,760 EUR excluding VAT, payable 30 days from the issue date.",
      mentionedOrganizations: ["Contoso Office Supplies"],
    },
    expect: "allowed",
  }),
  gateCase({
    id: "gate-french-invoice-runs",
    why: "A criterion written in English still matches a document written in French.",
    workflow: INVOICE_INTAKE,
    state: {
      eventType: "document.uploaded",
      filename: "facture_duval_sept.pdf",
      extension: "pdf",
      documentSummary:
        "Facture n° F-2026-118 émise par l'Imprimerie Duval pour l'impression de 500 brochures, montant 1 240 € TTC, échéance le 15 octobre 2026.",
      documentLanguage: "fr",
      mentionedOrganizations: ["Imprimerie Duval"],
    },
    expect: "allowed",
  }),
  gateCase({
    id: "gate-employment-contract-filtered",
    why: "A document plainly outside the criterion must not start a run.",
    workflow: INVOICE_INTAKE,
    state: {
      eventType: "document.uploaded",
      filename: "employment-contract-j-martin.pdf",
      extension: "pdf",
      documentSummary:
        "Permanent employment contract between the company and Julie Martin for a project manager position, starting 1 October 2026, with a three-month probation period.",
      mentionedOrganizations: [],
    },
    expect: "filtered",
  }),
  gateCase({
    id: "gate-meeting-notes-filtered",
    why: "Internal notes that mention an amount are still not an invoice.",
    workflow: INVOICE_INTAKE,
    state: {
      eventType: "document.uploaded",
      filename: "leadership-sync-2026-09-12.docx",
      extension: "docx",
      documentSummary:
        "Notes from the weekly leadership meeting: Q4 hiring plan, the office move to the fourth floor, and a reminder that the marketing budget is capped at 40,000 EUR.",
      mentionedOrganizations: [],
    },
    expect: "filtered",
  }),
  gateCase({
    id: "gate-new-client-runs",
    why: "A record event that matches the criterion must run.",
    workflow: CLIENT_ONBOARDING,
    state: {
      eventType: "record.created",
      collectionName: "Companies",
      label: "Globex Corporation",
      "fields.relationship": "client",
      "fields.country": "Germany",
      changedFields: [],
    },
    expect: "allowed",
  }),
  gateCase({
    id: "gate-record-update-filtered",
    why: "An edit to an existing record is not the creation the criterion asks for.",
    workflow: CLIENT_ONBOARDING,
    state: {
      eventType: "record.updated",
      collectionName: "Companies",
      label: "Globex Corporation",
      "fields.relationship": "client",
      changedFields: ["phone"],
    },
    expect: "filtered",
  }),
  // NOT a case, measured 2026-09-24: a new Companies record whose only
  // difference from the criterion is `fields.relationship: "supplier"` came
  // back at P = 0.60 against "a new company record is created for a client".
  // The gate refuses on a confident no alone, so a condition carried by one
  // field's VALUE is not refused by meaning — it belongs in the trigger's
  // deterministic `filter`, which is what the criterion guidance says.
  gateCase({
    id: "gate-new-person-filtered",
    why: "A new person is not a new company, whatever else it shares.",
    workflow: CLIENT_ONBOARDING,
    state: {
      eventType: "record.created",
      collectionName: "People",
      label: "Julie Martin",
      "fields.role": "Project manager",
      changedFields: [],
    },
    expect: "filtered",
  }),
  gateCase({
    id: "gate-revised-invoice-runs",
    why: "A revised invoice is still an invoice: the event type does not veto the match.",
    workflow: INVOICE_INTAKE,
    state: {
      eventType: "document.revised",
      filename: "INV-2026-0417-v2.pdf",
      extension: "pdf",
      documentSummary:
        "Corrected invoice from Contoso Office Supplies for 24 ergonomic chairs, total 5,520 EUR excluding VAT after a discount.",
      mentionedOrganizations: ["Contoso Office Supplies"],
    },
    expect: "allowed",
  }),
  gateCase({
    id: "gate-customer-complaint-runs",
    why: "A connector event that matches must run, read from its payload.",
    workflow: EMAIL_TRIAGE,
    state: {
      eventType: "connector.gmail.message_received",
      providerKey: "gmail",
      eventKind: "message_received",
      "payload.from": "anna.kowalski@client-example.com",
      "payload.subject": "Order 4471 arrived damaged",
      "payload.snippet":
        "Hello, the parcel for order 4471 arrived this morning with two broken units. Can you send replacements?",
    },
    expect: "allowed",
  }),
  gateCase({
    id: "gate-newsletter-filtered",
    why: "A newsletter is not a customer reporting a problem.",
    workflow: EMAIL_TRIAGE,
    state: {
      eventType: "connector.gmail.message_received",
      providerKey: "gmail",
      eventKind: "message_received",
      "payload.from": "newsletter@industry-digest.example",
      "payload.subject": "Your weekly industry digest",
      "payload.snippet":
        "This week: five trends shaping procurement, a webinar on supply planning, and our readers' favourite tools.",
    },
    expect: "filtered",
  }),
];

// ======================== //
// workflow.criterion.lint  //
// ======================== //

type LintOutcome = "accepted" | CriterionLintFlag;

const readLint = (response: DecisionResponse | null): string =>
  answered(response) === null
    ? NO_ANSWER
    : (readCriterionLint(response) ?? "accepted");

const lintCase = (params: {
  id: string;
  why: string;
  criterion: string;
  expect: readonly LintOutcome[];
}): DecisionCase => ({
  id: params.id,
  point: "workflow.criterion.lint",
  why: params.why,
  request: {
    point: "workflow.criterion.lint",
    state: { criterion: params.criterion },
    questions: CRITERION_LINT_QUESTIONS,
  },
  read: readLint,
  expect: params.expect,
});

/**
 * A refusal blocks someone writing a workflow, so the traps that matter most
 * are the sound criteria that LOOK like a flaw: a year, a duration, one
 * client's documents, "whatever its format" about a kind, a negation.
 */
const LINT_CASES: DecisionCase[] = [
  lintCase({
    id: "lint-kind-invoice",
    why: "The canonical criterion — a kind of input — goes through.",
    criterion: "The document is an invoice sent by a supplier.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-contract-fr",
    why: "A kind with its variants, in French, goes through.",
    criterion:
      "Le document est un contrat signé avec un client, ou un avenant à un tel contrat.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-spanish",
    why: "A kind in a language no pattern was ever written for goes through.",
    criterion: "El documento es una factura emitida por un proveedor.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-one-client",
    why: "Every document about one client is many inputs, not one item.",
    criterion:
      "Any document sent by Northwind Traders or about our work with them.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-year-named",
    why: "A year that names a kind of document is not a comparison.",
    criterion: "The document is a 2026 annual tax return.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-duration-in-content",
    why: "A duration the document contains is content, not arithmetic.",
    criterion: "The contract includes a 30-day notice period clause.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-whatever-format",
    why: '"Whatever its format" about a KIND still restricts to that kind.',
    criterion: "Any invoice, whatever its format: PDF, scan or photo.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-negation",
    why: "Everything but one kind is a restriction, not every input.",
    criterion: "Tout document qui n'est pas une facture.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-email",
    why: "A kind of email, described by what it is about, goes through.",
    criterion: "An email from a customer complaining about a late delivery.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-file-type",
    why: "A file TYPE is a kind of input: only spreadsheets is a sound filter.",
    criterion: "Le fichier est un tableur Excel.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-kind-extensions",
    why: "Formats named by their extensions are still a kind, not one file.",
    criterion: "The file is a .pdf or a .docx.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-one-filename-no-extension",
    why: "A file named without its extension is still one file.",
    criterion: "The file is IMG_4821.",
    expect: ["one"],
  }),
  lintCase({
    id: "lint-one-unlisted-extension",
    why: "An extension no list would have held is still one file.",
    criterion: "Le fichier est scan_0012.heic.",
    expect: ["one"],
  }),
  lintCase({
    id: "lint-one-described-item",
    why: "One contract described by who signed it and when is one item — or a date to compare; either refusal is right.",
    criterion: "The contract Julie Martin signed on 3 March 2026.",
    expect: ["one", "cmp"],
  }),
  lintCase({
    id: "lint-cmp-amount-in-words",
    why: "An amount written in words is still a comparison.",
    criterion: "La facture dépasse mille euros.",
    expect: ["cmp"],
  }),
  lintCase({
    id: "lint-cmp-spanish",
    why: "A comparison in Spanish is a comparison.",
    criterion: "Facturas de más de 500 euros.",
    expect: ["cmp"],
  }),
  lintCase({
    id: "lint-cmp-german",
    why: "A comparison in German is a comparison.",
    criterion: "Rechnungen über 1000 Euro.",
    expect: ["cmp"],
  }),
  lintCase({
    id: "lint-cmp-age",
    why: "An age is a date comparison.",
    criterion: "Documents older than a month.",
    expect: ["cmp"],
  }),
  lintCase({
    id: "lint-cmp-count",
    why: "A count is arithmetic.",
    criterion: "An email with more than three attachments.",
    expect: ["cmp"],
  }),
  lintCase({
    id: "lint-open-says-none",
    why: 'The sentence the builder wrote for "every document" (measured 2026-09-24).',
    criterion:
      "Aucun critère : chaque document ajouté au Drive déclenche un résumé.",
    expect: ["open"],
  }),
  lintCase({
    id: "lint-open-whatever-type",
    why: "The next sentence it wrote, which the regex did not list and which filtered a replaced photo.",
    criterion:
      "le déclencheur porte sur un fichier ajouté au Drive, quel que soit le dossier ou le type de fichier",
    expect: ["open"],
  }),
  lintCase({
    id: "lint-open-arrival-only",
    why: "How an input arrives is the trigger's job; said as a criterion, the gate reads it literally.",
    criterion: "Un nouveau fichier arrive dans le Drive.",
    expect: ["open"],
  }),
  lintCase({
    id: "lint-kind-sender-only",
    why: "Who sent it is about the input, and a sound restriction.",
    criterion: "Any email sent by one of our customers.",
    expect: ["accepted"],
  }),
  lintCase({
    id: "lint-open-english",
    why: "Every input, said plainly.",
    criterion: "Every document, whatever it is.",
    expect: ["open"],
  }),
  lintCase({
    id: "lint-open-german",
    why: "Every input, in a language no pattern was written for.",
    criterion: "Jedes Dokument, egal welcher Art.",
    expect: ["open"],
  }),
];

// =========================== //
// workflow.criterion.missing  //
// =========================== //

const missingCase = (params: {
  id: string;
  why: string;
  name: string;
  goal: string;
  trigger: string;
  expect: "hint" | "none";
}): DecisionCase => ({
  id: params.id,
  point: "workflow.criterion.missing",
  why: params.why,
  request: {
    point: "workflow.criterion.missing",
    state: {
      name: params.name,
      goal: params.goal,
      description: "",
      trigger: params.trigger,
    },
    questions: { [NARROW_QUESTION_ID]: NARROW_QUESTION },
  },
  read: (response) =>
    answered(response) === null
      ? NO_ANSWER
      : readNarrowGoal(response)
        ? "hint"
        : "none",
  expect: [params.expect],
});

/**
 * A wrong hint pushes a criterion onto a workflow meant for every input, so
 * the broad goals matter most — including the one whose TRIGGER already
 * narrows the inputs, where "each new company" is every input it gets.
 */
const MISSING_CASES: DecisionCase[] = [
  missingCase({
    id: "missing-invoices-only",
    why: "The goal the assistant left without a criterion on 2 turns in 10.",
    name: "Factures fournisseurs — extraction et note",
    goal: "À chaque document ajouté au Drive : si c'est une facture fournisseur, extraire le fournisseur, le montant TTC et la date d'échéance, puis écrire un résumé dans une note.",
    trigger: "document.uploaded, document.revised",
    expect: "hint",
  }),
  missingCase({
    id: "missing-complaints-only",
    why: "One kind of email among every email received.",
    name: "Complaint triage",
    goal: "Summarise each customer complaint and post it to the support channel.",
    trigger: "connector.gmail.email_received",
    expect: "hint",
  }),
  missingCase({
    id: "missing-signed-contracts-only",
    why: "One kind of document among every upload.",
    name: "Client onboarding",
    goal: "For every contract signed with a new client, create the client's folder and send the welcome checklist to the account owner.",
    trigger: "document.uploaded",
    expect: "hint",
  }),
  missingCase({
    id: "missing-every-document",
    why: "A goal for every document must get no hint.",
    name: "Résumé de chaque document",
    goal: "À chaque document ajouté au Drive, quel qu'il soit, écrire un résumé en trois lignes dans une note.",
    trigger: "document.uploaded, document.revised",
    expect: "none",
  }),
  missingCase({
    id: "missing-trigger-already-narrows",
    why: "The trigger delivers only companies, so each new company is every input.",
    name: "Company enrichment",
    goal: "Enrich each new company with its website and headcount.",
    trigger: "record.created (collectionKey = companies)",
    expect: "none",
  }),
  missingCase({
    id: "missing-every-lead",
    why: "Every record the trigger delivers, named by its collection.",
    name: "Lead assignment",
    goal: "Assign every new lead to a sales rep and notify them.",
    trigger: "record.created (collectionKey = leads)",
    expect: "none",
  }),
  missingCase({
    id: "missing-every-email",
    why: "Every email received, whatever it is.",
    name: "Email archive",
    goal: "Save every email received to the Drive as a PDF.",
    trigger: "connector.gmail.email_received",
    expect: "none",
  }),
];

// ==================== //
// drive.file           //
// ==================== //

const FOLDERS: FilingCandidate[] = [
  {
    id: "f-invoices",
    name: "Supplier invoices",
    fullPath: "/Finance/Supplier invoices",
    description: "Invoices received from suppliers, before and after payment.",
  },
  {
    id: "f-contracts",
    name: "Contracts",
    fullPath: "/Legal/Contracts",
    description: "Signed contracts with clients, suppliers and partners.",
  },
  {
    id: "f-hr",
    name: "Employees",
    fullPath: "/HR/Employees",
    description:
      "Employee files: employment contracts, payslips, reviews and leave requests.",
  },
  {
    id: "f-meetings",
    name: "Meeting notes",
    fullPath: "/Management/Meeting notes",
    description: "Minutes and notes from internal meetings.",
  },
  {
    id: "f-brand",
    name: "Brand assets",
    fullPath: "/Marketing/Brand assets",
    description: null,
  },
];

const readFiling = (response: DecisionResponse | null): string => {
  const verdict = readFilingVerdict(response, FOLDERS);
  if (verdict.file) return `file:${verdict.folderId}`;
  return ["unreachable", "skipped", "no_answer"].includes(verdict.reason)
    ? NO_ANSWER
    : "leave";
};

const fileCase = (params: {
  id: string;
  why: string;
  state: DecisionRequest["state"];
  expect: readonly string[];
}): DecisionCase => ({
  id: params.id,
  point: "drive.file",
  why: params.why,
  request: {
    point: "drive.file",
    state: params.state,
    questions: { [FILING_QUESTION_ID]: buildFilingQuestion(FOLDERS) },
  },
  read: readFiling,
  expect: params.expect,
});

const FILE_CASES: DecisionCase[] = [
  fileCase({
    id: "file-invoice",
    why: "A document its folder's description names is filed there.",
    state: {
      filename: "INV-2026-0417.pdf",
      extension: "pdf",
      documentSummary:
        "Invoice from Contoso Office Supplies for 24 ergonomic chairs, total 5,760 EUR excluding VAT, payable within 30 days.",
      mentionedOrganizations: ["Contoso Office Supplies"],
      documentLanguage: "en",
    },
    expect: ["file:f-invoices"],
  }),
  fileCase({
    id: "file-client-contract",
    why: "A signed client agreement goes to contracts.",
    state: {
      filename: "globex-it-support-agreement-signed.pdf",
      extension: "pdf",
      documentSummary:
        "IT support services agreement between our company and Globex Corporation, 24 months from 1 October 2026, signed by both parties.",
      mentionedOrganizations: ["Globex Corporation"],
      documentLanguage: "en",
    },
    expect: ["file:f-contracts"],
  }),
  fileCase({
    id: "file-payslip",
    why: "An employee document goes to the employee files.",
    state: {
      filename: "payslip-2026-09-jmartin.pdf",
      extension: "pdf",
      documentSummary:
        "Payslip for September 2026 for employee Julie Martin: gross salary, social contributions and a net pay of 3,120 EUR.",
      mentionedOrganizations: [],
      documentLanguage: "en",
    },
    expect: ["file:f-hr"],
  }),
  fileCase({
    id: "file-french-minutes",
    why: "A French document is matched against English descriptions.",
    state: {
      filename: "cr-codir-2026-09-12.docx",
      extension: "docx",
      documentSummary:
        "Compte rendu du comité de direction du 12 septembre 2026 : budget du quatrième trimestre, recrutements prévus et déménagement des bureaux.",
      mentionedOrganizations: [],
      documentLanguage: "fr",
    },
    expect: ["file:f-meetings"],
  }),
  fileCase({
    id: "file-employment-contract-not-legal",
    why: "Two folders both say 'contracts'; the one for employees is right, and the other is a misfile.",
    state: {
      filename: "employment-contract-j-martin.pdf",
      extension: "pdf",
      documentSummary:
        "Permanent employment contract between the company and Julie Martin for a project manager position, starting 1 October 2026.",
      mentionedOrganizations: [],
      documentLanguage: "en",
    },
    expect: ["file:f-hr", "leave"],
  }),
  fileCase({
    id: "file-logo-by-path",
    why: "A folder with no description is still judged by its path, and never misfiled into another.",
    state: {
      filename: "logo-horizontal-dark.svg",
      extension: "svg",
      documentSummary:
        "The company logo, horizontal version on a dark background, vector format.",
      mentionedOrganizations: [],
    },
    expect: ["file:f-brand", "leave"],
  }),
  fileCase({
    id: "file-client-invoice-not-supplier",
    why: "An invoice WE sent is not one received from a supplier; filing it there is a misfile.",
    state: {
      filename: "INV-OUT-2026-0233.pdf",
      extension: "pdf",
      documentSummary:
        "Invoice issued by our company to our client Globex Corporation for three months of IT support, total 9,000 EUR.",
      mentionedOrganizations: ["Globex Corporation"],
      documentLanguage: "en",
    },
    expect: ["leave"],
  }),
  fileCase({
    id: "file-supplier-quote-not-invoice",
    why: "A quote is not an invoice and not a signed contract; it stays at the root.",
    state: {
      filename: "quote-fabrikam-meeting-room.pdf",
      extension: "pdf",
      documentSummary:
        "Quote from Fabrikam for renovating the meeting room, estimated 18,400 EUR, valid for 60 days, not yet accepted.",
      mentionedOrganizations: ["Fabrikam"],
      documentLanguage: "en",
    },
    expect: ["leave"],
  }),
  fileCase({
    id: "file-personal-photo-stays",
    why: "A document no folder is for stays at the root.",
    state: {
      filename: "IMG_4821.jpg",
      extension: "jpg",
      documentSummary:
        "Photograph of a mountain lake at sunset, taken on a personal hiking trip.",
      mentionedOrganizations: [],
    },
    expect: ["leave"],
  }),
];

// ==================== //
// consolidate prescreen
// ==================== //

const episode = (
  index: number,
  params: {
    occurred: string;
    title: string;
    summary: string;
    records?: string;
  },
): string =>
  `<episode id="E${(index + 1).toString()}" kind="conversation" occurred="${params.occurred}"${params.records ? ` records="${params.records}"` : ""}>\n${params.title}\n${params.summary}\n</episode>`;

const readPrescreenCase = (response: DecisionResponse | null): string =>
  answered(response) === null
    ? NO_ANSWER
    : readPrescreen(response)
      ? "skip"
      : "judge";

const prescreenCase = (params: {
  id: string;
  why: string;
  episodes: string[];
  expect: "skip" | "judge";
}): DecisionCase => ({
  id: params.id,
  point: "memory.consolidate.prescreen",
  why: params.why,
  request: {
    point: "memory.consolidate.prescreen",
    state: {
      today: "2026-09-24",
      episodes: params.episodes,
      recentActivity: [],
    },
    questions: PRESCREEN_QUESTIONS,
  },
  read: readPrescreenCase,
  expect: [params.expect],
});

const PRESCREEN_CASES: DecisionCase[] = [
  prescreenCase({
    id: "prescreen-unrelated-skips",
    why: "Two unrelated stories are the cluster the judge never needed to see.",
    episodes: [
      episode(0, {
        occurred: "2026-09-18",
        title: "Q4 marketing budget approved",
        summary:
          "Finance approved the Q4 marketing budget at 40,000 EUR, split between events and online campaigns.",
      }),
      episode(1, {
        occurred: "2026-09-20",
        title: "Movers chosen for the office relocation",
        summary:
          "The team picked a moving company for the relocation to the fourth floor, scheduled for the first weekend of November.",
      }),
    ],
    expect: "skip",
  }),
  prescreenCase({
    id: "prescreen-duplicate-to-judge",
    why: "The same decision told twice must reach the judge, which merges it.",
    episodes: [
      episode(0, {
        occurred: "2026-09-15",
        title: "Stationery supplier switched to Fabrikam",
        summary:
          "Decided to move all stationery orders from Contoso to Fabrikam starting in October, because Fabrikam delivers twice a week.",
        records: "Fabrikam, Contoso",
      }),
      episode(1, {
        occurred: "2026-09-16",
        title: "Stationery orders now go to Fabrikam",
        summary:
          "Confirmed that from October stationery is ordered from Fabrikam instead of Contoso; the reason was the twice-weekly delivery.",
        records: "Fabrikam, Contoso",
      }),
    ],
    expect: "judge",
  }),
  prescreenCase({
    id: "prescreen-conflict-to-judge",
    why: "A later episode that replaces an earlier fact must reach the judge, which revises it.",
    episodes: [
      episode(0, {
        occurred: "2026-09-02",
        title: "Payment terms agreed with Globex",
        summary:
          "Globex Corporation and the finance team agreed on payment terms of 30 days from the invoice date.",
        records: "Globex Corporation",
      }),
      episode(1, {
        occurred: "2026-09-20",
        title: "Globex renegotiated its payment terms",
        summary:
          "After the renegotiation, Globex Corporation's invoices are now paid 45 days end of month.",
        records: "Globex Corporation",
      }),
    ],
    expect: "judge",
  }),
  prescreenCase({
    id: "prescreen-french-duplicate-to-judge",
    why: "The same story told in French twice is still the same story.",
    episodes: [
      episode(0, {
        occurred: "2026-09-10",
        title: "Choix du prestataire de ménage",
        summary:
          "L'équipe a retenu la société Nettoyage Plus pour l'entretien des bureaux à partir d'octobre, pour un forfait mensuel de 1 800 €.",
        records: "Nettoyage Plus",
      }),
      episode(1, {
        occurred: "2026-09-11",
        title: "Nettoyage Plus retenu pour l'entretien",
        summary:
          "Confirmation : Nettoyage Plus assurera l'entretien des bureaux dès octobre, au forfait de 1 800 € par mois.",
        records: "Nettoyage Plus",
      }),
    ],
    expect: "judge",
  }),
  prescreenCase({
    id: "prescreen-three-unrelated-skips",
    why: "A cluster of three unrelated stories skips too.",
    episodes: [
      episode(0, {
        occurred: "2026-09-19",
        title: "New laptop policy",
        summary:
          "Laptops are now renewed every four years instead of three, decided by the operations lead.",
      }),
      episode(1, {
        occurred: "2026-09-21",
        title: "Client workshop with Initech prepared",
        summary:
          "The agenda for the Initech workshop on 3 October was drafted, covering the roadmap and the support process.",
        records: "Initech",
      }),
      episode(2, {
        occurred: "2026-09-22",
        title: "Holiday calendar published",
        summary:
          "The holiday calendar for December was shared with the team; the office closes from 24 December to 1 January.",
      }),
    ],
    expect: "skip",
  }),
];

// ==================== //
// resolve verify       //
// ==================== //

const verifyCase = (params: {
  id: string;
  why: string;
  label: string;
  collection: string;
  matchedText: string;
  text: string;
  expect: readonly string[];
}): DecisionCase => {
  const recordId = "rec-1";
  return {
    id: params.id,
    point: "memory.resolve.verify",
    why: params.why,
    request: {
      point: "memory.resolve.verify",
      state: { eventType: "document.uploaded", text: params.text },
      questions: {
        [anchorQuestionId(recordId)]: buildAnchorQuestion(
          {
            recordId,
            collectionId: "col-1",
            label: params.label,
            confidence: 0.7,
            matchedText: params.matchedText,
            matchType: "trigram",
          },
          params.collection,
        ),
      },
    },
    read: (response) => {
      if (answered(response) === null) return NO_ANSWER;
      return (
        readAnchorVerdicts(response, [recordId]).get(recordId) ?? NO_ANSWER
      );
    },
    expect: params.expect,
  };
};

const VERIFY_CASES: DecisionCase[] = [
  verifyCase({
    id: "verify-confirms-the-client",
    why: "A clear reference to the record promotes the suggested link.",
    label: "Globex Corporation",
    collection: "Companies",
    matchedText: "Globex",
    text: "Call with Globex this morning: they want to extend the IT support contract by a year and add two sites.",
    expect: ["confirm"],
  }),
  verifyCase({
    id: "verify-drops-a-common-word",
    why: "A company name used as an ordinary word is not the company.",
    label: "Apex Consulting",
    collection: "Companies",
    matchedText: "apex",
    text: "Sales reached the apex of the season in July and declined through August, as every year.",
    expect: ["drop"],
  }),
  verifyCase({
    id: "verify-person-is-not-the-firm",
    why: "A person who shares a firm's name is not the firm; never confirm it.",
    label: "Martin & Co",
    collection: "Companies",
    matchedText: "Martin",
    text: "Julie Martin will present the hiring plan at Tuesday's team meeting.",
    expect: ["drop", "keep"],
  }),
  verifyCase({
    id: "verify-confirms-the-customer-order",
    why: "A company named as the actor of a business event is that company.",
    label: "Initech",
    collection: "Companies",
    matchedText: "Initech",
    text: "Initech sent the signed purchase order for the 40 additional licences this afternoon.",
    expect: ["confirm"],
  }),
  verifyCase({
    id: "verify-confirms-the-supplier-short-name",
    why: "A short name used for a known supplier is that supplier.",
    label: "Northwind Traders",
    collection: "Companies",
    matchedText: "Northwind",
    text: "Northwind delivered the printer paper late again, the third time this month.",
    expect: ["confirm"],
  }),
  verifyCase({
    id: "verify-drops-an-event-name",
    why: "A company name that is also an ordinary noun is not the company.",
    label: "Summit Partners",
    collection: "Companies",
    matchedText: "summit",
    text: "The summit with the regional managers is planned for March in Lyon.",
    expect: ["drop"],
  }),
  verifyCase({
    id: "verify-drops-a-colour",
    why: "A colour is not the consultancy that shares its name.",
    label: "Orange Consulting",
    collection: "Companies",
    matchedText: "orange",
    text: "The new brand colour is orange, replacing the old navy blue on every template.",
    expect: ["drop"],
  }),
  verifyCase({
    id: "verify-confirms-in-french",
    why: "A reference in French is confirmed like one in English.",
    label: "Imprimerie Duval",
    collection: "Companies",
    matchedText: "imprimerie Duval",
    text: "La facture de l'imprimerie Duval pour les brochures est arrivée, à régler avant le 15 octobre.",
    expect: ["confirm"],
  }),
];

// ==================== //
// link-type match      //
// ==================== //

const LINK_TYPES: LinkTypeCandidate[] = [
  { id: "t-works-for", label: "works for", inverseLabel: "employs" },
  { id: "t-supplies", label: "supplies", inverseLabel: "is supplied by" },
  { id: "t-owns", label: "owns", inverseLabel: "is owned by" },
];

const linkTypeCase = (params: {
  id: string;
  why: string;
  relation: string;
  from: string;
  to: string;
  expect: readonly string[];
}): DecisionCase => {
  const questionId = linkTypeQuestionId(params.relation);
  return {
    id: params.id,
    point: "graph.link-type-match",
    why: params.why,
    request: {
      point: "graph.link-type-match",
      state: { relation: params.relation, from: params.from, to: params.to },
      questions: {
        [questionId]: buildLinkTypeQuestion(params.relation, LINK_TYPES),
      },
    },
    read: (response) => {
      if (answered(response) === null) return NO_ANSWER;
      const verdict = readLinkTypeVerdict(response, questionId, LINK_TYPES);
      return verdict.reuseId === null ? "create" : `reuse:${verdict.reuseId}`;
    },
    expect: params.expect,
  };
};

const LINK_TYPE_CASES: DecisionCase[] = [
  linkTypeCase({
    id: "link-employed-by-is-works-for",
    why: "A synonym of an existing relation reuses it instead of splitting the graph.",
    relation: "employed_by",
    from: "People",
    to: "Companies",
    expect: ["reuse:t-works-for"],
  }),
  linkTypeCase({
    id: "link-provides-goods-is-supplies",
    why: "A paraphrase of an existing relation reuses it.",
    relation: "provides_goods_to",
    from: "Companies",
    to: "Companies",
    expect: ["reuse:t-supplies"],
  }),
  linkTypeCase({
    id: "link-vendor-of-is-supplies",
    why: "A one-word synonym reuses the existing relation.",
    relation: "vendor_of",
    from: "Companies",
    to: "Companies",
    expect: ["reuse:t-supplies"],
  }),
  linkTypeCase({
    id: "link-sells-to-is-supplies",
    why: "Selling to someone is supplying them, in the same direction.",
    relation: "sells_to",
    from: "Companies",
    to: "Companies",
    expect: ["reuse:t-supplies"],
  }),
  linkTypeCase({
    id: "link-customer-of-is-not-supplies",
    why: "A customer of X is supplied BY X: the inverse direction, never a reuse of `supplies`.",
    relation: "customer_of",
    from: "Companies",
    to: "Companies",
    expect: ["create"],
  }),
  linkTypeCase({
    id: "link-subsidiary-of-is-not-owns",
    why: "A subsidiary is owned BY its parent: the inverse of `owns`, never a reuse of it.",
    relation: "subsidiary_of",
    from: "Companies",
    to: "Companies",
    expect: ["create"],
  }),
  linkTypeCase({
    id: "link-manages-is-new",
    why: "Managing someone is not working for them.",
    relation: "manages",
    from: "People",
    to: "People",
    expect: ["create"],
  }),
  linkTypeCase({
    id: "link-invested-in-is-new",
    why: "A relation none of the types means is created, never forced onto one.",
    relation: "invested_in",
    from: "Companies",
    to: "Companies",
    expect: ["create"],
  }),
  linkTypeCase({
    id: "link-competes-with-is-new",
    why: "A relation that is close to none of the existing ones is created.",
    relation: "competes_with",
    from: "Companies",
    to: "Companies",
    expect: ["create"],
  }),
];

// ==================== //
// distill worth        //
// ==================== //

const transcript = (lines: [string, string][]): string =>
  renderTranscript(
    lines.map(([role, text]) => ({
      role: role === "user" ? "user" : "assistant",
      text,
    })),
  );

const worthCase = (params: {
  id: string;
  why: string;
  lines: [string, string][];
  expect: "skip" | "distill";
}): DecisionCase => ({
  id: params.id,
  point: "memory.distill.worth",
  why: params.why,
  request: {
    point: "memory.distill.worth",
    state: { transcript: transcript(params.lines) },
    questions: { worth: WORTH_QUESTION },
  },
  read: (response) => {
    const reply = answered(response);
    if (reply === null || reply.answers["worth"] === undefined) {
      return NO_ANSWER;
    }
    return readWorth(response) ? "skip" : "distill";
  },
  expect: [params.expect],
});

const WORTH_CASES: DecisionCase[] = [
  worthCase({
    id: "worth-small-talk-skips",
    why: "A greeting that ran to four messages is not worth an episode.",
    lines: [
      ["user", "hi"],
      ["assistant", "Hello! How can I help you today?"],
      ["user", "nothing, just checking this works"],
      ["assistant", "It works. Let me know whenever you need something."],
    ],
    expect: "skip",
  }),
  worthCase({
    id: "worth-french-small-talk-skips",
    why: "Small talk in French is small talk.",
    lines: [
      ["user", "Bonjour !"],
      ["assistant", "Bonjour ! Que puis-je faire pour vous ?"],
      ["user", "Rien pour l'instant, merci"],
      ["assistant", "Avec plaisir, à tout à l'heure."],
    ],
    expect: "skip",
  }),
  worthCase({
    id: "worth-decision-distills",
    why: "A decision made in the conversation must be remembered.",
    lines: [
      ["user", "Compare the two quotes for the office cleaning contract."],
      [
        "assistant",
        "Nettoyage Plus quotes 1,800 EUR a month with daily cleaning; Brightclean quotes 1,650 EUR with cleaning three times a week.",
      ],
      ["user", "Go with Nettoyage Plus, daily cleaning matters more to us."],
      [
        "assistant",
        "Noted: Nettoyage Plus is the chosen provider from October, 1,800 EUR a month.",
      ],
    ],
    expect: "distill",
  }),
  worthCase({
    id: "worth-preference-distills",
    why: "A short standing preference is exactly what memory is for.",
    lines: [
      ["user", "From now on send me the weekly report as a PDF, not Excel."],
      ["assistant", "Understood, weekly reports will come as PDF from now on."],
      ["user", "thanks"],
      ["assistant", "You're welcome."],
    ],
    expect: "distill",
  }),
  worthCase({
    id: "worth-result-distills",
    why: "A result produced for the team is worth remembering.",
    lines: [
      ["user", "Which supplier invoices are overdue?"],
      [
        "assistant",
        "Two are overdue: Contoso, 5,760 EUR due on 12 September, and Fabrikam, 2,300 EUR due on 15 September.",
      ],
      ["user", "Put them in a list for the finance meeting."],
      [
        "assistant",
        "Done: the list of the two overdue invoices is saved as 'Overdue invoices - September' in the Finance folder.",
      ],
    ],
    expect: "distill",
  }),
  worthCase({
    id: "worth-open-question-distills",
    why: "A question left open for later is worth remembering.",
    lines: [
      [
        "user",
        "Did Globex ever confirm the second site for the support contract?",
      ],
      [
        "assistant",
        "I found no confirmation: the last email from Globex, on 18 September, says they would answer after their board meeting.",
      ],
      ["user", "OK, we need to chase them next week then."],
      ["assistant", "Understood, the second site is still waiting on Globex."],
    ],
    expect: "distill",
  }),
];

// ==================== //
// promote support      //
// ==================== //

const APPROVAL_RULE: ProposedPromotion = {
  action: "ADD",
  path: "learned/invoice-approval.md",
  content:
    "Supplier invoices above 5,000 EUR need the finance director's approval before they are paid.",
};

const supportCase = (params: {
  id: string;
  why: string;
  promotion: ProposedPromotion;
  episodes: string[];
  expect: string;
}): DecisionCase => {
  const promotions = [params.promotion];
  return {
    id: params.id,
    point: "memory.promote.support",
    why: params.why,
    request: {
      point: "memory.promote.support",
      state: {
        episodes: params.episodes.map(
          (text, j) => `<episode id="${episodeTag(j)}">\n${text}\n</episode>`,
        ),
      },
      questions: buildSupportQuestions(promotions, params.episodes.length),
    },
    read: (response) => {
      const verdict = readSupport(response, promotions, params.episodes.length);
      const count = verdict.support[0];
      if (count === null || count === undefined) return NO_ANSWER;
      return `support=${count.toString()} ${verdict.allowed[0] ? "write" : "refuse"}`;
    },
    expect: [params.expect],
  };
};

const SUPPORT_CASES: DecisionCase[] = [
  supportCase({
    id: "support-stated-and-applied",
    why: "A rule stated once and applied once has its two supports; the unrelated episode is not one.",
    promotion: APPROVAL_RULE,
    episodes: [
      "Finance rule reminder\nThe finance director reminded the team that any supplier invoice above 5,000 EUR must be approved by her before payment.",
      "Contoso invoice held\nThe Contoso invoice of 5,760 EUR was held until the finance director approved it, then paid on Friday.",
      "Office move\nThe movers were booked for the first weekend of November.",
    ],
    expect: "support=2 write",
  }),
  supportCase({
    id: "support-said-once-refused",
    why: "A new rule heard in a single conversation is refused: two episodes are the bar.",
    promotion: APPROVAL_RULE,
    episodes: [
      "Finance rule reminder\nThe finance director said any supplier invoice above 5,000 EUR must be approved by her before payment.",
      "Holiday calendar\nThe office closes from 24 December to 1 January.",
      "Workshop agenda\nThe Initech workshop agenda covers the roadmap and the support process.",
    ],
    expect: "support=1 refuse",
  }),
  supportCase({
    id: "support-correction-needs-one",
    why: "A correction of a known fact needs one supporting episode.",
    promotion: {
      action: "UPDATE",
      path: "learned/globex-payment-terms.md",
      content: "Globex Corporation's invoices are paid 45 days end of month.",
    },
    episodes: [
      "Globex renegotiation\nAfter the renegotiation, Globex Corporation's invoices are now paid 45 days end of month instead of 30 days.",
      "Laptop policy\nLaptops are renewed every four years.",
    ],
    expect: "support=1 write",
  }),
  supportCase({
    id: "support-paraphrased",
    why: "A fact told in other words, twice, is supported twice.",
    promotion: {
      action: "ADD",
      path: "learned/weekly-report-format.md",
      content: "The weekly report is sent as a PDF, not as a spreadsheet.",
    },
    episodes: [
      "Report format request\nThe user asked to receive the weekly report as a PDF from now on instead of the Excel file.",
      "Weekly report sent\nThe weekly report went out on Monday as a PDF attachment, as requested.",
    ],
    expect: "support=2 write",
  }),
  supportCase({
    id: "support-contradicted-refused",
    why: "Episodes that say something else support nothing.",
    promotion: {
      action: "ADD",
      path: "learned/payment-terms.md",
      content: "All supplier invoices are paid within 30 days.",
    },
    episodes: [
      "Globex renegotiation\nGlobex Corporation's invoices are now paid 45 days end of month.",
      "Contoso payment\nThe Contoso invoice was paid 60 days after its issue date, as agreed.",
    ],
    expect: "support=0 refuse",
  }),
];

// ==================== //
// entity match         //
// ==================== //

const entityCase = (params: {
  id: string;
  why: string;
  mention: string;
  candidates: EntityCandidate[];
  filename: string;
  summary: string;
  expect: readonly string[];
}): DecisionCase => {
  const questionId = entityQuestionId(0);
  return {
    id: params.id,
    point: "graph.entity-match",
    why: params.why,
    request: {
      point: "graph.entity-match",
      state: { filename: params.filename, documentSummary: params.summary },
      questions: {
        [questionId]: buildEntityQuestion(params.mention, params.candidates),
      },
    },
    read: (response) => {
      if (answered(response) === null) return NO_ANSWER;
      const verdict = readEntityVerdict(
        response,
        questionId,
        params.candidates,
      );
      return verdict.linkId === null ? "left" : `link:${verdict.linkId}`;
    },
    expect: params.expect,
  };
};

const ENTITY_CASES: DecisionCase[] = [
  entityCase({
    id: "entity-short-name-links",
    why: "A short form of an existing company's name links to it, not to its look-alike.",
    mention: "Northwind",
    candidates: [
      { id: "r-northwind", label: "Northwind Traders" },
      { id: "r-northwest", label: "Northwest Supplies" },
    ],
    filename: "delivery-note-0921.pdf",
    summary:
      "Delivery note from Northwind Traders for 40 boxes of printer paper, delivered on 21 September.",
    expect: ["link:r-northwind"],
  }),
  entityCase({
    id: "entity-different-firm-is-new",
    why: "A different firm that shares a word with a record is never linked to it.",
    mention: "Acme Labs",
    candidates: [{ id: "r-acme", label: "Acme Logistics" }],
    filename: "fire-test-report.pdf",
    summary:
      "Test report from Acme Labs, an independent laboratory, on the fire resistance of the new partition walls.",
    expect: ["left"],
  }),
  entityCase({
    id: "entity-french-links",
    why: "A mention in French links to the record it names.",
    mention: "Duval",
    candidates: [
      { id: "r-duval", label: "Imprimerie Duval" },
      { id: "r-dupont", label: "Dupont Transports" },
    ],
    filename: "facture_duval_sept.pdf",
    summary:
      "Facture de l'Imprimerie Duval pour l'impression de 500 brochures, 1 240 € TTC.",
    expect: ["link:r-duval"],
  }),
  entityCase({
    id: "entity-cannot-tell-stays",
    why: "When the document cannot tell two candidates apart, neither is linked.",
    mention: "Duval",
    candidates: [
      { id: "r-duval-print", label: "Imprimerie Duval" },
      { id: "r-duval-consult", label: "Duval Consulting" },
    ],
    filename: "email-duval.pdf",
    summary: "Short email from Duval confirming Thursday's meeting at 10 am.",
    expect: ["left"],
  }),
  entityCase({
    id: "entity-person-is-not-the-firm",
    why: "A person who shares a firm's name is not linked to the firm.",
    mention: "Martin",
    candidates: [{ id: "r-martin", label: "Martin & Co" }],
    filename: "leave-request-jmartin.pdf",
    summary:
      "Leave request from employee Julie Martin for the week of 12 October, approved by her manager.",
    expect: ["left"],
  }),
];

// ==================== //
// turn continuation    //
// ==================== //

const continuationCase = (params: {
  id: string;
  why: string;
  message: string;
  expect: "continue" | "stop";
}): DecisionCase => ({
  id: params.id,
  point: "chat.turn.continuation",
  why: params.why,
  request: {
    point: "chat.turn.continuation",
    state: { message: params.message },
    questions: { announce: CONTINUATION_QUESTION },
  },
  read: (response) => {
    const verdict = readContinuation(response);
    return verdict === null ? NO_ANSWER : verdict ? "continue" : "stop";
  },
  expect: [params.expect],
});

const CONTINUATION_CASES: DecisionCase[] = [
  continuationCase({
    id: "continue-let-me-check",
    why: "An announced lookup with no result is a dead turn to resume.",
    message: "Let me check the supplier records.",
    expect: "continue",
  }),
  continuationCase({
    id: "continue-will-generate",
    why: "An announced deliverable with nothing delivered is a dead turn.",
    message: "I'll now generate the Excel file with the totals per supplier.",
    expect: "continue",
  }),
  continuationCase({
    id: "continue-french-announce",
    why: "An announcement in French is still an announcement.",
    message: "Je vais maintenant vérifier les factures en attente de paiement.",
    expect: "continue",
  }),
  continuationCase({
    id: "continue-first-step",
    why: "Announcing the first step of a plan, with no step taken, is a dead turn.",
    message: "First, I'll look up the renewal dates of the three contracts.",
    expect: "continue",
  }),
  continuationCase({
    id: "stop-let-me-know",
    why: '"Let me know" is an offer to the person, not an announced action.',
    message: "Let me know if you want the PDF version as well.",
    expect: "stop",
  }),
  continuationCase({
    id: "stop-nothing-found",
    why: "A negative result is a result.",
    message:
      "I checked the supplier records: none of them has an overdue invoice.",
    expect: "stop",
  }),
  continuationCase({
    id: "stop-answer",
    why: "A delivered answer ends the turn.",
    message: "The total of the three open invoices is 12,480 EUR.",
    expect: "stop",
  }),
  continuationCase({
    id: "stop-question-to-user",
    why: "A question for the person ends the turn; resuming would answer for them.",
    message: "Would you like me to send this summary to the whole team?",
    expect: "stop",
  }),
  continuationCase({
    id: "stop-done",
    why: "A confirmation of finished work ends the turn.",
    message: "Done: the report is saved in the Reports folder.",
    expect: "stop",
  }),
  continuationCase({
    id: "stop-list-delivered",
    why: "A delivered list ends the turn, even when it is short.",
    message:
      "Three contracts expire this quarter: Globex (31 October), Initech (15 November) and Umbrella (1 December).",
    expect: "stop",
  }),
];

// ==================== //
// recall select        //
// ==================== //

const hit = (
  sourceType: string,
  sourceId: string,
  content: string,
): RecallSearchHit => ({
  sourceType,
  sourceId,
  content,
  metadata: null,
  rerankScore: 0.4,
});

const recallCase = (params: {
  id: string;
  why: string;
  message: string;
  hits: RecallSearchHit[];
  expect: string;
}): DecisionCase => ({
  id: params.id,
  point: "chat.recall-select",
  why: params.why,
  request: {
    point: "chat.recall-select",
    state: { message: params.message, recent: null },
    questions: buildRelevanceQuestions(params.hits),
  },
  read: (response) => {
    const kept = readRelevance(response, params.hits.length);
    if (kept === null) return NO_ANSWER;
    return `kept=[${kept.flatMap((k, i) => (k ? [i.toString()] : [])).join(",")}]`;
  },
  expect: [params.expect],
});

/** A record the message's words matched, asked about the way recall asks. */
const anchorRecallCase = (params: {
  id: string;
  why: string;
  message: string;
  anchor: Pick<RecordAnchor, "label" | "matchedText" | "matchType">;
  expect: "kept" | "dropped";
}): DecisionCase => ({
  id: params.id,
  point: "chat.recall-select",
  why: params.why,
  request: {
    point: "chat.recall-select",
    state: { message: params.message, recent: null },
    questions: buildAnchorSelectQuestions([
      { recordId: "r1", collectionId: "c1", confidence: 0.8, ...params.anchor },
    ]),
  },
  read: (response) => {
    const kept = readAnchorSelection(response, 1);
    if (kept === null) return NO_ANSWER;
    return kept[0] === true ? "kept" : "dropped";
  },
  expect: [params.expect],
});

const RECALL_CASES: DecisionCase[] = [
  anchorRecallCase({
    id: "recall-anchor-lexical-noise",
    why: "Two common words matched in a supplier's notes are not the supplier.",
    message: "Et pour la caution ?",
    anchor: {
      label: "Vega Logistics",
      matchedText: "Et pour",
      matchType: "fts",
    },
    expect: "dropped",
  }),
  anchorRecallCase({
    id: "recall-anchor-ordinary-word",
    why: "A project named like a common word is not what the word means here.",
    message:
      "Quel horizon de placement recommandes-tu pour la trésorerie excédentaire ?",
    anchor: { label: "Horizon", matchedText: "horizon", matchType: "fts" },
    expect: "dropped",
  }),
  recallCase({
    id: "recall-keeps-the-answer",
    why: "The one candidate that answers the message is kept, the others are not.",
    message: "When do we pay Globex invoices?",
    hits: [
      hit(
        "memories",
        "team/globex-payment-terms.md",
        "Globex Corporation payment terms: 45 days end of month, renegotiated in September 2026.",
      ),
      hit(
        "episodes",
        "ep-office-move",
        "Office move: the team relocates to the fourth floor on the first weekend of November.",
      ),
      hit(
        "documents",
        "doc-lease",
        "Lease agreement for the new office space, signed with the building owner for nine years.",
      ),
    ],
    expect: "kept=[0]",
  }),
  recallCase({
    id: "recall-abstains",
    why: "When nothing bears on the message, nothing is kept: that abstention is the judge's job.",
    message:
      "Can you draft a thank-you note to the team for the product launch?",
    hits: [
      hit(
        "memories",
        "team/globex-payment-terms.md",
        "Globex Corporation payment terms: 45 days end of month.",
      ),
      hit(
        "episodes",
        "ep-stationery",
        "Stationery orders moved from Contoso to Fabrikam starting in October.",
      ),
    ],
    expect: "kept=[]",
  }),
  recallCase({
    id: "recall-keeps-both-halves",
    why: "A message with two questions keeps the candidate for each.",
    message:
      "What did we decide about stationery, and who delivers our printer paper?",
    hits: [
      hit(
        "episodes",
        "ep-stationery",
        "Decided to move stationery orders from Contoso to Fabrikam starting in October.",
      ),
      hit(
        "records",
        "rec-northwind",
        "Northwind Traders — supplier of printer paper, delivers every Monday.",
      ),
      hit(
        "memories",
        "team/globex-payment-terms.md",
        "Globex Corporation payment terms: 45 days end of month.",
      ),
    ],
    expect: "kept=[0,1]",
  }),
  recallCase({
    id: "recall-same-client-other-topic",
    why: "A candidate about the right client but the wrong subject does not answer the message.",
    message: "Has Globex paid the September invoice?",
    hits: [
      hit(
        "episodes",
        "ep-globex-payment",
        "Globex Corporation paid the September invoice of 9,000 EUR on 28 September.",
      ),
      hit(
        "episodes",
        "ep-globex-workshop",
        "Workshop with Globex Corporation on 3 October to present the support roadmap.",
      ),
    ],
    expect: "kept=[0]",
  }),
  recallCase({
    id: "recall-french-question",
    why: "A French question keeps the English memory that answers it.",
    message: "Quelles sont les conditions de paiement de Globex ?",
    hits: [
      hit(
        "memories",
        "team/globex-payment-terms.md",
        "Globex Corporation payment terms: 45 days end of month.",
      ),
      hit(
        "memories",
        "team/holiday-calendar.md",
        "The office closes from 24 December to 1 January.",
      ),
    ],
    expect: "kept=[0]",
  }),
];

// ==================== //
// MCP suggest kind     //
// ==================== //

const readKind = (response: DecisionResponse | null): string => {
  const reply = answered(response);
  if (reply === null || reply.answers[kindQuestionId(0)] === undefined) {
    return NO_ANSWER;
  }
  const verdict = readKindVerdict(reply, 0);
  return verdict.outcome === "suggested"
    ? `suggested:${verdict.kind}`
    : "unsure";
};

const kindCase = (params: {
  id: string;
  why: string;
  tool: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  };
  expect: readonly string[];
}): DecisionCase => {
  const [action] = mcpToolsToDescriptor({
    key: "acme-billing",
    displayName: "Acme Billing",
    categories: ["productivity"],
    tools: [
      {
        ...params.tool,
        inputSchema: { type: "object", ...params.tool.inputSchema },
      },
    ],
  }).actions;
  if (action === undefined) throw new Error(`${params.id}: no action built`);
  const question: DecisionQuestion = buildKindQuestion(action);
  return {
    id: params.id,
    point: "external-apps.mcp.suggest-kind",
    why: params.why,
    request: {
      point: "external-apps.mcp.suggest-kind",
      state: {
        server: "Acme Billing",
        serverDescription: "Invoicing and customer accounts.",
      },
      questions: { [kindQuestionId(0)]: question },
    },
    read: readKind,
    expect: params.expect,
  };
};

const KIND_CASES: DecisionCase[] = [
  kindCase({
    id: "kind-list-reads",
    why: "A listing tool is suggested as read-only.",
    tool: {
      name: "list_invoices",
      description: "List invoices with their status and amount.",
      inputSchema: {
        properties: {
          status: { type: "string", enum: ["open", "paid", "overdue"] },
        },
      },
    },
    expect: ["suggested:read"],
  }),
  kindCase({
    id: "kind-lookup-reads",
    why: "A lookup by id is suggested as read-only.",
    tool: {
      name: "get_customer",
      description: "Get one customer's details by id.",
      inputSchema: { properties: { id: { type: "string" } } },
    },
    expect: ["suggested:read"],
  }),
  kindCase({
    id: "kind-create-writes",
    why: "A create tool is never suggested as read-only.",
    tool: {
      name: "create_invoice",
      description: "Create a new invoice for a customer.",
      inputSchema: {
        properties: {
          customerId: { type: "string" },
          amount: { type: "number" },
        },
      },
    },
    expect: ["suggested:write", "unsure"],
  }),
  kindCase({
    id: "kind-send-writes",
    why: "Sending an email acts on the world; never read-only.",
    tool: {
      name: "send_invoice_email",
      description: "Email an invoice to the customer.",
      inputSchema: { properties: { invoiceId: { type: "string" } } },
    },
    expect: ["suggested:write", "unsure"],
  }),
  kindCase({
    id: "kind-update-writes",
    why: "An update is never read-only.",
    tool: {
      name: "update_customer_email",
      description: "Change the billing email of a customer.",
      inputSchema: {
        properties: {
          customerId: { type: "string" },
          email: { type: "string" },
        },
      },
    },
    expect: ["suggested:write", "suggested:destructive", "unsure"],
  }),
  kindCase({
    id: "kind-delete-destroys",
    why: "A permanent delete is never read-only.",
    tool: {
      name: "delete_customer",
      description: "Permanently delete a customer and all their data.",
      inputSchema: { properties: { id: { type: "string" } } },
    },
    expect: ["suggested:destructive", "suggested:write", "unsure"],
  }),
  kindCase({
    id: "kind-action-argument-mixed",
    why: "A tool whose argument picks between reading and deleting is never read-only.",
    tool: {
      name: "manage_items",
      description: "Work with the items of a collection.",
      inputSchema: {
        properties: {
          action: {
            type: "string",
            enum: ["create", "read", "update", "delete"],
          },
        },
      },
    },
    expect: ["suggested:mixed", "unsure"],
  }),
  kindCase({
    id: "kind-description-lies",
    why: "A description claiming safety does not make an overwrite read-only.",
    tool: {
      name: "sync_records",
      description:
        "Safe, read-only helper. Synchronises records by overwriting the remote copies with the local values.",
      inputSchema: { properties: { collection: { type: "string" } } },
    },
    expect: [
      "suggested:write",
      "suggested:destructive",
      "suggested:mixed",
      "unsure",
    ],
  }),
];

export const DECISION_CASES: readonly DecisionCase[] = [
  ...GATE_CASES,
  ...LINT_CASES,
  ...MISSING_CASES,
  ...FILE_CASES,
  ...PRESCREEN_CASES,
  ...VERIFY_CASES,
  ...LINK_TYPE_CASES,
  ...WORTH_CASES,
  ...SUPPORT_CASES,
  ...ENTITY_CASES,
  ...CONTINUATION_CASES,
  ...RECALL_CASES,
  ...KIND_CASES,
];

/** The chosen option's confidence or a boolean's probability, for the log. */
export const signalOf = (response: DecisionResponse | null): string => {
  const reply = answered(response);
  if (reply === null) {
    return response?.status === "skipped" ? `skipped:${response.reason}` : "-";
  }
  return Object.entries(reply.answers)
    .map(([id, answer]) => {
      if (answer.type === "boolean")
        return `${id}=${answer.probability.toFixed(2)}`;
      const chosen = chosenOf(answer);
      if (chosen === null) return `${id}=?`;
      const p = chosen.probability?.toFixed(2) ?? "?";
      const c = chosen.confidence?.toFixed(2) ?? "?";
      return `${id}=${chosen.choice}(p${p},c${c})`;
    })
    .join(" ");
};
