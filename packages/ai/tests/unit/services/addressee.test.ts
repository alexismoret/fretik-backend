import { DECISION_POINTS } from "@fretik/shared/decisions/points";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import { describe, expect, test } from "bun:test";
import { ADDRESSEE_QUESTION } from "../../../src/services/addressee/measure";

/**
 * The addressee measurement may never act: the assistant staying quiet with
 * no way for a person to ask it to answer would be an invisible failure.
 */

describe("chat.addressee", () => {
  test("the question is valid on the wire", () => {
    expect(DecisionQuestionSchema.safeParse(ADDRESSEE_QUESTION).success).toBe(
      true,
    );
  });

  test("the point ships in shadow", () => {
    expect(DECISION_POINTS["chat.addressee"].defaultMode).toBe("shadow");
  });
});
