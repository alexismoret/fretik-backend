import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import type {
  DecisionRequest,
  DecisionResponse,
} from "../../../src/schemas/decisions";
import type { DecisionEvaluator } from "../../../src/services/decisions/remote";
import {
  mentionKey,
  preResolveMentions,
} from "../../../src/services/documents/pre-resolve-mentions";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * Which mentions the entity pre-pass asks about, against real records.
 *
 * The claim is a SQL one: a mention the spelling cascade will settle on its
 * own (exact label, alias, similarity 0.8) is never asked about, and one with
 * no plausible record is not either. Only the near-but-not-settled middle
 * reaches the decision model, with this team's confirmed records only.
 */

let ws: WorkspaceFixture;
let companyId: string;

const record = async (label: string, over: { aliases?: string[] } = {}) =>
  ws.createRecord({
    collectionId: companyId,
    label,
    normalizedLabel: mentionKey(label),
    status: "confirmed",
    ...(over.aliases ? { aliases: over.aliases } : {}),
  });

/** Records every request and answers "another one" to everything. */
const recording = (): {
  requests: DecisionRequest[];
  evaluator: DecisionEvaluator;
} => {
  const requests: DecisionRequest[] = [];
  return {
    requests,
    evaluator: (request) => {
      requests.push(request);
      const response: DecisionResponse = {
        status: "answered",
        point: "graph.entity-match",
        policy: {
          questionVersion: 1,
          thresholds: { ent: 0.8 },
          minChosenProbability: { ent: 0.5 },
        },
        answers: {},
        missing: [],
        transport: "openrouter",
        latencyMs: 5,
      };
      return Promise.resolve(response);
    },
  };
};

beforeAll(async () => {
  ws = await createWorkspaceFixture();
  const existing = await db.query.collections.findFirst({
    where: { organizationId: ws.organizationId, key: "company" },
    columns: { id: true },
  });
  companyId = existing
    ? existing.id
    : (await ws.createCollection({ key: "company" })).id;
});

afterAll(async () => {
  await ws.cleanup();
});

describe("preResolveMentions", () => {
  test("only the near-but-unsettled mentions are asked about", async () => {
    // "Northwind" sits at similarity 0.56 to "northwind traders": near, not
    // settled. (A legal suffix is no test: "… Limited" normalizes away, and
    // the fold matches it exactly on its own.)
    await record("Northwind Traders");
    await record("Contoso");
    await record("Fabrikam Industries", { aliases: ["fabrikam"] });
    const { requests, evaluator } = recording();

    await preResolveMentions({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
      documentId: crypto.randomUUID(),
      mentions: [
        { name: "Northwind" },
        { name: "Contoso" },
        { name: "Fabrikam" },
        { name: "Completely Unrelated Co" },
      ],
      context: { filename: "a.pdf", documentSummary: null },
      evaluator,
    });

    expect(requests).toHaveLength(1);
    const asked = Object.values(requests[0]?.questions ?? {}).map(
      (q) => q.instructions,
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('"Northwind"');
  });

  test("with nothing to ask, the model is never called", async () => {
    const { requests, evaluator } = recording();
    const hints = await preResolveMentions({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
      documentId: crypto.randomUUID(),
      mentions: [{ name: "Contoso" }],
      context: { filename: "a.pdf", documentSummary: null },
      evaluator,
    });
    expect(requests).toHaveLength(0);
    expect(hints.size).toBe(0);
  });
});
