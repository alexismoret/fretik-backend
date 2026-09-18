import db from "@fretik/shared/db";
import {
  aiConversationCheckpoints,
  aiMessages,
} from "@fretik/shared/db/schema";
import { loadConversationForAgent } from "@fretik/shared/services/ai/messages";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { boundProfile } from "../../../../tests/lib/live-fleet";
import { mockModule } from "../../../../tests/lib/mock-module";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

/**
 * Compacting AFTER a turn instead of in front of the next one.
 *
 * The sync path put a 20-to-50-second summariser call between a user pressing
 * enter and the first token — once per cut rather than once per message since
 * the checkpoint landed, but once is still once, and it lands on somebody who
 * is waiting. `compactAheadOfNextTurn` runs the identical call from the
 * finished turn's teardown, so the next turn opens on a checkpoint instead.
 *
 * What each test kills if its clause is removed:
 *  - forwarding `maxThresholdTokens: capTokens` → `writes a checkpoint when
 *    the history is over the cap`. Without it the threshold falls back to the
 *    window-derived figure, which on this profile is past 170 000, and a
 *    31 000-token history compacts nothing;
 *  - the RELOAD of the window → `the answer this turn just produced survives
 *    the cut`, which otherwise leaves the next window carrying both a summary
 *    and the messages that summary already folded;
 *  - `persistCheckpoint` itself → `the next window opens on the checkpoint`;
 *  - moving the cut back by the verbatim tail → `the newest messages stay
 *    verbatim and come back as rows`. Leave the cut where it was and the tail
 *    is summarised AND excluded from the next window, which is the one failure
 *    mode of keep-tail that loses a message outright.
 *
 * `does nothing when the history is under the cap` pins the contract rather
 * than a clause, and says so: an early return here would be redundant with
 * `compactConversation`'s own threshold, so there is no line to delete. It was
 * written as a guard first, and the mutation run showed it killed nothing —
 * the guard came out rather than the test staying dishonest about it.
 *
 * The summariser is mocked per file rather than shared: a mutable double
 * reused across files is how one suite's stub leaked into another's
 * assertions (`ai_unit_tests_sandbox_fixture_mocks`).
 */

let fx: MemoryTestFixture;
let conversationId: string;

/** A real derived profile — only its context window is read. */
const profile = boundProfile("minimax-m3");

const seed = async (
  role: "user" | "assistant",
  text: string,
): Promise<{ id: string; seq: number }> => {
  const [row] = await db
    .insert(aiMessages)
    .values({ conversationId, role, parts: [{ type: "text", text }] })
    .returning({ id: aiMessages.id, seq: aiMessages.seq });
  if (!row) throw new Error("failed to seed message");
  return row;
};

const checkpoints = async () =>
  db
    .select()
    .from(aiConversationCheckpoints)
    .where(eq(aiConversationCheckpoints.conversationId, conversationId));

/** ~2 000 tokens of ordinary French prose per call, not a repeated character:
 *  a real tokenizer folds `"x".repeat(n)` far below its character count. */
const bulk = (marker: string): string =>
  `${marker} ` +
  "Le rapprochement du lot a été vérifié ligne à ligne et les écarts reportés au registre. ".repeat(
    120,
  );

const loadCompactAhead = async (summary: string | null) => {
  await mockModule("../../../../src/services/compaction/summarizer", {
    summariseMessages: () => Promise.resolve(summary),
  });
  return import("../../../../src/services/compaction/checkpoint-window");
};

beforeAll(async () => {
  fx = await createMemoryTestFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(async () => {
  conversationId = await fx.createConversation();
});

describe("compactAheadOfNextTurn", () => {
  test("does nothing when the history is under the cap", async () => {
    const { compactAheadOfNextTurn } = await loadCompactAhead(
      "<summary>never used</summary>",
    );
    await seed("user", "Résume-moi le lot 1.");
    await seed("assistant", "Voici le lot 1.");

    await compactAheadOfNextTurn({
      conversationId,
      profile,
      capTokens: 20_000,
      participantIds: [],
      logPrefix: "[test]",
    });

    expect(await checkpoints()).toHaveLength(0);
  });

  test("writes a checkpoint when the history is over the cap", async () => {
    const { compactAheadOfNextTurn } = await loadCompactAhead(
      "<summary>Le lot de référence porte le code RCN-8842-QK.</summary>",
    );
    for (let i = 0; i < 6; i += 1) {
      await seed("user", bulk(`question-${i.toString()}`));
      await seed("assistant", bulk(`réponse-${i.toString()}`));
    }

    await compactAheadOfNextTurn({
      conversationId,
      profile,
      capTokens: 5_000,
      participantIds: [],
      logPrefix: "[test]",
    });

    const rows = await checkpoints();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toContain("RCN-8842-QK");
    expect(rows[0]?.generation).toBe(1);
    expect(rows[0]?.tokensAfter).toBeLessThan(rows[0]?.tokensBefore ?? 0);
  });

  test("the answer this turn just produced survives the cut", async () => {
    // The whole reason the window is RELOADED rather than reused: the sync
    // path reads its window before the turn, so its cut cannot include the
    // turn's own answer. Here the answer has already committed, and the cut
    // must land somewhere that keeps it reachable — never PAST it, which would
    // fold a row the summariser never read.
    const { compactAheadOfNextTurn } = await loadCompactAhead(
      "<summary>handover</summary>",
    );
    for (let i = 0; i < 6; i += 1) {
      await seed("user", bulk(`q${i.toString()}`));
      await seed("assistant", bulk(`a${i.toString()}`));
    }
    const lastAnswer = await seed("assistant", "La réponse finale du tour.");

    await compactAheadOfNextTurn({
      conversationId,
      profile,
      capTokens: 5_000,
      participantIds: [],
      logPrefix: "[test]",
    });

    const rows = await checkpoints();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.upToSeq).toBeLessThanOrEqual(lastAnswer.seq);
    // Reachable, not merely un-folded. The verbatim tail is the reason the cut
    // stops one row short here, and the next window is where that row comes
    // back — asserting the seq alone would pass just as well if it never did.
    const after = await loadConversationForAgent(conversationId, 30);
    const text = after.messages
      .flatMap((m) => m.parts.map((p) => ("text" in p ? p.text : "")))
      .join(" ");
    expect(text).toContain("La réponse finale du tour.");
  });

  test("the next window opens on the checkpoint, not on the history", async () => {
    const { compactAheadOfNextTurn } = await loadCompactAhead(
      "<summary>handover</summary>",
    );
    for (let i = 0; i < 6; i += 1) {
      await seed("user", bulk(`q${i.toString()}`));
      await seed("assistant", bulk(`a${i.toString()}`));
    }
    const before = await loadConversationForAgent(conversationId, 30);
    expect(before.messages.length).toBe(12);
    expect(before.checkpoint).toBeNull();

    await compactAheadOfNextTurn({
      conversationId,
      profile,
      capTokens: 5_000,
      participantIds: [],
      logPrefix: "[test]",
    });

    const after = await loadConversationForAgent(conversationId, 30);
    expect(after.checkpoint).not.toBeNull();
    // Everything under the cut is gone from the window — which is the entire
    // saving, and the reason the next turn has nothing left to summarise.
    // Nothing survives as a verbatim tail here on purpose: every seeded message
    // is ~2 000 tokens and the tail budget at this cap is a quarter of 5 000.
    expect(after.messages).toHaveLength(0);
  });

  test("the newest messages stay verbatim and come back as rows", async () => {
    // Keep-tail, end to end: the summariser sees the head, the tail is left
    // uncut, and the next window reloads it from its own rows — the tail is
    // never copied into the checkpoint, only excluded from it.
    const summarised: number[] = [];
    await mockModule("../../../../src/services/compaction/summarizer", {
      summariseMessages: (messages: { id: string }[]) => {
        summarised.push(messages.length);
        return Promise.resolve("<summary>handover</summary>");
      },
    });
    const { compactAheadOfNextTurn } =
      await import("../../../../src/services/compaction/checkpoint-window");
    for (let i = 0; i < 6; i += 1) {
      await seed("user", bulk(`q${i.toString()}`));
      await seed("assistant", bulk(`a${i.toString()}`));
    }
    const question = await seed("user", "Et le numéro de dossier ?");
    const answer = await seed("assistant", "Dossier RCN-8842-QK, 41 328,60 €.");

    await compactAheadOfNextTurn({
      conversationId,
      profile,
      capTokens: 5_000,
      participantIds: [],
      logPrefix: "[test]",
    });

    const rows = await checkpoints();
    expect(rows).toHaveLength(1);
    // Cut below the tail, so the two short messages are outside the summary.
    expect(rows[0]?.upToSeq).toBeLessThan(question.seq);
    // And the summariser was handed the head only — 14 rows minus the 2 kept.
    expect(summarised).toEqual([12]);

    const after = await loadConversationForAgent(conversationId, 30);
    expect(after.messages.map((m) => m.id)).toEqual([question.id, answer.id]);
  });

  test("a summariser that does not answer leaves no checkpoint and never throws", async () => {
    const { compactAheadOfNextTurn } = await loadCompactAhead(null);
    for (let i = 0; i < 6; i += 1) {
      await seed("user", bulk(`q${i.toString()}`));
      await seed("assistant", bulk(`a${i.toString()}`));
    }

    // The mechanical rung can still produce something here, so the contract
    // this pins is the weaker and more important one: the call resolves, and
    // whatever it wrote is smaller than what it folded. A throw would reach
    // the process — it is called fire-and-forget from a finished turn.
    await compactAheadOfNextTurn({
      conversationId,
      profile,
      capTokens: 5_000,
      participantIds: [],
      logPrefix: "[test]",
    });

    for (const row of await checkpoints()) {
      expect(row.tokensAfter).toBeLessThan(row.tokensBefore);
    }
  });
});
