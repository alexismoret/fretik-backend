import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import {
  decisionLog,
  domainEvents,
  workflowRuns,
  workflows,
} from "../../../src/db/schema";
import type { DecisionResponse } from "../../../src/schemas/decisions";
import type { WorkflowPlaybook } from "../../../src/schemas/workflows";
import { getDashboardDecisions } from "../../../src/services/dashboard/get-decisions";
import type { DecisionEvaluator } from "../../../src/services/decisions/remote";
import { backtestCriterion } from "../../../src/services/workflows/backtest-criterion";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * "Test the condition" and the dashboard's decision card, against real rows.
 *
 * The backtest's claim is about WHICH events it replays: the same ones the
 * trigger sweep would have launched on (subscribed type, matching filter, not
 * a workflow's own write, this team only). A backtest over any other set
 * shows verdicts for firings that never happen. The decision model is the
 * only thing doubled: it is a process boundary, and the subject here is the
 * selection and the reading of its answers.
 */

const PLAYBOOK: WorkflowPlaybook = {
  goal: "File supplier invoices",
  tasks: [{ key: "t", title: "T", description: "", instructions: "i" }],
};

let ws: WorkspaceFixture;

const createWorkflow = async (folderId: string): Promise<string> => {
  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
      name: "Invoice filing",
      triggerType: "event",
      triggerConfig: {
        event: {
          events: [{ type: "document.uploaded", filter: { folderId } }],
        },
      },
      playbook: PLAYBOOK,
      status: "active",
      createdByUserId: ws.userIds[0],
    })
    .returning({ id: workflows.id });
  if (!row) throw new Error("fixture: workflow");
  return row.id;
};

const createEvent = async (
  values: Partial<typeof domainEvents.$inferInsert> & { type: string },
  teamId: string = ws.teamId,
): Promise<string> => {
  const [row] = await db
    .insert(domainEvents)
    .values({
      organizationId: ws.organizationId,
      teamId,
      actorType: "user",
      payload: {},
      ...values,
    })
    .returning({ id: domainEvents.id });
  if (!row) throw new Error("fixture: event");
  return row.id;
};

/** Answers every question at the probability mapped for its event. */
const fakeEvaluator =
  (probabilities: Map<string, number | null>): DecisionEvaluator =>
  (request) => {
    const id = Object.keys(request.questions)[0] ?? "";
    const p = probabilities.get(request.subject?.id ?? "");
    const response: DecisionResponse = {
      status: "answered",
      point: "workflow.gate",
      policy: {
        questionVersion: 2,
        thresholds: { wf: 0.15 },
        minChosenProbability: {},
      },
      answers:
        p === null || p === undefined
          ? {}
          : { [id]: { type: "boolean", probability: p } },
      missing: [],
      transport: "openrouter",
      latencyMs: 10,
    };
    return Promise.resolve(response);
  };

const caught = async (run: () => Promise<unknown>): Promise<Error | null> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

beforeAll(async () => {
  ws = await createWorkspaceFixture();
});

afterAll(async () => {
  await ws.cleanup();
});

describe("backtestCriterion", () => {
  test("replays only the events the trigger would have launched on", async () => {
    const watched = crypto.randomUUID();
    const workflowId = await createWorkflow(watched);
    const other = await ws.createTeam();
    const matching = await createEvent({
      type: "document.uploaded",
      payload: { folderId: watched },
    });
    await createEvent({
      type: "document.uploaded",
      payload: { folderId: crypto.randomUUID() },
    });
    await createEvent({ type: "record.created", payload: {} });
    await createEvent({
      type: "document.uploaded",
      payload: { folderId: watched },
      actorType: "workflow",
    });
    await createEvent(
      { type: "document.uploaded", payload: { folderId: watched } },
      other.id,
    );

    const result = await backtestCriterion({
      workflowId,
      teamId: ws.teamId,
      organizationId: ws.organizationId,
      criterion: "The document is a supplier invoice.",
      evaluator: fakeEvaluator(new Map([[matching, 0.9]])),
    });
    expect(result.results.map((r) => r.eventId)).toEqual([matching]);
  });

  test("each verdict is read against the echoed bar, and silence is `unknown`", async () => {
    const watched = crypto.randomUUID();
    const workflowId = await createWorkflow(watched);
    const run = await createEvent({
      type: "document.uploaded",
      payload: { folderId: watched },
    });
    const filtered = await createEvent({
      type: "document.uploaded",
      payload: { folderId: watched },
    });
    const silent = await createEvent({
      type: "document.uploaded",
      payload: { folderId: watched },
    });

    const result = await backtestCriterion({
      workflowId,
      teamId: ws.teamId,
      organizationId: ws.organizationId,
      criterion: "The document is a supplier invoice.",
      evaluator: fakeEvaluator(
        new Map<string, number | null>([
          [run, 0.15],
          [filtered, 0.14],
          [silent, null],
        ]),
      ),
    });
    const byId = new Map(result.results.map((r) => [r.eventId, r.outcome]));
    expect(byId.get(run)).toBe("run");
    expect(byId.get(filtered)).toBe("filtered");
    expect(byId.get(silent)).toBe("unknown");
    expect(result.threshold).toBe(0.15);
  });

  test("a criterion with an id in it is refused before any call", async () => {
    const workflowId = await createWorkflow(crypto.randomUUID());
    let calls = 0;
    const error = await caught(() =>
      backtestCriterion({
        workflowId,
        teamId: ws.teamId,
        organizationId: ws.organizationId,
        criterion: `The document id is ${crypto.randomUUID()}.`,
        evaluator: () => {
          calls += 1;
          return Promise.resolve(null);
        },
      }),
    );
    expect(error?.message).toContain("specific id");
    expect(calls).toBe(0);
  });

  test("a criterion the lint refuses replays nothing", async () => {
    const watched = crypto.randomUUID();
    const workflowId = await createWorkflow(watched);
    await createEvent({
      type: "document.uploaded",
      payload: { folderId: watched },
    });
    const asked: string[] = [];
    const error = await caught(() =>
      backtestCriterion({
        workflowId,
        teamId: ws.teamId,
        organizationId: ws.organizationId,
        criterion: "The file is the scan the client sent this morning.",
        evaluator: (request) => {
          asked.push(request.point);
          const response: DecisionResponse = {
            status: "answered",
            point: request.point,
            policy: {
              questionVersion: 1,
              thresholds: { one: 0.8, cmp: 0.8, open: 0.8 },
              minChosenProbability: {},
            },
            answers: { one: { type: "boolean", probability: 0.93 } },
            missing: [],
            transport: "openrouter",
            latencyMs: 10,
          };
          return Promise.resolve(response);
        },
      }),
    );
    expect(error?.message).toContain("one specific file or item");
    expect(asked).toEqual(["workflow.criterion.lint"]);
  });
});

describe("getDashboardDecisions", () => {
  test("avoided launches are priced at their own workflow's median run", async () => {
    const fresh = await createWorkspaceFixture();
    try {
      const [wf] = await db
        .insert(workflows)
        .values({
          organizationId: fresh.organizationId,
          teamId: fresh.teamId,
          name: "Priced",
          triggerType: "event",
          playbook: PLAYBOOK,
          status: "active",
        })
        .returning({ id: workflows.id });
      if (!wf) throw new Error("fixture: workflow");
      const run = (
        status: "filtered" | "succeeded",
        totalTokens: number,
      ): typeof workflowRuns.$inferInsert => ({
        workflowId: wf.id,
        organizationId: fresh.organizationId,
        teamId: fresh.teamId,
        triggerType: "event",
        status,
        usage: {
          inputTokens: totalTokens,
          outputTokens: 0,
          totalTokens,
          cachedInputTokens: 0,
          turns: 1,
        },
      });
      await db
        .insert(workflowRuns)
        .values([
          run("filtered", 0),
          run("filtered", 0),
          run("succeeded", 100),
          run("succeeded", 300),
        ]);
      const filingRow = (label: string | null) => ({
        organizationId: fresh.organizationId,
        teamId: fresh.teamId,
        point: "drive.file",
        family: "folder",
        questionId: "folder",
        questionVersion: 2,
        subjectType: "document",
        subjectId: crypto.randomUUID(),
        targetId: crypto.randomUUID(),
        outcome: "filed",
        applied: true,
        label,
      });
      await db
        .insert(decisionLog)
        .values([filingRow(null), filingRow("__root__")]);

      expect(await getDashboardDecisions({ teamId: fresh.teamId })).toEqual({
        days: 30,
        runsAvoided: 2,
        tokensSavedEstimate: 400,
        documentsFiled: 2,
        filingsUndone: 1,
      });
    } finally {
      await fresh.cleanup();
    }
  });

  test("with nothing executed to price against, the estimate is absent, not zero", async () => {
    const fresh = await createWorkspaceFixture();
    try {
      const [wf] = await db
        .insert(workflows)
        .values({
          organizationId: fresh.organizationId,
          teamId: fresh.teamId,
          name: "Unpriced",
          triggerType: "event",
          playbook: PLAYBOOK,
          status: "active",
        })
        .returning({ id: workflows.id });
      if (!wf) throw new Error("fixture: workflow");
      await db.insert(workflowRuns).values({
        workflowId: wf.id,
        organizationId: fresh.organizationId,
        teamId: fresh.teamId,
        triggerType: "event",
        status: "filtered",
      });
      const summary = await getDashboardDecisions({ teamId: fresh.teamId });
      expect(summary.runsAvoided).toBe(1);
      expect(summary.tokensSavedEstimate).toBeNull();
    } finally {
      await fresh.cleanup();
    }
  });
});
