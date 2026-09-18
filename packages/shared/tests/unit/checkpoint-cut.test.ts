import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  isMutableRow,
  settledAnchors,
  settledCut,
} from "../../src/services/ai/messages";

/**
 * Where a persisted checkpoint is allowed to cut.
 *
 * Two defects hide here and both corrupt a conversation silently rather than
 * loudly, which is why they get a test each rather than a comment.
 *
 * The first is the cut coming from the wrong place. A writer that asked the
 * database for `MAX(seq)` after the turn would summarise past the answer the
 * turn had just produced — `onFinish` persists it at a HIGHER seq — so that
 * answer would land neither in the summary nor in the next window. Perfect
 * amnesia about its own last reply, on every checkpoint. The cut therefore
 * comes from the window the turn READ, and these tests pin the shape of that
 * derivation.
 *
 * The second is cutting across a row that has not settled. Three classes can
 * still change after the turn that read them: a `partial` row (rewritten in
 * place), a row holding an unresolved approval (mutated in place when the user
 * answers), and the current turn's own output (which is not in the window).
 */

const row = (
  seq: number,
  over: Partial<{
    metadata: Record<string, unknown> | null;
    parts: UIMessage["parts"];
  }> = {},
) => ({
  id: `msg-${seq.toString()}`,
  seq,
  metadata: over.metadata ?? null,
  parts: over.parts ?? ([{ type: "text", text: "ok" }] as UIMessage["parts"]),
});

const approvalPart = [
  {
    type: "tool-python",
    toolCallId: "call-1",
    state: "output-available",
    input: {},
    output: { status: "approval_pending", approvalId: "ap-1" },
  },
] as unknown as UIMessage["parts"];

describe("isMutableRow", () => {
  test("a settled assistant row is not mutable", () => {
    expect(isMutableRow(row(1))).toBe(false);
  });

  test("a partial row is mutable — `upsertPartialMessage` rewrites it", () => {
    expect(isMutableRow(row(1, { metadata: { partial: true } }))).toBe(true);
  });

  test("an unresolved approval is mutable, matched by output SHAPE", () => {
    // Never by tool name: `python`, `manageRecord` and the workflow
    // `askUserQuestion` all return this shape, and a name list would go stale
    // the first time a fourth tool joined them.
    expect(isMutableRow(row(1, { parts: approvalPart }))).toBe(true);
  });

  test("a resolved approval is settled again", () => {
    const resolved = [
      {
        type: "tool-python",
        toolCallId: "call-1",
        state: "output-available",
        input: {},
        output: { status: "ok", stdout: "42" },
      },
    ] as unknown as UIMessage["parts"];
    expect(isMutableRow(row(1, { parts: resolved }))).toBe(false);
  });
});

describe("settledCut", () => {
  test("an all-settled window cuts at its last row", () => {
    expect(settledCut([row(10), row(11), row(12)])).toEqual({
      seq: 12,
      messageId: "msg-12",
    });
  });

  test("an empty window has no cut", () => {
    expect(settledCut([])).toBeNull();
  });

  test("a mutable row CLOSES the window, it does not get skipped", () => {
    // The settled row at 13 sits after the pending approval at 12. Cutting at
    // 13 would summarise across a row that is about to change; skipping 12 and
    // cutting at 13 would leave a hole no reader could fill, since a
    // checkpoint is a prefix and everything under it is replaced wholesale.
    const cut = settledCut([
      row(10),
      row(11),
      row(12, { parts: approvalPart }),
      row(13),
    ]);
    expect(cut).toEqual({ seq: 11, messageId: "msg-11" });
  });

  test("a window whose FIRST row is mutable yields no cut at all", () => {
    // `persistCheckpoint` writes nothing in this case. Not writing costs one
    // ordinary history read; writing would cost the pending answer.
    expect(
      settledCut([row(10, { metadata: { partial: true } }), row(11)]),
    ).toBeNull();
  });

  test("the cut never reaches past the window it was given", () => {
    // The guarantee `MAX(seq)` cannot offer. Rows 20+ exist in the table (the
    // turn is about to write them); the window ends at 12, so the cut does.
    const windowRows = [row(10), row(11), row(12)];
    const cut = settledCut(windowRows);
    expect(cut?.seq).toBe(12);
    expect(cut?.seq).toBeLessThan(20);
  });
});

/**
 * The same answer for every prefix — what a checkpoint keeping a verbatim tail
 * cuts at. The caller counts MESSAGES (the compaction tells it how many it kept
 * whole); this is the only thing that turns that count back into a row.
 */
describe("settledAnchors", () => {
  test("each index answers for the prefix ending there", () => {
    expect(settledAnchors([row(10), row(11), row(12)])).toEqual([
      { seq: 10, messageId: "msg-10" },
      { seq: 11, messageId: "msg-11" },
      { seq: 12, messageId: "msg-12" },
    ]);
  });

  test("a mutable row freezes every later answer at the last settled one", () => {
    // Not `null` from there on, and not row 13 either: a checkpoint written for
    // a prefix that reaches past the approval still cuts BELOW it, which is the
    // only cut that neither crosses a mutable row nor leaves a hole.
    expect(
      settledAnchors([
        row(10),
        row(11),
        row(12, { parts: approvalPart }),
        row(13),
      ]),
    ).toEqual([
      { seq: 10, messageId: "msg-10" },
      { seq: 11, messageId: "msg-11" },
      { seq: 11, messageId: "msg-11" },
      { seq: 11, messageId: "msg-11" },
    ]);
  });

  test("nothing settled answers null at every index", () => {
    expect(
      settledAnchors([row(10, { metadata: { partial: true } }), row(11)]),
    ).toEqual([null, null]);
  });

  test("dropping the tail moves the cut back by exactly that many rows", () => {
    // The translation the checkpoint writer performs, in one line: keep the
    // last two verbatim, cut under the third from last.
    const anchors = settledAnchors([row(10), row(11), row(12), row(13)]);
    expect(anchors[anchors.length - 1 - 2]).toEqual({
      seq: 11,
      messageId: "msg-11",
    });
  });
});
