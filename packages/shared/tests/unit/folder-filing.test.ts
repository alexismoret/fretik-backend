import { describe, expect, test } from "bun:test";
import {
  buildFilingQuestion,
  ROOT_OPTION,
  type FilingCandidate,
} from "../../src/services/folders/auto-file";

/**
 * How the Drive filer asks where a document belongs.
 *
 * The asymmetry these tests protect is the INVERSE of the trigger gate's: a
 * misfiled document is worse than an unfiled one, because the person does not
 * know it exists and has nowhere to look. So every rule here is about making
 * "leave it alone" reachable and attractive.
 */

const candidate = (over: Partial<FilingCandidate>): FilingCandidate => ({
  id: "f1",
  name: "Invoices",
  fullPath: "/Accounting/Invoices",
  description: null,
  ...over,
});

describe("buildFilingQuestion", () => {
  test("doing nothing is always an option", () => {
    // A `choice` question always returns one of its options, so without this
    // the model is FORCED to name a folder for a document that belongs in
    // none — and being forced to choose is how everything ends up somewhere
    // wrong.
    const question = buildFilingQuestion([candidate({})]);
    expect(question.type).toBe("choice");
    expect(
      question.type === "choice" ? Object.keys(question.criteria) : [],
    ).toContain(ROOT_OPTION);
  });

  test("the root option tells the model to take it when unsure", () => {
    const question = buildFilingQuestion([candidate({})]);
    const text =
      question.type === "choice" ? (question.criteria[ROOT_OPTION] ?? "") : "";
    expect(text).toContain("guess");
  });

  test("a folder with no description is still offered, by its path", () => {
    // Withholding candidates until the nightly pass has written them a
    // sentence would make the feature useless on a fresh workspace — and
    // `/Accounting/Invoices 2026` says plenty on its own.
    const question = buildFilingQuestion([
      candidate({ id: "f1", fullPath: "/Accounting/Invoices 2026" }),
    ]);
    expect(question.type === "choice" ? question.criteria["f1"] : null).toBe(
      "/Accounting/Invoices 2026",
    );
  });

  test("a described folder offers its path AND its description", () => {
    const question = buildFilingQuestion([
      candidate({
        id: "f1",
        description: "Supplier invoices awaiting payment.",
      }),
    ]);
    const text =
      question.type === "choice" ? (question.criteria["f1"] ?? "") : "";
    expect(text).toContain("/Accounting/Invoices");
    expect(text).toContain("Supplier invoices awaiting payment.");
  });

  test("an over-long description is clipped", () => {
    // Sixty candidates ride one decision inside a 32k window, so a
    // description that runs long does not just read badly — it crowds out the
    // candidates it competes against.
    const question = buildFilingQuestion([
      candidate({ id: "f1", description: "x".repeat(5_000) }),
    ]);
    const text =
      question.type === "choice" ? (question.criteria["f1"] ?? "") : "";
    expect(text.length).toBeLessThan(500);
  });

  test("candidates are keyed by id, so an answer resolves to a real folder", () => {
    // Keying by name would make two folders called "Invoices" the same
    // option, and the answer unresolvable.
    const question = buildFilingQuestion([
      candidate({ id: "f1", name: "Invoices", fullPath: "/A/Invoices" }),
      candidate({ id: "f2", name: "Invoices", fullPath: "/B/Invoices" }),
    ]);
    const keys =
      question.type === "choice" ? Object.keys(question.criteria) : [];
    expect(keys).toContain("f1");
    expect(keys).toContain("f2");
  });
});
