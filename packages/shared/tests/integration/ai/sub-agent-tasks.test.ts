import "@hono/zod-openapi";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import db from "../../../src/db";
import type { SubAgentTaskState } from "../../../src/db/schema";
import { conversationBackgroundTasks } from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * A sub-agent's task row, written from three places at once.
 *
 * The worker running it rewrites its live state every few seconds; a stop
 * request (the user's button, the assistant, the Stop of the answer that
 * launched it) sets one field from elsewhere; a workflow run stamps it billed.
 * Each of these is a guarded UPDATE whose WHERE is the whole claim — pending
 * only, this conversation only, not billed twice — so a doubled database would
 * be asserting its own bookkeeping. Integration.
 *
 * The stop channel is the one double: publishing is the side effect being
 * observed, and the running process that would hear it is not here.
 */

let fx: WorkspaceFixture;
let conversationId: string;
const published: { agentId: string; by: string }[] = [];

await mockModule("../../src/lib/sub-agent-abort", {
  publishSubAgentAbort: async (agentId: string, by: string) => {
    published.push({ agentId, by });
  },
});

const { requestSubAgentStop } =
  await import("../../../src/services/conversation-tasks/request-sub-agent-stop");
const { patchConversationTaskMetadata } =
  await import("../../../src/services/conversation-tasks/patch-metadata");
const { completeConversationTask } =
  await import("../../../src/services/conversation-tasks/complete");
const { claimSubAgentSpend } =
  await import("../../../src/services/conversation-tasks/claim-sub-agent-spend");
const { readUnbilledSubAgentSpend } =
  await import("../../../src/services/conversation-tasks/read-sub-agent-spend");
const { consumeConversationTasks } =
  await import("../../../src/services/conversation-tasks/consume");

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

beforeEach(async () => {
  conversationId = (await fx.createConversation()).id;
  published.length = 0;
});

afterAll(async () => {
  await fx.cleanup();
});

let seq = 0;

const subAgent = async (
  state: SubAgentTaskState,
  over: {
    status?: "pending" | "succeeded" | "canceled";
    conversation?: string;
  } = {},
): Promise<string> => {
  seq += 1;
  const ref = `agent-${Date.now().toString()}-${seq.toString()}`;
  const settled = over.status !== undefined && over.status !== "pending";
  await db.insert(conversationBackgroundTasks).values({
    conversationId: over.conversation ?? conversationId,
    kind: "sub_agent",
    ref,
    title: "Compare offers",
    status: over.status ?? "pending",
    ...(settled ? { completedAt: new Date() } : {}),
    metadata: { subAgent: state },
  });
  return ref;
};

const stateOf = async (ref: string): Promise<SubAgentTaskState | undefined> => {
  const [row] = await db
    .select({ metadata: conversationBackgroundTasks.metadata })
    .from(conversationBackgroundTasks)
    .where(
      and(
        eq(conversationBackgroundTasks.kind, "sub_agent"),
        eq(conversationBackgroundTasks.ref, ref),
      ),
    );
  return row?.metadata?.subAgent;
};

describe("stopping sub-agents", () => {
  test("named ones: only those still running, in this conversation", async () => {
    const running = await subAgent({ toolCallId: "call_1" });
    const done = await subAgent({}, { status: "succeeded" });
    const elsewhere = await subAgent(
      {},
      { conversation: (await fx.createConversation()).id },
    );

    const asked = await requestSubAgentStop({
      conversationId,
      by: "user",
      agentIds: [running, done, elsewhere],
    });

    expect(asked).toEqual([running]);
    expect(published).toEqual([{ agentId: running, by: "user" }]);
    // The flag joins the state; what was there stays.
    expect(await stateOf(running)).toEqual({
      toolCallId: "call_1",
      stopRequested: "user",
    });
    expect((await stateOf(elsewhere))?.stopRequested).toBeUndefined();
  });

  test("by turn: every one that answer launched, and no other", async () => {
    const mine = await subAgent({ turnId: "turn-a" });
    const earlier = await subAgent({ turnId: "turn-0" });
    const asked = await requestSubAgentStop({
      conversationId,
      by: "turn",
      turnId: "turn-a",
    });
    expect(asked).toEqual([mine]);
    expect((await stateOf(earlier))?.stopRequested).toBeUndefined();
  });

  test("a second stop does not rename who asked first", async () => {
    const ref = await subAgent({});
    await requestSubAgentStop({ conversationId, by: "user", agentIds: [ref] });
    const again = await requestSubAgentStop({
      conversationId,
      by: "parent",
      all: true,
    });
    expect(again).toEqual([]);
    expect((await stateOf(ref))?.stopRequested).toBe("user");
  });

  test("the worker's next progress write keeps the stop it did not know about", async () => {
    const ref = await subAgent({ toolCallId: "call_1", step: 1 });
    await requestSubAgentStop({ conversationId, by: "user", agentIds: [ref] });
    // The worker writes its whole state, which predates the stop.
    await patchConversationTaskMetadata({
      kind: "sub_agent",
      ref,
      metadata: { subAgent: { toolCallId: "call_1", step: 2, activity: [] } },
    });
    expect(await stateOf(ref)).toEqual({
      toolCallId: "call_1",
      step: 2,
      activity: [],
      stopRequested: "user",
    });
  });
});

describe("billing sub-agents to a workflow run", () => {
  const usage = (tokens: number) => ({
    costUsd: 0.01,
    inputTokens: tokens,
    outputTokens: tokens / 10,
    cacheReadTokens: tokens / 2,
  });

  test("a settled sub-agent is claimed once; a running one waits for its turn", async () => {
    const settled = await subAgent({ usage: usage(1000) });
    await completeConversationTask({
      kind: "sub_agent",
      ref: settled,
      status: "succeeded",
    });
    await subAgent({ usage: usage(400) });

    // Before any claim, a budget check sees both: the live figure of the
    // running one included.
    expect(await readUnbilledSubAgentSpend(conversationId)).toEqual({
      inputTokens: 1400,
      outputTokens: 140,
      cacheReadTokens: 700,
    });
    expect(await claimSubAgentSpend(conversationId)).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 500,
    });
    // Never twice.
    expect(await claimSubAgentSpend(conversationId)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
    expect(await readUnbilledSubAgentSpend(conversationId)).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      cacheReadTokens: 200,
    });
    // Its report survives the billing stamp.
    expect((await stateOf(settled))?.usage).toEqual(usage(1000));
  });

  test("the end of a run consumes every report nobody collected", async () => {
    const a = await subAgent({}, { status: "succeeded" });
    const b = await subAgent({}, { status: "canceled" });
    await subAgent({});
    const consumed = await consumeConversationTasks({
      conversationId,
      kind: "sub_agent",
    });
    expect(consumed.map((task) => task.ref).sort()).toEqual([a, b].sort());
  });
});
