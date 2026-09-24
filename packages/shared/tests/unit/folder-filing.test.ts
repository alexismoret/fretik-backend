import { describe, expect, test } from "bun:test";
import type {
  DecisionAnswer,
  DecisionAnswered,
  DecisionResponse,
} from "../../src/schemas/decisions";
import {
  buildFilingQuestion,
  FILING_QUESTION_ID,
  filingJournalEntry,
  readFilingVerdict,
  ROOT_OPTION,
  type FilingCandidate,
} from "../../src/services/folders/auto-file";
import { gateLabelForRunStatus } from "../../src/services/workflows/label-gate-outcome";

/**
 * How the Drive filer asks where a document belongs, and when it acts.
 *
 * The asymmetry these tests protect is the INVERSE of the trigger gate's: a
 * misfiled document is worse than an unfiled one, because the person does not
 * know it exists and has nowhere to look. So every rule here is about making
 * "leave it alone" reachable and attractive, and filing the exception.
 */

const candidate = (over: Partial<FilingCandidate>): FilingCandidate => ({
  id: "f1",
  name: "Invoices",
  fullPath: "/Accounting/Invoices",
  description: null,
  ...over,
});

const criteriaOf = (candidates: FilingCandidate[]): Record<string, string> => {
  const question = buildFilingQuestion(candidates);
  return question.type === "choice" ? question.criteria : {};
};

describe("buildFilingQuestion", () => {
  test("doing nothing is always an option", () => {
    // A `choice` question always returns one of its options, so without this
    // the model is FORCED to name a folder for a document that belongs in
    // none, and being forced to choose is how everything ends up somewhere
    // wrong.
    expect(buildFilingQuestion([candidate({})]).type).toBe("choice");
    expect(Object.keys(criteriaOf([candidate({})]))).toContain(ROOT_OPTION);
  });

  test("the root option also covers a folder that is only roughly right", () => {
    // Neutral wording, no "when in doubt": the caution lives in the
    // confidence bar, where it can be calibrated. But "not clearly right"
    // must be on the root's side, or a near-miss has nowhere to go but a
    // folder.
    expect(criteriaOf([candidate({})])[ROOT_OPTION]).toContain("clearly right");
  });

  test("a folder with no description is still offered, by its path", () => {
    // Withholding candidates until the nightly pass has written them a
    // sentence would make the feature useless on a fresh workspace, and
    // `/Accounting/Invoices 2026` says plenty on its own.
    expect(
      criteriaOf([
        candidate({ id: "f1", fullPath: "/Accounting/Invoices 2026" }),
      ])["f1"],
    ).toBe("/Accounting/Invoices 2026");
  });

  test("a described folder offers its path AND its description", () => {
    const text =
      criteriaOf([
        candidate({
          id: "f1",
          description: "Supplier invoices awaiting payment.",
        }),
      ])["f1"] ?? "";
    expect(text).toContain("/Accounting/Invoices");
    expect(text).toContain("Supplier invoices awaiting payment.");
  });

  test("an over-long description is clipped", () => {
    // Sixty candidates ride one decision inside a 32k window, so a
    // description that runs long does not just read badly, it crowds out the
    // candidates it competes against.
    const text =
      criteriaOf([candidate({ id: "f1", description: "x".repeat(5_000) })])[
        "f1"
      ] ?? "";
    expect(text.length).toBeLessThan(500);
  });

  test("candidates are keyed by id, so an answer resolves to a real folder", () => {
    // Keying by name would make two folders called "Invoices" the same
    // option, and the answer unresolvable.
    const keys = Object.keys(
      criteriaOf([
        candidate({ id: "f1", name: "Invoices", fullPath: "/A/Invoices" }),
        candidate({ id: "f2", name: "Invoices", fullPath: "/B/Invoices" }),
      ]),
    );
    expect(keys).toContain("f1");
    expect(keys).toContain("f2");
  });
});

const answered = (
  answer: DecisionAnswer | null,
  over: Partial<DecisionAnswered> = {},
): DecisionResponse => ({
  status: "answered",
  point: "drive.file",
  policy: {
    questionVersion: 2,
    thresholds: { folder: 0.75 },
    minChosenProbability: { folder: 0.5 },
  },
  answers: answer ? { [FILING_QUESTION_ID]: answer } : {},
  missing: [],
  transport: "openrouter",
  latencyMs: 150,
  ...over,
});

const choice = (
  choiceKey: string,
  probability: number | null,
  confidence: number | null,
): DecisionAnswer => ({
  type: "choice",
  choice: choiceKey,
  ...(probability !== null
    ? { probabilities: { [choiceKey]: probability } }
    : {}),
  ...(confidence !== null ? { confidence } : {}),
});

const folders = [candidate({ id: "f1" }), candidate({ id: "f2" })];

describe("readFilingVerdict", () => {
  test("a confident, clear winner is filed", () => {
    expect(
      readFilingVerdict(answered(choice("f1", 0.8, 0.9)), folders),
    ).toEqual({
      file: true,
      folderId: "f1",
      confidence: 0.9,
      probability: 0.8,
    });
  });

  test("exactly at both bars, it files", () => {
    expect(
      readFilingVerdict(answered(choice("f1", 0.5, 0.75)), folders).file,
    ).toBe(true);
  });

  test("a confidence under the bar leaves the document where it is", () => {
    const verdict = readFilingVerdict(
      answered(choice("f1", 0.9, 0.74)),
      folders,
    );
    expect(verdict).toMatchObject({ file: false, reason: "below_threshold" });
  });

  test("a confident spread between near-twins does not file", () => {
    // High confidence over a 45/40 split still picks a twin at random.
    const verdict = readFilingVerdict(
      answered(choice("f1", 0.45, 0.9)),
      folders,
    );
    expect(verdict).toMatchObject({ file: false, reason: "below_threshold" });
  });

  test("a missing confidence is not evidence, so it does not file", () => {
    // The gateway reports none. Not reported is not low, but this is the
    // decision that needs evidence.
    const verdict = readFilingVerdict(
      answered(choice("f1", 0.9, null)),
      folders,
    );
    expect(verdict).toMatchObject({
      file: false,
      reason: "no_confidence",
      folderId: "f1",
    });
  });

  test("choosing the root is a decision to leave it, with its scores kept", () => {
    const verdict = readFilingVerdict(
      answered(choice(ROOT_OPTION, 0.7, 0.9)),
      folders,
    );
    expect(verdict).toEqual({
      file: false,
      reason: "root",
      confidence: 0.9,
      probability: 0.7,
    });
  });

  test("an option that is not a candidate is never acted on", () => {
    const verdict = readFilingVerdict(
      answered(choice("f9", 0.9, 0.95)),
      folders,
    );
    expect(verdict).toMatchObject({ file: false, reason: "unknown_option" });
  });

  test("the bars are the ones the service echoed", () => {
    const verdict = readFilingVerdict(
      answered(choice("f1", 0.8, 0.8), {
        policy: {
          questionVersion: 2,
          thresholds: { folder: 0.85 },
          minChosenProbability: { folder: 0.5 },
        },
      }),
      folders,
    );
    expect(verdict).toMatchObject({ file: false, reason: "below_threshold" });
  });

  test("an unreachable, skipped or silent engine files nothing", () => {
    expect(readFilingVerdict(null, folders)).toEqual({
      file: false,
      reason: "unreachable",
    });
    expect(
      readFilingVerdict(
        { status: "skipped", point: "drive.file", reason: "rate_limited" },
        folders,
      ),
    ).toEqual({ file: false, reason: "skipped" });
    expect(readFilingVerdict(answered(null), folders)).toEqual({
      file: false,
      reason: "no_answer",
    });
  });

  test("an answer of the wrong type files nothing", () => {
    expect(
      readFilingVerdict(
        answered({ type: "boolean", probability: 0.99 }),
        folders,
      ),
    ).toEqual({ file: false, reason: "no_answer" });
  });
});

describe("filingJournalEntry", () => {
  const entry = (response: DecisionResponse | null, moved: boolean) =>
    filingJournalEntry({
      documentId: "d1",
      teamId: "team-1",
      organizationId: "org-1",
      response,
      candidates: folders,
      verdict: readFilingVerdict(response, folders),
      moved,
    });

  test("a filing that moved the document is `filed`, aimed at its folder", () => {
    expect(entry(answered(choice("f1", 0.8, 0.9)), true)).toMatchObject({
      point: "drive.file",
      subjectType: "document",
      subjectId: "d1",
      targetId: "f1",
      choice: "f1",
      outcome: "filed",
      applied: true,
      confidence: 0.9,
      probability: 0.8,
      threshold: 0.75,
    });
  });

  test("a document LEFT at the root still records the folder it would have gone to", () => {
    // That runner-up is what a later manual move is compared against: the
    // only evidence on whether the bar is set too high.
    expect(entry(answered(choice("f2", 0.9, 0.6)), false)).toMatchObject({
      outcome: "left",
      applied: true,
      reason: "below_threshold",
      targetId: "f2",
      confidence: 0.6,
    });
  });

  test("choosing the root aims at nothing", () => {
    expect(entry(answered(choice(ROOT_OPTION, 0.7, 0.9)), false)).toMatchObject(
      { outcome: "left", targetId: null, choice: ROOT_OPTION, reason: "root" },
    );
  });

  test("a filing that lost the race to a person is not applied", () => {
    expect(entry(answered(choice("f1", 0.8, 0.9)), false)).toMatchObject({
      outcome: "left",
      applied: false,
      reason: "moved_meanwhile",
    });
  });

  test("a fall-open carries the engine's own reason, not a generic one", () => {
    expect(
      entry(
        answered(null, { missing: [{ id: "folder", reason: "timeout" }] }),
        false,
      ),
    ).toMatchObject({
      outcome: "fell_open",
      applied: false,
      reason: "timeout",
    });
    expect(
      entry(
        { status: "skipped", point: "drive.file", reason: "rate_limited" },
        false,
      ),
    ).toMatchObject({ outcome: "fell_open", reason: "rate_limited" });
    expect(entry(null, false)).toMatchObject({
      outcome: "fell_open",
      reason: "unreachable",
      questionVersion: 2,
    });
  });

  test("a considered leave-it is applied: it decided where the document stays", () => {
    expect(entry(answered(choice("f2", 0.9, 0.6)), false)).toMatchObject({
      outcome: "left",
      applied: true,
      reason: "below_threshold",
    });
  });
});

describe("gateLabelForRunStatus", () => {
  test("only the two endings that read the input answer the gate's question", () => {
    expect(gateLabelForRunStatus("succeeded")).toBe("true");
    expect(gateLabelForRunStatus("not_applicable")).toBe("false");
    for (const status of [
      "failed",
      "canceled",
      "filtered",
      "running",
    ] as const) {
      expect(gateLabelForRunStatus(status)).toBeNull();
    }
  });
});
