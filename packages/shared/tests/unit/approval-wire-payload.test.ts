import { describe, expect, test } from "bun:test";
import type {
  ToolApprovalPayload,
  ToolApprovalRecordWriteItem,
  ToolApprovalRecordWritePayload,
} from "../../src/db/schema";
import {
  RECORD_PREVIEW_LIMIT,
  RECORD_SUMMARY_SAMPLE,
  toWirePayload,
} from "../../src/services/approvals/to-wire-payload";

/**
 * `toWirePayload` is the single choke point between a stored approval and the
 * browser. Three properties carry the whole design and each fails silently:
 * it must never widen a payload (the grant reads the STORED one, so a wire-side
 * mutation would be invisible until a record was written wrong), it must leave
 * the other kinds untouched, and it must cut at exactly the documented limit —
 * the card decides it is looking at a slice by comparing `itemCount` against
 * the length this function returns.
 */

const item = (n: number): ToolApprovalRecordWriteItem => ({
  data: { name: `Record ${String(n)}`, index: n },
});

const recordWrite = (count: number): ToolApprovalRecordWritePayload => ({
  op: "create",
  collectionKey: "client",
  collectionId: "11111111-1111-7111-8111-111111111111",
  items: Array.from({ length: count }, (_, i) => item(i)),
});

describe("toWirePayload — record_write truncation", () => {
  test("passes a payload at the limit through untouched", () => {
    const payload = recordWrite(RECORD_PREVIEW_LIMIT);
    expect(toWirePayload(payload)).toBe(payload);
  });

  test("drops to the sample size one item above the limit", () => {
    // The two constants do different jobs: crossing RECORD_PREVIEW_LIMIT
    // switches the card to its summary form, and a summary carries a SAMPLE —
    // not a slightly shorter list.
    const wire = toWirePayload(recordWrite(RECORD_PREVIEW_LIMIT + 1));
    expect(wire).not.toBeNull();
    expect((wire as ToolApprovalRecordWritePayload).items).toHaveLength(
      RECORD_SUMMARY_SAMPLE,
    );
  });

  test("keeps the FIRST items, so the sample is the head of the list", () => {
    const wire = toWirePayload(
      recordWrite(500),
    ) as ToolApprovalRecordWritePayload;
    expect(wire.items[0]?.data?.["index"]).toBe(0);
    expect(wire.items.at(-1)?.data?.["index"]).toBe(RECORD_SUMMARY_SAMPLE - 1);
  });

  test("a 200k-row import ships a kilobyte-scale payload, not a megabyte one", () => {
    const wire = toWirePayload(recordWrite(200_000));
    expect(JSON.stringify(wire).length).toBeLessThan(2_000);
  });

  test("carries the display metadata the summary card renders", () => {
    const wire = toWirePayload(
      recordWrite(5_000),
    ) as ToolApprovalRecordWritePayload;
    expect(wire.op).toBe("create");
    expect(wire.collectionKey).toBe("client");
    expect(wire.collectionId).toBe("11111111-1111-7111-8111-111111111111");
  });

  test("never mutates the stored payload — the grant executes from it", () => {
    const payload = recordWrite(5_000);
    toWirePayload(payload);
    expect(payload.items).toHaveLength(5_000);
  });
});

describe("toWirePayload — every other kind is untouched", () => {
  test("null stays null", () => {
    expect(toWirePayload(null)).toBeNull();
  });

  test("a question payload is returned as-is", () => {
    const payload: ToolApprovalPayload = {
      questions: [
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Staging", description: "Safe" },
            { label: "Production", description: "Live" },
          ],
          multiSelect: false,
        },
      ],
    };
    expect(toWirePayload(payload)).toBe(payload);
  });

  test("a tool_call payload is returned as-is, however fat its args", () => {
    const payload: ToolApprovalPayload = {
      toolName: "manageDrive",
      args: { body: "x".repeat(100_000) },
    };
    expect(toWirePayload(payload)).toBe(payload);
  });
});
