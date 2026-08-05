import { describe, expect, test } from "bun:test";
import type { Workflow } from "../../src/db/schema";
import { buildWorkflowCard } from "../../src/services/workflows/vector-refresh";

/**
 * The searchable card is what makes a workflow findable from a request that
 * never says "workflow". Two properties matter and are easy to break:
 * every user-editable field that describes the work must reach the card (or
 * an edit would silently leave a stale card behind), and the card must be
 * stable for an unchanged workflow (or the `content_hash` short-circuit would
 * re-embed on every save).
 */

const workflow = (overrides: Partial<Workflow> = {}): Workflow =>
  ({
    id: "11111111-1111-7111-8111-111111111111",
    name: "Weekly supplier report",
    description: "Totals per supplier, every Monday.",
    status: "active",
    triggerType: "cron",
    triggerConfig: { cron: { pattern: "0 9 * * 1" } },
    playbook: {
      goal: "Produce the weekly supplier totals",
      tasks: [
        {
          key: "collect",
          title: "Collect invoices",
          description: "Gather last week's invoices",
          instructions: "…",
        },
      ],
    },
    ...overrides,
  }) as Workflow;

describe("buildWorkflowCard", () => {
  test("is stable for an unchanged workflow", () => {
    expect(buildWorkflowCard(workflow())).toBe(buildWorkflowCard(workflow()));
  });

  test("carries the fields a user edits", () => {
    const card = buildWorkflowCard(workflow());
    expect(card).toContain("Weekly supplier report");
    expect(card).toContain("Totals per supplier, every Monday.");
    expect(card).toContain("Produce the weekly supplier totals");
    expect(card).toContain("Collect invoices");
    expect(card).toContain("0 9 * * 1");
  });

  test("changes when the title changes — the card must not go stale", () => {
    const before = buildWorkflowCard(workflow());
    const after = buildWorkflowCard(
      workflow({ name: "Monthly supplier report" }),
    );
    expect(after).not.toBe(before);
    expect(after).toContain("Monthly supplier report");
  });

  test("changes when the playbook or the trigger changes", () => {
    const before = buildWorkflowCard(workflow());
    expect(
      buildWorkflowCard(
        workflow({
          playbook: {
            goal: "Produce the weekly supplier totals",
            tasks: [
              {
                key: "collect",
                title: "Collect invoices",
                description: "Gather last week's invoices",
                instructions: "…",
              },
              {
                key: "send",
                title: "Email the report",
                description: "Send it to finance",
                instructions: "…",
              },
            ],
          },
        }),
      ),
    ).not.toBe(before);
    expect(
      buildWorkflowCard(workflow({ triggerType: "manual", triggerConfig: {} })),
    ).not.toBe(before);
  });

  test("describes the trigger in words a request would use", () => {
    expect(
      buildWorkflowCard(workflow({ triggerType: "manual", triggerConfig: {} })),
    ).toContain("on demand");
  });
});
