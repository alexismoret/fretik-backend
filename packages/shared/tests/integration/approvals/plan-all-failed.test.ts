import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import {
  type ToolApprovalOpResult,
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../../src/db/schema";
import type { ProviderManifest } from "../../../src/external-apps/manifest-schema";
import { setProviders } from "../../../src/external-apps/registry";
import { findLatestApprovalByHash } from "../../../src/services/approvals/find";
import { finalizePlanRow } from "../../../src/services/external-apps/exec/plan-outcome";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * How an executed plan's row is closed, and what the gate then does with it.
 *
 * Real database, no doubles. The claim under test lives in two `where`
 * clauses and nowhere else: `markFailedApproval` only takes on a row that is
 * still `executing` (`approvals/claim.ts`), and `findLatestApprovalByHash`
 * skips `rejected` / `failed` (`approvals/find.ts`). A double would be the
 * subject answering for itself — every assertion below still passes with both
 * predicates deleted, if the statuses come from JavaScript.
 *
 * The incident: on 2026-09-16 a five-file upload was refused for one empty
 * payload, the row was cached `consumed`, and the agent's corrected re-send
 * — same paths, different bytes, therefore the same `lookupHash`, because the
 * hash omits the payload on purpose — was answered with the stored failure
 * without executing. Four minutes and fifteen tool calls followed.
 */

let fx: WorkspaceFixture;
let conversationId: string;

const TURN_ID = "01a04698-d809-755c-89f7-c9e96397a94b";

/**
 * A synthetic uploader rather than the real `ftp-sftp`: `@fretik/shared` must
 * not import `@fretik/providers`. This is an INPUT (which params are flagged),
 * not a stand-in for anything under test — the statuses and the purged column
 * are all read back from Postgres.
 */
const uploaderManifest: ProviderManifest = {
  key: "purge-fixture",
  displayName: "Purge fixture",
  description: "Synthetic uploader exercising post-execution purging.",
  nangoProviderConfigKey: "purge-fixture",
  icon: "i-lucide-flask-conical",
  transport: { kind: "custom-handler" },
  scopes: [],
  categories: ["storage"],
  types: {},
  actions: [
    {
      name: "upload_files",
      kind: "write",
      summary: "Upload files",
      handler: "uploadFiles",
      params: {
        files: {
          type: "array",
          items: {
            type: "object",
            fields: {
              remote_path: { type: "string" },
              content_base64: { type: "string", hashAsDigest: true },
            },
          },
        },
      },
      returns: { void: true },
    },
  ],
};

beforeAll(async () => {
  setProviders({
    "purge-fixture": {
      manifest: uploaderManifest,
      handlers: { uploadFiles: async () => [] },
      summaries: { upload_files: () => ({ titleKey: "default", fields: [] }) },
    },
  });
  fx = await createWorkspaceFixture();
});

// One conversation per test: `findLatestApprovalByHash` is scoped by it, and
// a row left behind would answer the next test's lookup.
beforeEach(async () => {
  conversationId = (await fx.createConversation()).id;
});

afterAll(async () => {
  await fx.cleanup();
});

let seq = 0;
const nextHash = (): string => `plan-hash-${(seq++).toString()}`;

const insertExecutingPlan = async (
  lookupHash: string,
): Promise<ToolApprovalRequest> => {
  const [row] = await db
    .insert(toolApprovalRequests)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0],
      conversationId,
      turnId: TURN_ID,
      kind: "external_app_plan",
      lookupHash,
      status: "executing",
      executedAt: new Date(),
      operations: [
        {
          action: "ftp-sftp.upload_files",
          args: { files: [{ remote_path: "26270019.SIR" }] },
        },
      ],
    })
    .returning();
  if (!row) throw new Error("failed to insert approval");
  return row;
};

const insertUploadPlan = async (
  lookupHash: string,
  contentBase64: string,
): Promise<ToolApprovalRequest> => {
  const row = await insertExecutingPlan(lookupHash);
  const [updated] = await db
    .update(toolApprovalRequests)
    .set({
      operations: [
        {
          action: "purge-fixture.upload_files",
          args: {
            files: [
              { remote_path: "26270019.SIH", content_base64: contentBase64 },
            ],
          },
        },
      ],
    })
    .where(eq(toolApprovalRequests.id, row.id))
    .returning();
  if (!updated) throw new Error("failed to set operations");
  return updated;
};

const rowById = async (id: string): Promise<ToolApprovalRequest | undefined> =>
  db.query.toolApprovalRequests.findFirst({ where: { id } });

/** One op, `ok:true`, whose per-file rows all failed — the shape a wholly
 * rejected `upload_files` produces once a bad payload is a row, not a throw. */
const allRowsFailed: ToolApprovalOpResult = {
  ok: true,
  data: {
    value: [
      { path: "26270019.SIR", ok: false, error: "not valid base64" },
      { path: "26270019.SIO", ok: false, error: "not valid base64" },
    ],
  },
};

describe("a plan that wrote nothing is not cached", () => {
  test("every op failed → the row lands failed, with the reasons and the detail kept", async () => {
    const row = await insertExecutingPlan(nextHash());
    const results: ToolApprovalOpResult[] = [
      { ok: false, error: "connection refused" },
    ];

    await finalizePlanRow(row.id, results);

    const after = await rowById(row.id);
    expect(after?.status).toBe("failed");
    expect(after?.executionError).toContain("connection refused");
  });

  test("an upload whose every FILE failed lands failed too", async () => {
    // The outer op is `ok:true` here. Reading only that would cache it.
    const row = await insertExecutingPlan(nextHash());

    await finalizePlanRow(row.id, [allRowsFailed]);

    const after = await rowById(row.id);
    expect(after?.status).toBe("failed");
    expect(after?.executionError).toContain("not valid base64");
  });

  test("the per-op detail survives on the row for audit", async () => {
    // `markFailedApproval` must not clear `result`: it is the only record of
    // what was attempted, and the card renders it.
    const row = await insertExecutingPlan(nextHash());
    await db
      .update(toolApprovalRequests)
      .set({ result: [allRowsFailed] })
      .where(eq(toolApprovalRequests.id, row.id));

    await finalizePlanRow(row.id, [allRowsFailed]);

    const after = await rowById(row.id);
    expect(after?.result).toEqual([allRowsFailed]);
  });

  test("the failed row is invisible to the hash lookup, so the identical call starts fresh", async () => {
    // The production bug, end to end: same paths, different bytes, same hash.
    const hash = nextHash();
    const row = await insertExecutingPlan(hash);

    await finalizePlanRow(row.id, [allRowsFailed]);

    expect(
      await findLatestApprovalByHash({ conversationId, lookupHash: hash }),
    ).toBeUndefined();
  });
});

describe("a plan that wrote something stays cached", () => {
  test("a half-succeeded plan lands consumed", async () => {
    // The double-write guard. Re-issuing this one writes the first file
    // twice, which is exactly what the cache exists to prevent.
    const row = await insertExecutingPlan(nextHash());
    const halfSucceeded: ToolApprovalOpResult = {
      ok: true,
      data: {
        value: [
          { path: "a.csv", ok: true },
          { path: "b.csv", ok: false, error: "permission denied" },
        ],
      },
    };

    await finalizePlanRow(row.id, [halfSucceeded]);

    const after = await rowById(row.id);
    expect(after?.status).toBe("consumed");
  });

  test("one failed op beside one that worked lands consumed", async () => {
    const row = await insertExecutingPlan(nextHash());

    await finalizePlanRow(row.id, [
      { ok: false, error: "connection refused" },
      { ok: true, data: { id: "msg-1" } },
    ]);

    expect((await rowById(row.id))?.status).toBe("consumed");
  });

  test("the consumed row is still found by the hash, so the replay cache is intact", async () => {
    const hash = nextHash();
    const row = await insertExecutingPlan(hash);

    await finalizePlanRow(row.id, [{ ok: true, data: { id: "msg-1" } }]);

    const found = await findLatestApprovalByHash({
      conversationId,
      lookupHash: hash,
    });
    expect(found?.id).toBe(row.id);
    expect(found?.status).toBe("consumed");
  });

  test("a zero-op plan lands consumed rather than failing vacuously", async () => {
    const row = await insertExecutingPlan(nextHash());

    await finalizePlanRow(row.id, []);

    expect((await rowById(row.id))?.status).toBe("consumed");
  });
});

describe("an executed plan does not keep its payload", () => {
  test("the stored bytes are replaced by a size and a digest", async () => {
    // `operations` has no expiry and is serialised to the browser on every
    // approval fetch; ~27 MB of base64 per upload would live there forever.
    const row = await insertUploadPlan(nextHash(), "aGVsbG8=");

    await finalizePlanRow(row.id, [{ ok: true, data: { id: "ok" } }]);

    const files = (await rowById(row.id))?.operations?.[0]?.args.files;
    if (!Array.isArray(files)) throw new Error("expected a files array");
    expect(files[0]).toMatchObject({
      remote_path: "26270019.SIH",
      content_base64: { bytes: 5 },
    });
  });

  test("a failed plan is purged too — it is terminal either way", async () => {
    const row = await insertUploadPlan(nextHash(), "aGVsbG8=");

    await finalizePlanRow(row.id, [{ ok: false, error: "connection refused" }]);

    const files = (await rowById(row.id))?.operations?.[0]?.args.files;
    if (!Array.isArray(files)) throw new Error("expected a files array");
    expect(files[0]).toMatchObject({ content_base64: { bytes: 5 } });
  });

  test("a row still awaiting its turn keeps the bytes", async () => {
    // Before execution they are what the user approves and what
    // `claimAndExecute` will send — purging them would empty the upload.
    const row = await insertUploadPlan(nextHash(), "aGVsbG8=");

    const files = (await rowById(row.id))?.operations?.[0]?.args.files;
    if (!Array.isArray(files)) throw new Error("expected a files array");
    expect(files[0]).toMatchObject({ content_base64: "aGVsbG8=" });
  });
});
