import { describe, expect, test } from "bun:test";
import type {
  ToolApprovalQuestionPayload,
  ToolApprovalRecordImportPayload,
  ToolApprovalRecordWritePayload,
  ToolApprovalToolCallPayload,
} from "../../src/db/schema";
import { recordImportLookupHash } from "../../src/services/approvals/hash";
import { isRecordImportPayload } from "../../src/services/approvals/payload-guards";

/**
 * Two contracts that decide whether a 200 000-row import replays or re-imports.
 *
 * The hash is what makes "re-run the exact same code after the grant" cost
 * nothing: the client recomputes it locally and the server matches an existing
 * operation without a single row being uploaded. A hash that collides across
 * DIFFERENT loads would replay the wrong outcome; one that changes for the SAME
 * load would import twice.
 */

const base = {
  op: "create",
  collectionId: "018f0000-0000-7000-8000-000000000001",
  totalRows: 200_000,
  rowsDigest: "a".repeat(64),
};

describe("recordImportLookupHash — the same load is the same key", () => {
  test("stable across calls", () => {
    expect(recordImportLookupHash(base)).toBe(recordImportLookupHash(base));
  });

  test("stable under key reordering", () => {
    const reordered = {
      rowsDigest: base.rowsDigest,
      totalRows: base.totalRows,
      collectionId: base.collectionId,
      op: base.op,
    };
    expect(recordImportLookupHash(reordered)).toBe(
      recordImportLookupHash(base),
    );
  });
});

describe("recordImportLookupHash — a different load is a different key", () => {
  test("different rows", () => {
    expect(
      recordImportLookupHash({ ...base, rowsDigest: "b".repeat(64) }),
    ).not.toBe(recordImportLookupHash(base));
  });

  test("one row more", () => {
    expect(recordImportLookupHash({ ...base, totalRows: 199_999 })).not.toBe(
      recordImportLookupHash(base),
    );
  });

  test("another target type", () => {
    expect(
      recordImportLookupHash({
        ...base,
        collectionId: "018f0000-0000-7000-8000-000000000002",
      }),
    ).not.toBe(recordImportLookupHash(base));
  });

  test("the digest alone does not decide it — the description counts too", () => {
    // Same rows, different type: replaying the first load here would write the
    // 200 000 rows into the wrong table, or claim they already are.
    const a = recordImportLookupHash(base);
    const b = recordImportLookupHash({ ...base, op: "update" });
    expect(a).not.toBe(b);
  });
});

describe("isRecordImportPayload — a refinement, not a sibling", () => {
  const importPayload: ToolApprovalRecordImportPayload = {
    op: "create",
    operationId: "018f0000-0000-7000-8000-00000000000a",
    totalRows: 200_000,
    collectionKey: "client",
    items: [{ data: { name: "ACME" } }],
  };
  const writePayload: ToolApprovalRecordWritePayload = {
    op: "create",
    collectionKey: "client",
    items: [{ data: { name: "ACME" } }],
  };
  const questionPayload: ToolApprovalQuestionPayload = { questions: [] };
  const toolCallPayload: ToolApprovalToolCallPayload = {
    toolName: "manageLink",
    args: {},
  };

  test("matches a staged import", () => {
    expect(isRecordImportPayload(importPayload)).toBe(true);
  });

  test("does NOT match an ordinary record write", () => {
    expect(isRecordImportPayload(writePayload)).toBe(false);
  });

  test("does not match the other kinds", () => {
    expect(isRecordImportPayload(questionPayload)).toBe(false);
    expect(isRecordImportPayload(toolCallPayload)).toBe(false);
    expect(isRecordImportPayload(null)).toBe(false);
  });
});
