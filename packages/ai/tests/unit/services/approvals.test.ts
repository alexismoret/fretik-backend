import type {
  ToolApprovalRecordResult,
  ToolApprovalRecordWritePayload,
} from "@fretik/shared/db/schema";
import { approvalPendingId } from "@fretik/shared/services/ai/approval-pending";
import {
  canonicalHash,
  recordWriteLookupHash,
} from "@fretik/shared/services/approvals/hash";
import { recordWriteWire } from "@fretik/shared/services/approvals/kinds/record-write-wire";
import { describe, expect, test } from "bun:test";

/**
 * Pure invariants of the unified approval domain: the sandbox re-run wire
 * shape (must mirror the direct bulk path), the dedup hash (deterministic +
 * op-discriminating + volatile-field-blind), and the tool-agnostic pause
 * marker. All dependency-free — no DB, no runtime context.
 */

describe("approvalPendingId", () => {
  test("returns the id for a pending marker", () => {
    expect(
      approvalPendingId({ status: "approval_pending", approvalId: "abc" }),
    ).toBe("abc");
  });

  test("returns null for non-pending / malformed outputs", () => {
    expect(
      approvalPendingId({ status: "approval_granted", approvalId: "abc" }),
    ).toBeNull();
    expect(approvalPendingId({ status: "answered", answers: {} })).toBeNull();
    // pending but no id, or a non-string id
    expect(approvalPendingId({ status: "approval_pending" })).toBeNull();
    expect(
      approvalPendingId({ status: "approval_pending", approvalId: 123 }),
    ).toBeNull();
    expect(approvalPendingId(null)).toBeNull();
    expect(approvalPendingId("nope")).toBeNull();
    expect(approvalPendingId({})).toBeNull();
  });
});

describe("recordWriteWire", () => {
  test("create → positional ids (nulls for failed/skipped) + indexed errors", () => {
    const payload: ToolApprovalRecordWritePayload = {
      op: "create",
      items: [{ data: {} }, { data: {} }, { data: {} }],
    };
    const results: ToolApprovalRecordResult[] = [
      { ok: true, id: "a", label: "A" },
      { ok: false, error: "bad" },
      { skipped: true },
    ];
    expect(recordWriteWire(payload, results)).toEqual({
      ids: ["a", null, null],
      okCount: 1,
      errors: [{ index: 1, error: "bad" }],
      relationErrors: [],
    });
  });

  test("update → updatedIds + errors keyed by the payload item's recordId", () => {
    const payload: ToolApprovalRecordWritePayload = {
      op: "update",
      items: [{ recordId: "r1" }, { recordId: "r2" }],
    };
    const results: ToolApprovalRecordResult[] = [
      { ok: true, id: "r1", label: "L" },
      { ok: false, error: "nope" },
    ];
    expect(recordWriteWire(payload, results)).toEqual({
      updatedIds: ["r1"],
      okCount: 1,
      errors: [{ id: "r2", error: "nope" }],
    });
  });

  test("delete → deletedIds, skipped items ignored", () => {
    const payload: ToolApprovalRecordWritePayload = {
      op: "delete",
      items: [{ recordId: "d1" }, { recordId: "d2" }],
    };
    const results: ToolApprovalRecordResult[] = [
      { ok: true, id: "d1", label: "" },
      { skipped: true },
    ];
    expect(recordWriteWire(payload, results)).toEqual({
      deletedIds: ["d1"],
      okCount: 1,
      errors: [],
    });
  });
});

describe("record_write lookup hash", () => {
  const base: ToolApprovalRecordWritePayload = {
    op: "create",
    collectionId: "type-1",
    items: [{ data: { name: "Acme" } }],
  };

  test("is deterministic for the same write intent", () => {
    expect(recordWriteLookupHash(base)).toBe(
      recordWriteLookupHash({ ...base }),
    );
  });

  test("ignores volatile display metadata (labels, type name, snapshots)", () => {
    const enriched: ToolApprovalRecordWritePayload = {
      ...base,
      typeName: "Company",
      typeIcon: "i-lucide-building",
      typeColor: "#fff",
      items: [
        {
          data: { name: "Acme" },
          currentLabel: "Acme Corp",
          currentData: { name: "Acme", stale: true },
          collectionKey: "company",
        },
      ],
    };
    expect(recordWriteLookupHash(enriched)).toBe(recordWriteLookupHash(base));
  });

  test("changes when the written data changes", () => {
    const changed: ToolApprovalRecordWritePayload = {
      ...base,
      items: [{ data: { name: "Globex" } }],
    };
    expect(recordWriteLookupHash(changed)).not.toBe(
      recordWriteLookupHash(base),
    );
  });

  test("discriminates ops (create vs delete never collide)", () => {
    const del: ToolApprovalRecordWritePayload = {
      op: "delete",
      items: [{ recordId: "r1" }],
    };
    const create: ToolApprovalRecordWritePayload = {
      op: "create",
      items: [{ recordId: "r1" }],
    };
    expect(recordWriteLookupHash(del)).not.toBe(recordWriteLookupHash(create));
  });

  test("update hash includes merge mode", () => {
    const patch: ToolApprovalRecordWritePayload = {
      op: "update",
      merge: true,
      items: [{ recordId: "r1", data: { x: 1 } }],
    };
    const replace: ToolApprovalRecordWritePayload = {
      op: "update",
      merge: false,
      items: [{ recordId: "r1", data: { x: 1 } }],
    };
    expect(recordWriteLookupHash(patch)).not.toBe(
      recordWriteLookupHash(replace),
    );
  });
});

describe("canonicalHash", () => {
  test("is order-independent over collection keys", () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  test("distinguishes different values", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});
