/**
 * Generated conversation histories, sized to a token target.
 *
 * This is the instrument the compaction work had no way to be measured with.
 * Everything downstream of it — the context ceiling, the compaction
 * threshold, the turn boundary, the persisted checkpoint — only fires on a
 * conversation that is already large, and until now no eval could build one:
 * `EvalCase` carried a single `prompt`, so every case was structurally a first
 * turn. See `evals/BACKLOG.md`, which files compaction under "needs a seeded
 * long conversation history".
 *
 * Three properties make the histories below a measurement rather than a mock.
 *
 * **Few messages, each enormous.** Measured on 4 299 production rows
 * (2026-09-17): 355 assistant messages exceed 200 KB and the largest is
 * 32.5 MB — while restricting a conversation to its last 30 messages barely
 * changes how many conversations are heavy (166 → 165 of 745). The weight is
 * not in the message count, it is in a handful of giant messages. That is also
 * a hard constraint here rather than a stylistic choice: every agent window
 * loads the LAST 30 rows (`loadConversationForAgent`), so a history spread
 * over 200 small turns would simply not be read.
 *
 * **The bulk is what nothing can clean.** Filler rides in `python` / `bash`
 * outputs, which are not microcompactable — their results are not
 * re-retrievable, so `microcompactMessages` leaves them verbatim, by design.
 * In production those three tools account for ~8.4 MB of the 17 largest
 * messages. A history padded with `read` output instead would be cut back
 * under the threshold by microcompact alone and would never reach the
 * summariser, which is the component under test.
 *
 * **The answer exists only in old narration.** The needle is stated once, in
 * the assistant's text on the first exchange, and never restated. Text parts
 * survive microcompact and are only ever collapsed by the summariser — so a
 * case that recovers the needle proves the summary carried it, and a case that
 * does not has measured the one failure mode the design cannot avoid by
 * construction (`evals/RUNBOOK.md`: the boundary summary is the single point
 * of failure for accuracy).
 *
 * Generation is deterministic: same arguments → byte-identical history. Two
 * arms of an A/B therefore differ only by the variable under test, repeats are
 * paired, and the provider prompt cache is not defeated by noise.
 */

import { countTokens } from "@fretik/shared/lib/token-estimate";
import type { SeededToolCall, SeededTurn } from "./types";

/**
 * Exchanges (user + assistant) in a generated history.
 *
 * 11 exchanges = 22 rows, leaving room for the case's own prompt inside the
 * 30-row agent window with margin for the steering/summary rows a compacted
 * turn adds back.
 */
const EXCHANGES = 11;

/**
 * `read` calls per assistant turn.
 *
 * 2 × 11 = 22 eligible results. `microcompactMessages` keeps the 5 most
 * recent verbatim and clears in batches of 10 — `floor((22 - 5) / 10) * 10`
 * = the 10 oldest get cleared, deterministically, without relying on the
 * byte-budget override. The needle-bearing turn is the oldest, so its `read`
 * output is always among them: the narration is the only surviving copy.
 */
const READS_PER_TURN = 2;

/**
 * Opening guess for the char budget only — the real size is MEASURED and the
 * budget corrected from it. Kept because a first guess has to come from
 * somewhere, and a wrong one costs an extra pass rather than a wrong history.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Deterministic 32-bit PRNG (mulberry32). Seeded from the case id so a case's
 * filler is stable across arms, repeats and machines — `Math.random()` here
 * would make two arms incomparable and defeat the prompt cache.
 */
const makeRng = (seed: string): (() => number) => {
  let h = 2_166_136_261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const COST_CENTRES = [
  "operations",
  "logistics",
  "procurement",
  "facilities",
  "support",
  "marketing",
  "engineering",
  "finance",
] as const;

const STATUSES = ["settled", "pending", "disputed", "reconciled"] as const;

/**
 * A block of realistic tabular output, grown until it spends `chars`.
 *
 * Deliberately NOT lorem ipsum: the summariser is a model, and a block of
 * meaningless words compresses to nothing, which would make every generated
 * history collapse below the threshold for the wrong reason. Rows here carry
 * plausible, non-repeating business values instead.
 */
const tabularBlock = (rng: () => number, chars: number): string => {
  const lines: string[] = [
    "batch_id,cost_centre,posted_on,amount_eur,status,counterparty_ref",
  ];
  let spent = lines[0]?.length ?? 0;
  let row = 0;
  while (spent < chars) {
    row += 1;
    const centre = COST_CENTRES[Math.floor(rng() * COST_CENTRES.length)];
    const status = STATUSES[Math.floor(rng() * STATUSES.length)];
    const amount = (rng() * 90_000 + 120).toFixed(2);
    const day = String(Math.floor(rng() * 28) + 1).padStart(2, "0");
    const month = String(Math.floor(rng() * 12) + 1).padStart(2, "0");
    const ref = Math.floor(rng() * 1_000_000)
      .toString(36)
      .toUpperCase()
      .padStart(5, "0");
    const line = `B-${String(row).padStart(6, "0")},${centre},2025-${month}-${day},${amount},${status},CP-${ref}`;
    lines.push(line);
    spent += line.length + 1;
  }
  return lines.join("\n");
};

/**
 * What the USER asked for, stated once in their first message and never
 * restated.
 *
 * A different thing from a needle, and the reason it exists separately: a
 * needle is a value, and every summariser prompt in the industry has a section
 * telling the model to keep values verbatim. An objective and a constraint are
 * neither values nor facts about the work — they are the reason the work is
 * being done, they are stated once at the top of a conversation, and
 * Anthropic's own doctrine names exactly this as the expensive loss ("overly
 * aggressive compaction can result in the loss of subtle but critical context
 * whose importance only becomes apparent later"). Nothing measured it here
 * until 2026-09-18.
 */
export interface HistoryIntent {
  /** Appended to the user's FIRST message, verbatim. */
  statement: string;
  /** Every one of these must appear in the final answer. */
  expected: readonly string[];
}

/** The fact a case must recover after the history has been compacted. */
export interface HistoryNeedle {
  /**
   * Stated once, in the assistant's narration on the first exchange. Written
   * as a full sentence so the summariser has something to carry rather than a
   * bare token it may drop as noise.
   */
  statement: string;
  /** What the final answer must contain for the case to pass. */
  expected: string;
}

export interface GeneratedHistory {
  turns: SeededTurn[];
  /** Real token count of the generated rows, in the threshold's own unit. */
  estimatedTokens: number;
}

/**
 * Build a history whose size lands within a few percent of `targetTokens`,
 * counted the way the compaction threshold counts.
 *
 * Sized by MEASUREMENT rather than by a ratio, and the difference is not
 * academic: the filler is CSV-shaped, which tokenises at roughly two characters
 * per token, so the original `targetTokens × 4` sizing produced histories twice
 * as large as their own names claimed. The three cases built on this exist to
 * occupy three different regimes — below the cap, just above it, far above it —
 * and a generator off by 2× collapses them into one.
 *
 * Deterministic despite the loop: the same seed rebuilds the same PRNG stream,
 * the iteration count is fixed, and the correction is a pure function of the
 * measurement, so two arms of an A/B still get byte-identical histories.
 */
export const buildLongHistory = (args: {
  /** Case id — seeds the PRNG. Same id → byte-identical history. */
  seed: string;
  targetTokens: number;
  needle: HistoryNeedle;
  /** Optional objective + constraint, carried in the first user message. */
  intent?: HistoryIntent;
}): GeneratedHistory => {
  // First guess, then two corrections. Scaling is near-linear — the scaffold is
  // fixed and the filler is proportional — so this lands inside a few percent.
  let heavyChars = Math.max(
    2_000,
    Math.floor((args.targetTokens * CHARS_PER_TOKEN * 0.72) / EXCHANGES),
  );
  let built = generateHistory(args, heavyChars);
  for (let pass = 0; pass < 2; pass++) {
    if (built.estimatedTokens === 0) break;
    const correction = args.targetTokens / built.estimatedTokens;
    heavyChars = Math.max(2_000, Math.floor(heavyChars * correction));
    built = generateHistory(args, heavyChars);
  }
  return built;
};

const generateHistory = (
  args: {
    seed: string;
    targetTokens: number;
    needle: HistoryNeedle;
    intent?: HistoryIntent;
  },
  heavyChars: number,
): GeneratedHistory => {
  const rng = makeRng(args.seed);

  // The `read` outputs are sized at a fraction of the heavy block — they exist
  // to be cleared, so paying full price for them would put the post-microcompact
  // size below the threshold and skip the summariser entirely.
  const readChars = Math.max(500, Math.floor(heavyChars * 0.18));

  const turns: SeededTurn[] = [];

  for (let i = 0; i < EXCHANGES; i++) {
    const period = `2025-Q${(i % 4) + 1}`;
    turns.push({
      role: "user",
      text:
        i === 0
          ? `Reprends le rapprochement des écritures ${period} et dis-moi ce qui bloque.${
              args.intent ? ` ${args.intent.statement}` : ""
            }`
          : `Continue sur ${period}, lot ${i + 1} — même traitement que le précédent.`,
    });

    const toolCalls: SeededToolCall[] = [];
    for (let r = 0; r < READS_PER_TURN; r++) {
      toolCalls.push({
        toolName: "read",
        input: { path: `/workspace/ledger/${period}-lot${i + 1}-${r}.csv` },
        output: {
          path: `/workspace/ledger/${period}-lot${i + 1}-${r}.csv`,
          content: tabularBlock(rng, readChars),
        },
      });
    }
    // The uncleanable half. Alternating python/bash mirrors the production
    // mix: both bypass `maybePersistLargeOutput` on their error paths and
    // neither is microcompactable.
    toolCalls.push(
      i % 2 === 0
        ? {
            toolName: "python",
            input: {
              code: `df = pd.read_csv("/workspace/ledger/${period}-lot${i + 1}-0.csv")\nprint(df.to_csv(index=False))`,
            },
            output: { stdout: tabularBlock(rng, heavyChars), stderr: "" },
          }
        : {
            toolName: "bash",
            input: {
              command: `cat /workspace/ledger/${period}-lot${i + 1}-*.csv`,
            },
            output: { stdout: tabularBlock(rng, heavyChars), stderr: "" },
          },
    );

    turns.push({
      role: "assistant",
      text:
        i === 0
          ? `${args.needle.statement} Le lot ${period} est chargé, ${READS_PER_TURN} fichiers lus, je poursuis sur les suivants.`
          : `Lot ${i + 1} (${period}) traité : écritures rapprochées, écarts reportés au lot suivant.`,
      toolCalls,
    });
  }

  // Counted per row, exactly as `estimateMessagesTokens` counts the window it
  // will become — so a target of 120 000 here and a cap of 120 000 there are
  // the same number rather than two numbers written the same way.
  let estimatedTokens = 0;
  for (const turn of turns)
    estimatedTokens += countTokens(JSON.stringify(turn));

  return { turns, estimatedTokens };
};
