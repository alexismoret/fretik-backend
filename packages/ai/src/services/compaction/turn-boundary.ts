import type { ModelMessage } from "ai";
import { getTurnBoundaryPrompt, getTurnBoundaryResumeMessage } from "./prompt";
import { summariseTranscript } from "./summarizer";

/**
 * Turning a partial turn into one message the same agent can resume from.
 *
 * The context ceiling (`agents/shared/context-ceiling.ts`) ends a turn whose
 * working context grew past the point where accuracy holds. What it leaves
 * behind is a `ModelMessage[]` of everything the loop said and did — the thing
 * that got too big. This module replaces it with a handover and a fresh user
 * turn, which is the only history edit all four providers sanction (nothing
 * signed survives a turn boundary, so no prefix check can reject it).
 *
 * Deliberately NOT here: any edit inside a turn. Pruning the loop's own
 * reasoning is required against Anthropic, returns a 400 on DeepSeek, and is a
 * documented MUST-NOT on Gemini; swapping an old tool result for a marker
 * invalidates every later thinking block under Anthropic's preserved thinking.
 * The boundary exists precisely because those are closed.
 */

/**
 * Past this, a tool payload is truncated in the transcript the summariser
 * reads. A single `read` of a large file can be tens of thousands of
 * characters, and the summariser's job is to record THAT the file was read and
 * what it established — not to carry it. The tail is kept as well as the head:
 * a stack trace's last line is the error, and section 3 of the boundary prompt
 * is the one that decides whether the resumed agent converges.
 */
const TOOL_PAYLOAD_HEAD = 2_000;
const TOOL_PAYLOAD_TAIL = 1_000;

const bounded = (value: string): string =>
  value.length <= TOOL_PAYLOAD_HEAD + TOOL_PAYLOAD_TAIL
    ? value
    : `${value.slice(0, TOOL_PAYLOAD_HEAD)}\n…[${(value.length - TOOL_PAYLOAD_HEAD - TOOL_PAYLOAD_TAIL).toString()} chars elided]…\n${value.slice(-TOOL_PAYLOAD_TAIL)}`;

const stringify = (value: unknown): string => {
  if (typeof value === "string") return bounded(value);
  try {
    return bounded(JSON.stringify(value) ?? "null");
  } catch {
    return "[unserialisable]";
  }
};

/**
 * One message, flattened to what the summariser needs: text, the calls the
 * model made, and what came back. Reasoning is dropped — it is what the
 * boundary discards, and replaying it here would put the accumulation we are
 * removing straight back into the summariser's own prompt.
 */
const flatten = (message: ModelMessage): string => {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  const fragments: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      fragments.push(part.text);
      continue;
    }
    if (part.type === "tool-call") {
      fragments.push(`[tool-call:${part.toolName}] ${stringify(part.input)}`);
      continue;
    }
    if (part.type === "tool-result") {
      const output = part.output;
      fragments.push(
        `[tool-result:${part.toolName}] ${
          "value" in output ? stringify(output.value) : output.type
        }`,
      );
    }
  }
  return fragments.join("\n").trim();
};

/**
 * Role-prefixed blocks for the summariser, one per message that carries
 * anything. Mirrors `serialiseMessageBlocks` for the `UIMessage` side.
 */
export const serialiseModelMessageBlocks = (
  messages: readonly ModelMessage[],
): string[] =>
  messages
    .map((m) => {
      const body = flatten(m);
      return body.length > 0 ? `[${m.role}] ${body}` : "";
    })
    .filter((block) => block.length > 0);

/**
 * A boundary must leave the context at most this fraction of what it was.
 *
 * The invariant the whole ladder exists to hold. Without it "a boundary
 * happened" and "the context got smaller" are different statements, and a
 * caller that loops on the first while the second is false loops forever at
 * full price. 0.5 is chosen so that N boundaries bound the context
 * geometrically rather than by a counter — which is what lets the magic
 * counters go.
 */
export const BOUNDARY_MAX_RATIO = 0.5;

/**
 * Hard budget for the last rung. Roughly a tenth of the default ceiling: the
 * resumed agent needs enough to know what it was doing, and a rung that has
 * given up on understanding the transcript should not be generous about it.
 */
const TRUNCATION_BUDGET_CHARS = 40_000;

export type BoundaryKind = "llm" | "mechanical" | "truncated";

export interface TurnBoundaryResume {
  message: ModelMessage;
  kind: BoundaryKind;
  charsBefore: number;
  charsAfter: number;
}

/**
 * A summary with no model in it.
 *
 * Everything in it is a FACT about the transcript rather than a reading of it:
 * which tools were called and how often, which calls failed and with what
 * error verbatim, which paths were mentioned, and the last few exchanges as
 * they stand. That is a weaker handover than the summariser's five sections,
 * and it is a handover — which is the entire difference between this rung and
 * no boundary at all.
 *
 * It carries the errors verbatim on purpose: section 3 of the boundary prompt
 * ("what was tried and how it failed") is the one that decides whether the
 * resumed agent converges or repeats itself, and it is the one section a
 * mechanical pass can reproduce exactly.
 */
export const mechanicalSummary = (
  blocks: readonly string[],
  verbatimBudget: number,
): string => {
  const toolCalls = new Map<string, number>();
  const failures: string[] = [];
  const paths = new Set<string>();
  for (const block of blocks) {
    for (const match of block.matchAll(/\[tool-call:([A-Za-z0-9_]+)\]/g)) {
      const name = match[1];
      if (name) toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
    }
    for (const match of block.matchAll(
      /"(?:error|code)"\s*:\s*"([^"]{1,200})"/g,
    )) {
      const value = match[1];
      if (value && !failures.includes(value)) failures.push(value);
    }
    for (const match of block.matchAll(
      /(?:\/workspace\/|attachments\/|outputs\/)[\w./-]{1,120}/g,
    )) {
      paths.add(match[0]);
    }
  }

  const sections: string[] = [
    "## What happened so far (reconstructed without a summariser — the summariser was unavailable)",
  ];
  if (toolCalls.size > 0) {
    sections.push(
      `### Tools used\n${[...toolCalls.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `- ${name} ×${count.toString()}`)
        .join("\n")}`,
    );
  }
  if (failures.length > 0) {
    sections.push(
      `### Failures, verbatim — do not retry these the same way\n${failures
        .slice(0, 20)
        .map((f) => `- ${f}`)
        .join("\n")}`,
    );
  }
  if (paths.size > 0) {
    sections.push(
      `### Files touched\n${[...paths]
        .slice(0, 40)
        .map((p) => `- ${p}`)
        .join("\n")}`,
    );
  }
  // BOUNDED, and that is not a detail: an unbounded "last four exchanges"
  // reproduces the whole transcript on a turn made of few, enormous messages —
  // which is precisely the shape the production measurement found. This rung
  // then returns something LARGER than what it folded and the ladder drops to
  // truncation for no reason.
  sections.push(
    `### The last exchanges, verbatim\n${clampTail(blocks, verbatimBudget)}`,
  );
  return sections.join("\n\n");
};

/** As many trailing blocks as fit, newest first, each one head-and-tailed. */
const clampTail = (blocks: readonly string[], budget: number): string => {
  const kept: string[] = [];
  let spent = 0;
  for (let i = blocks.length - 1; i >= 0 && spent < budget; i -= 1) {
    const block = blocks[i];
    if (block === undefined) continue;
    const room = budget - spent;
    const piece =
      block.length <= room
        ? block
        : `${block.slice(0, Math.floor(room / 2))}\n…[elided]…\n${block.slice(-Math.floor(room / 2))}`;
    kept.unshift(piece);
    spent += piece.length;
  }
  return kept.join("\n\n");
};

/**
 * The last rung: head and tail of the transcript, nothing understood.
 *
 * Its budget is RELATIVE, not the fixed `TRUNCATION_BUDGET_CHARS` alone. A
 * fixed budget fails the invariant exactly when it matters least and most: on
 * a 60 000-character transcript, 40 000 is a two-thirds cut, which is a
 * reduction and not a halving — so the rung that exists to always succeed
 * would be rejected, and the caller would end a turn that a slightly harder
 * cut would have continued.
 */
const truncatedSummary = (
  blocks: readonly string[],
  budget: number,
): string => {
  const joined = blocks.join("\n\n");
  if (joined.length <= budget) return joined;
  // The marker counts against the budget. Leaving it out is how a last rung
  // that is supposed to ALWAYS satisfy the invariant misses it by forty
  // characters and hands the caller a `null` it has no answer for.
  const marker = (dropped: number): string =>
    `\n\n[… ${dropped.toLocaleString()} characters of transcript dropped …]\n\n`;
  const half = Math.max(
    0,
    Math.floor((budget - marker(joined.length).length) / 2),
  );
  if (half === 0) return joined.slice(0, Math.max(0, budget));
  return `${joined.slice(0, half)}${marker(joined.length - 2 * half)}${joined.slice(-half)}`;
};

/**
 * Fold a cut turn into one message the same agent can resume from, descending
 * a ladder until something actually REDUCES.
 *
 * Three rungs, in order: the summariser; a mechanical summary derived from the
 * transcript with no model in it; a hard head-and-tail truncation. Each is
 * measured against `BOUNDARY_MAX_RATIO` and rejected if it did not reduce
 * enough, so the caller's contract is not "a boundary ran" but "the context is
 * at most half what it was".
 *
 * This is the failure Claude Code has open and unresolved (issues #26220,
 * #26317, #30401): auto-compaction, `/compact` and rewind all fail TOGETHER at
 * the context limit, because they compact at ~95 % of the window and the
 * summariser then has no room to run. Two things keep us out of it — the
 * ceiling fires at an absolute 100 000 rather than at a fraction of the
 * window, so there is always room; and when the summariser fails anyway, the
 * rungs below it need no model at all. The remedies proposed on those issues
 * are exactly these two ("reserving headroom for the compaction prompt", "a
 * fallback compaction strategy like aggressive truncation").
 *
 * `null` still means "no boundary": the transcript was empty, or not even
 * truncation got under the ratio. The caller keeps what it had and ends the
 * turn — which is honest, and bounded, and not a loop.
 */
export const buildTurnBoundaryResume = async (params: {
  /** The partial turn to fold away — everything the loop produced. */
  messages: readonly ModelMessage[];
  /** Team whose workhorse pick the summariser honours (C8b). */
  teamId: string | undefined;
  logPrefix: string;
}): Promise<TurnBoundaryResume | null> => {
  const blocks = serialiseModelMessageBlocks(params.messages);
  if (blocks.length === 0) return null;
  const charsBefore = blocks.reduce((sum, b) => sum + b.length, 0);

  const accept = (
    summary: string,
    kind: BoundaryKind,
  ): TurnBoundaryResume | null => {
    const content = getTurnBoundaryResumeMessage(summary);
    if (content.length > charsBefore * BOUNDARY_MAX_RATIO) {
      console.warn(
        `${params.logPrefix} context boundary: ${kind} rung did not reduce enough (${charsBefore.toString()} → ${content.length.toString()}), descending`,
      );
      return null;
    }
    console.info(
      `${params.logPrefix} context boundary: ${kind} rung reduced ${charsBefore.toString()} → ${content.length.toString()} chars over ${blocks.length.toString()} blocks`,
    );
    return {
      message: { role: "user", content },
      kind,
      charsBefore,
      charsAfter: content.length,
    };
  };

  const startedAt = Date.now();
  const summary = await summariseTranscript({
    blocks,
    instruction: getTurnBoundaryPrompt(),
    teamId: params.teamId,
  });
  if (summary !== null) {
    const accepted = accept(summary, "llm");
    if (accepted) {
      console.info(
        `${params.logPrefix} context boundary: summariser took ${(Date.now() - startedAt).toString()}ms`,
      );
      return accepted;
    }
  } else {
    console.warn(
      `${params.logPrefix} context boundary: summariser failed, falling back to a mechanical summary`,
    );
  }

  // What a rung may spend and still satisfy the invariant, net of the fixed
  // resume-message wrapper. Measured rather than guessed: the wrapper is prose
  // from `prompt.ts` and would drift under an edit there.
  const wrapper = getTurnBoundaryResumeMessage("").length;
  const budget = Math.floor(charsBefore * BOUNDARY_MAX_RATIO) - wrapper;
  if (budget <= 0) return null;

  return (
    accept(mechanicalSummary(blocks, Math.floor(budget / 2)), "mechanical") ??
    accept(
      truncatedSummary(blocks, Math.min(TRUNCATION_BUDGET_CHARS, budget)),
      "truncated",
    )
  );
};
