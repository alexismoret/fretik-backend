import { describe, expect, test } from "bun:test";
import { workflowCriterionError } from "../../src/schemas/workflows";

/**
 * What a trigger criterion may say. Each refusal protects against the same
 * invisible failure: a criterion that passes the one firing it was written
 * against, then quietly refuses every real one.
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

  test("an id or a filename is refused", () => {
    expect(
      workflowCriterionError(
        "The document id is 0199a3b2-7c1d-7e4f-9a2b-1c3d4e5f6a7b.",
      ),
    ).toContain("specific id");
    expect(
      workflowCriterionError("The file is facture_2026_03.pdf exactly."),
    ).toContain("specific file");
  });

  test("a comparison against a number or a date is refused, in either language", () => {
    for (const criterion of [
      "The invoice amount is over 1 000 euros.",
      "The contract was signed before 2026-01-01.",
      "Le montant est supérieur à 500 €.",
      "La facture a plus de 30 jours.",
      "The total is >= 1000.",
    ]) {
      expect(workflowCriterionError(criterion)).toContain("compare numbers");
    }
  });

  test("a number that is not compared is fine", () => {
    // Naming a year or a form number is description, not arithmetic.
    expect(
      workflowCriterionError("The document is a 2026 annual tax return."),
    ).toBeNull();
  });
});
