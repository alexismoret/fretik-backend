import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import db from "../../../src/db";
import {
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * `runApprovalGate` over rows that really exist, from the angle that broke in
 * prod on 2026-08-28: can the user ever be asked again after a write went
 * wrong?
 *
 * Real database on purpose. The gate's whole job is to route on the state it
 * READS, so a faked `findLatestApprovalByHash` would be the thing under test
 * answering for itself: every assertion below would still pass with the status
 * filter deleted from the query, and with `markFailedApproval`'s own status
 * predicate deleted too. Here the rows are inserted, the gate reads them back,
 * and the resulting status is read from Postgres.
 *
 * The ONE double is the kind handler: whether the write throws is the input
 * being varied, not a data source, and `deferExecution` is how a staged import
 * declares that it is owned by a worker. Everything else — find, claim, fail,
 * the single-flight lock — is real.
 */

let fx: WorkspaceFixture;

/**
 * ONE CONVERSATION PER TEST, never a shared one.
 *
 * The gate allows a single pending approval per conversation, so a row one test
 * leaves `pending` would defer the next test's fresh submission — an
 * `approval_deferred` where it expected `approval_pending`. `randomize = true`
 * is on, so that coupling would surface as a suite that passes in some orders
 * and not others. A conversation per test removes the shared state instead of
 * depending on the order.
 */
let conversationId: string;

/** Set per test: what the doubled handler's `execute` does. */
let executeError: Error | undefined;
/** Set per test: whether the kind hands execution to a worker. */
let defersExecution = false;
/** Every `execute` the gate actually reached. */
let executions = 0;

await mockModule("../../src/services/approvals/kinds", {
  APPROVAL_KIND_HANDLERS: {
    record_write: {
      kind: "record_write",
      execute: async () => {
        executions++;
        if (executeError) throw executeError;
        return [];
      },
      toToolOutput: () => ({ status: "approval_granted" }),
      toSandboxData: () => ({ ok: true }),
      deferExecution: () => defersExecution,
      startDeferred: async () => undefined,
    },
  },
});

const { runApprovalGate } =
  await import("../../../src/services/approvals/gate");

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

// Not a re-installed double (`--isolate` made that obsolete) — just this
// suite's own inputs, back to neutral before each of its tests.
beforeEach(async () => {
  conversationId = (await fx.createConversation()).id;
  executeError = undefined;
  defersExecution = false;
  executions = 0;
});

afterAll(async () => {
  await fx.cleanup();
});

let seq = 0;
const nextHash = (): string => `gate-hash-${(seq++).toString()}`;

const insertApproval = async (
  status: ToolApprovalRequest["status"],
  lookupHash: string,
  over: Partial<typeof toolApprovalRequests.$inferInsert> = {},
): Promise<ToolApprovalRequest> => {
  const [row] = await db
    .insert(toolApprovalRequests)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      conversationId,
      turnId: "01a04698-d809-755c-89f7-c9e96397a94b",
      kind: "record_write",
      lookupHash,
      status,
      ...over,
    })
    .returning();
  if (!row) throw new Error("failed to insert approval");
  return row;
};

const rowById = async (id: string): Promise<ToolApprovalRequest | undefined> =>
  db.query.toolApprovalRequests.findFirst({ where: { id } });

const runGate = async (
  lookupHash: string,
): Promise<Awaited<ReturnType<typeof runApprovalGate>>> =>
  runApprovalGate({
    ctx: {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      conversationId,
      turnId: "01a04698-d809-755c-89f7-c9e96397a94b",
    },
    kind: "record_write",
    autonomy: null,
    lookupHash,
    createPending: () => insertApproval("pending", lookupHash),
  });

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60 * 1000);

describe("a write that throws leaves a retryable state", () => {
  test("the row lands failed, and the identical call then opens a NEW request", async () => {
    const hash = nextHash();
    const granted = await insertApproval("granted", hash);
    executeError = new Error(
      'cannot insert a non-DEFAULT value into column "depense_totale"',
    );

    const first = await runGate(hash);

    // The reason reaches the agent verbatim — it is what distinguishes "fix
    // your data" from "the platform is stuck", which is the call the model got
    // wrong in the incident.
    expect(first.status).toBe("error");
    expect(first).toHaveProperty("message", executeError.message);
    expect((await rowById(granted.id))?.status).toBe("failed");

    // The retry: same conversation, same hash, no waiting.
    const second = await runGate(hash);

    expect(second.status).toBe("approval_pending");
    // ...and it is a DIFFERENT row, so the user gets a card rather than the
    // corpse of the previous attempt.
    expect(second).not.toHaveProperty("approvalId", granted.id);
  });
});

describe("an executing row, and who is allowed to sweep it", () => {
  test("a fresh inline execution is left alone and the agent is told to wait", async () => {
    const hash = nextHash();
    const running = await insertApproval("executing", hash, {
      executedAt: minutesAgo(1),
    });

    const res = await runGate(hash);

    expect(res.status).toBe("error");
    // Never "check state before retrying": that phrasing is what drove seven
    // identical re-runs into the same wall.
    expect(res).toHaveProperty("message", expect.stringContaining("Do NOT"));
    expect((await rowById(running.id))?.status).toBe("executing");
    expect(executions).toBe(0);
  });

  test("a stale inline execution is failed and replaced by a fresh request", async () => {
    const hash = nextHash();
    // No executor can still be alive: an inline execution lives inside the
    // grant's own HTTP request.
    const abandoned = await insertApproval("executing", hash, {
      executedAt: minutesAgo(30),
    });

    const res = await runGate(hash);

    expect(res.status).toBe("approval_pending");
    const swept = await rowById(abandoned.id);
    expect(swept?.status).toBe("failed");
    expect(swept?.executionError).toContain("interrupted");
  });

  test("a DEFERRED execution is never swept, however long it runs", async () => {
    // A staged import handed to the worker legitimately holds `executing` for
    // as long as the load takes — far past the inline window on a large file.
    // Sweeping it would open a second card for a write still in flight.
    defersExecution = true;
    const hash = nextHash();
    const importing = await insertApproval("executing", hash, {
      executedAt: minutesAgo(90),
    });

    const res = await runGate(hash);

    expect(res.status).toBe("error");
    expect((await rowById(importing.id))?.status).toBe("executing");
  });
});

describe("the states that must NOT change", () => {
  test("a consumed row replays its cached result and executes nothing", async () => {
    const hash = nextHash();
    const done = await insertApproval("consumed", hash, { result: [] });

    const res = await runGate(hash);

    expect(res.status).toBe("ok");
    expect(executions).toBe(0);
    expect((await rowById(done.id))?.status).toBe("consumed");
  });

  test("a rejected row does not answer — the re-emitted write asks again", async () => {
    const hash = nextHash();
    const refused = await insertApproval("rejected", hash);

    const res = await runGate(hash);

    expect(res.status).toBe("approval_pending");
    expect((await rowById(refused.id))?.status).toBe("rejected");
  });

  test("a granted row that executes cleanly consumes the SAME row", async () => {
    const hash = nextHash();
    const granted = await insertApproval("granted", hash);

    const res = await runGate(hash);

    expect(res.status).toBe("ok");
    expect(executions).toBe(1);
    // The doubled handler does not mark it consumed itself (the real one
    // does), so what is asserted here is the claim: `granted` → `executing`,
    // exactly once, by this call.
    expect((await rowById(granted.id))?.status).toBe("executing");
  });

  test("a second pending approval defers instead of opening a rival card", async () => {
    // Single-flight is kind-agnostic and is what keeps one conversation to one
    // card; it must survive everything above.
    const blocking = await insertApproval("pending", nextHash());

    const res = await runGate(nextHash());

    expect(res.status).toBe("approval_deferred");
    expect(res).toHaveProperty("blockingApprovalId", blocking.id);
  });
});
