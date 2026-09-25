import { describe, expect, test } from "bun:test";
import { workflowCriterionError } from "../../src/schemas/workflows";

/**
 * The FORM of a trigger criterion — what can be checked exactly and for free.
 * What a criterion means (one item, a comparison, "everything") is the
 * decision model's, in `criterion-lint.test.ts` and `evals:decisions`.
 */

describe("workflowCriterionError", () => {
  test("a criterion describing the kind of input is accepted", () => {
    for (const criterion of [
      "The document is a supplier invoice or a credit note.",
      "Le document est un contrat signé avec un client.",
      "The record is a new client company.",
    ]) {
      expect(workflowCriterionError(criterion)).toBeNull();
    }
  });

  test("an id is refused", () => {
    expect(
      workflowCriterionError(
        "The document id is 0199a3b2-7c1d-7e4f-9a2b-1c3d4e5f6a7b.",
      ),
    ).toContain("specific id");
  });

  test("a criterion too short to say anything is refused", () => {
    expect(workflowCriterionError("invoices")).toContain(
      "what makes a firing relevant",
    );
  });

  test("meaning is not judged here", () => {
    // A filename, a comparison, a "no criterion": each is a question about
    // what the sentence says, and a pattern only knows the phrasings it
    // lists. They reach the decision model instead.
    for (const criterion of [
      "The file is facture_2026_03.pdf exactly.",
      "The invoice amount is over 1 000 euros.",
      "Aucun critère : chaque document ajouté au Drive déclenche un résumé.",
    ]) {
      expect(workflowCriterionError(criterion)).toBeNull();
    }
  });
});
