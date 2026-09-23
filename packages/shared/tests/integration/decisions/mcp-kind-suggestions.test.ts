import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import db from "../../../src/db";
import { decisionLog, externalAppToolSnapshots } from "../../../src/db/schema";
import type {
  DecisionRequest,
  DecisionResponse,
} from "../../../src/schemas/decisions";
import type { DecisionEvaluator } from "../../../src/services/decisions/remote";
import { answerReadOnlySuggestion } from "../../../src/services/external-apps/mcp/answer-kind-suggestion";
import { listReadOnlySuggestions } from "../../../src/services/external-apps/mcp/list-kind-suggestions";
import {
  kindJournalId,
  SUGGEST_KIND_POINT,
  suggestMcpToolKinds,
} from "../../../src/services/external-apps/mcp/suggest-kinds";
import { mcpToolsToDescriptor } from "../../../src/services/external-apps/mcp/to-descriptor";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * The MCP read-only suggestions, against real rows.
 *
 * Three SQL claims. The pass asks only about tools the server left
 * un-annotated and not yet answered for this snapshot, so a second night
 * asks nothing. The listing shows this team's pending read suggestions and
 * nothing a label or another tenant should hide. An answer labels exactly
 * the tool it was about, and only an accepted one touches a permission.
 */

let fx: WorkspaceFixture;
let admin: string;

const FINGERPRINT = "sugg00000001";

const descriptor = mcpToolsToDescriptor({
  key: "acme",
  displayName: "Acme",
  categories: ["productivity"],
  tools: [
    // Un-annotated: asked about.
    { name: "list_orders", inputSchema: { type: "object", properties: {} } },
    { name: "items", inputSchema: { type: "object", properties: {} } },
    // The server said so itself: never asked.
    {
      name: "search",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
});

const createMcpConnection = async (): Promise<{
  id: string;
  snapshotId: string;
}> => {
  const conn = await fx.createConnection({
    providerKey: `acme-${Bun.randomUUIDv7().slice(0, 8)}`,
    mcpAuthKind: "none",
    mcpServerUrl: "https://mcp.example.test/sse",
    toolFingerprint: FINGERPRINT,
  });
  const [snapshot] = await db
    .insert(externalAppToolSnapshots)
    .values({
      providerKey: conn.providerKey,
      connectionId: conn.id,
      fingerprint: FINGERPRINT,
      descriptor,
      sdkPy: "# stub",
      skillMd: "# skill",
    })
    .returning({ id: externalAppToolSnapshots.id });
  if (snapshot === undefined) throw new Error("snapshot insert failed");
  return { id: conn.id, snapshotId: snapshot.id };
};

/**
 * Answers by tool name: `read` for `list_orders`, `mixed` for `items`, all
 * decided. `skip` leaves a tool unanswered, as a chunk that timed out would.
 */
const recording = (
  skip: ReadonlySet<string> = new Set(),
): { requests: DecisionRequest[]; evaluator: DecisionEvaluator } => {
  const requests: DecisionRequest[] = [];
  return {
    requests,
    evaluator: (request) => {
      requests.push(request);
      const answers: Record<
        string,
        {
          type: "choice";
          choice: string;
          probabilities: Record<string, number>;
          confidence: number;
        }
      > = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const tool = /"(\w+)"/.exec(question.instructions)?.[1] ?? "";
        if (skip.has(tool)) continue;
        const choice = tool === "list_orders" ? "read" : "mixed";
        answers[id] = {
          type: "choice",
          choice,
          probabilities: { [choice]: 0.9 },
          confidence: 0.9,
        };
      }
      const response: DecisionResponse = {
        status: "answered",
        point: SUGGEST_KIND_POINT,
        policy: {
          mode: "on",
          questionVersion: 1,
          thresholds: { kind: 0.8 },
          minChosenProbability: { kind: 0.6 },
        },
        answers,
        missing: [],
        transport: "openrouter",
        latencyMs: 5,
      };
      return Promise.resolve(response);
    },
  };
};

const toolsAsked = (request: DecisionRequest | undefined): string[] =>
  Object.values(request?.questions ?? {})
    .map((q) => /"(\w+)"/.exec(q.instructions)?.[1] ?? "")
    .sort();

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  [admin] = fx.userIds;
});

afterAll(async () => {
  await fx.cleanup();
});

describe("suggestMcpToolKinds", () => {
  test("asks about un-annotated tools once per snapshot", async () => {
    const conn = await createMcpConnection();
    const first = recording();
    // Both answers are confident, so both are suggestions; only the `read`
    // one is ever shown, but the count is of what was written.
    expect(
      await suggestMcpToolKinds({
        connectionId: conn.id,
        evaluator: first.evaluator,
      }),
    ).toBe(2);
    expect(toolsAsked(first.requests[0])).toEqual(["items", "list_orders"]);

    const second = recording();
    await suggestMcpToolKinds({
      connectionId: conn.id,
      evaluator: second.evaluator,
    });
    expect(second.requests).toHaveLength(0);
  });

  test("a tool left unanswered is asked again, alone", async () => {
    const conn = await createMcpConnection();
    await suggestMcpToolKinds({
      connectionId: conn.id,
      evaluator: recording(new Set(["items"])).evaluator,
    });
    const retry = recording();
    await suggestMcpToolKinds({
      connectionId: conn.id,
      evaluator: retry.evaluator,
    });
    expect(toolsAsked(retry.requests[0])).toEqual(["items"]);
  });
});

describe("listReadOnlySuggestions", () => {
  test("this team's pending read suggestions, nothing else", async () => {
    const conn = await createMcpConnection();
    await suggestMcpToolKinds({
      connectionId: conn.id,
      evaluator: recording().evaluator,
    });
    // A pending read suggestion on this very snapshot, filed under another
    // team: only the team clause keeps it out. (`search` because the unique
    // index spans point, subject and question, not the team.)
    const other = await fx.createTeam();
    await db.insert(decisionLog).values({
      organizationId: fx.organizationId,
      teamId: other.id,
      point: SUGGEST_KIND_POINT,
      family: "kind",
      questionId: kindJournalId("search"),
      questionVersion: 1,
      subjectType: "mcp_tool_snapshot",
      subjectId: conn.snapshotId,
      outcome: "suggested",
      applied: false,
      choice: "read",
    });

    const listed = await listReadOnlySuggestions({
      teamId: fx.teamId,
      snapshotId: conn.snapshotId,
    });
    expect([...listed]).toEqual(["list_orders"]);
  });
});

describe("answerReadOnlySuggestion", () => {
  test("accepting runs the tool without approval and labels it right", async () => {
    const conn = await createMcpConnection();
    await suggestMcpToolKinds({
      connectionId: conn.id,
      evaluator: recording().evaluator,
    });
    const row = await answerReadOnlySuggestion({
      connectionId: conn.id,
      teamId: fx.teamId,
      userId: admin,
      actionName: "list_orders",
      accept: true,
      isOrgAdmin: true,
    });
    expect(row.actionPolicies).toEqual({ list_orders: "auto" });

    const [labelled] = await db
      .select({ label: decisionLog.label, source: decisionLog.labelSource })
      .from(decisionLog)
      .where(
        and(
          eq(decisionLog.subjectId, conn.snapshotId),
          eq(decisionLog.questionId, kindJournalId("list_orders")),
        ),
      );
    expect(labelled).toEqual({ label: "read", source: "manual" });
  });

  test("rejecting changes no permission and hides the suggestion", async () => {
    const conn = await createMcpConnection();
    await suggestMcpToolKinds({
      connectionId: conn.id,
      evaluator: recording().evaluator,
    });
    const row = await answerReadOnlySuggestion({
      connectionId: conn.id,
      teamId: fx.teamId,
      userId: admin,
      actionName: "list_orders",
      accept: false,
      isOrgAdmin: true,
    });
    expect(row.actionPolicies ?? {}).toEqual({});
    expect(
      await listReadOnlySuggestions({
        teamId: fx.teamId,
        snapshotId: conn.snapshotId,
      }),
    ).toEqual(new Set());

    // Labelled on that tool alone: `items` keeps its own row untouched.
    const rows = await db
      .select({ q: decisionLog.questionId, label: decisionLog.label })
      .from(decisionLog)
      .where(eq(decisionLog.subjectId, conn.snapshotId));
    expect(Object.fromEntries(rows.map((r) => [r.q, r.label]))).toEqual({
      [kindJournalId("list_orders")]: "rejected",
      [kindJournalId("items")]: null,
    });
  });

  test("a team connection needs an admin, and a tool with no suggestion is a 404", async () => {
    const conn = await createMcpConnection();
    await suggestMcpToolKinds({
      connectionId: conn.id,
      evaluator: recording().evaluator,
    });
    const notAdmin = await rejection(
      answerReadOnlySuggestion({
        connectionId: conn.id,
        teamId: fx.teamId,
        userId: admin,
        actionName: "list_orders",
        accept: true,
        isOrgAdmin: false,
      }),
    );
    expect(notAdmin.message).toContain("FORBIDDEN");

    // `items` was answered `mixed`: journaled, but no read suggestion.
    const none = await rejection(
      answerReadOnlySuggestion({
        connectionId: conn.id,
        teamId: fx.teamId,
        userId: admin,
        actionName: "items",
        accept: true,
        isOrgAdmin: true,
      }),
    );
    expect(none.message).toContain("NOT_FOUND");
  });
});
