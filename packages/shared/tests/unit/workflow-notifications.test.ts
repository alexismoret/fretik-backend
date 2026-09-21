import { describe, expect, test } from "bun:test";
import {
  UpdateWorkflowSchema,
  WORKFLOW_NOTIFICATIONS_DEFAULT,
  WorkflowNotificationsInputSchema,
  WorkflowNotificationsSchema,
} from "../../src/schemas/workflows";

/**
 * "Email on, nobody to send it to."
 *
 * Two of the four production workflows with completion emails enabled were in
 * that state on 2026-09-17 — `{emailOnCompletion: true, notifyTriggeredBy:
 * false, recipientUserIds: []}` — and the run that a user waited on produced no
 * email and no log line. The default was never the cause
 * (`notifyTriggeredBy` defaults to true); a panel that asked three unlinked
 * questions was.
 *
 * The rule is enforced on the way IN only. Those rows still have to be
 * readable, which is why the base schema keeps accepting them: refusing to
 * parse a stored row would turn a misconfigured workflow into an unopenable
 * one.
 */

const DEAD_STATE = {
  emailOnCompletion: true,
  notifyTriggeredBy: false,
  recipientUserIds: [],
};

describe("WorkflowNotificationsInputSchema", () => {
  test("refuses the state that sends to nobody", () => {
    expect(WorkflowNotificationsInputSchema.safeParse(DEAD_STATE).success).toBe(
      false,
    );
  });

  test("accepts each way of having a recipient", () => {
    expect(
      WorkflowNotificationsInputSchema.safeParse({
        ...DEAD_STATE,
        notifyTriggeredBy: true,
      }).success,
    ).toBe(true);
    expect(
      WorkflowNotificationsInputSchema.safeParse({
        ...DEAD_STATE,
        recipientUserIds: ["11111111-1111-4111-8111-111111111111"],
      }).success,
    ).toBe(true);
  });

  test("emails off needs no recipient — that is not the dead state", () => {
    expect(
      WorkflowNotificationsInputSchema.safeParse({
        ...DEAD_STATE,
        emailOnCompletion: false,
      }).success,
    ).toBe(true);
  });

  test("the shipped default was never the cause", () => {
    expect(
      WorkflowNotificationsInputSchema.safeParse(WORKFLOW_NOTIFICATIONS_DEFAULT)
        .success,
    ).toBe(true);
    expect(WORKFLOW_NOTIFICATIONS_DEFAULT.notifyTriggeredBy).toBe(true);
  });

  test("the base schema still reads a stored dead row", () => {
    // Storage and responses go through this one. A refinement here would make
    // the two live workflows unreadable instead of unwritable.
    expect(WorkflowNotificationsSchema.safeParse(DEAD_STATE).success).toBe(
      true,
    );
  });
});

describe("UpdateWorkflowSchema", () => {
  test("a PATCH carrying the dead state is rejected", () => {
    expect(
      UpdateWorkflowSchema.safeParse({ notifications: DEAD_STATE }).success,
    ).toBe(false);
  });

  test("a PATCH that does not touch notifications is unaffected", () => {
    expect(UpdateWorkflowSchema.safeParse({ name: "Renamed" }).success).toBe(
      true,
    );
  });
});
