/**
 * What the compaction summariser actually does, measured against the live
 * model rather than argued about.
 *
 * Each run seeds a conversation of a requested size with `buildLongHistory`
 * (the eval harness's generator, so the shape matches what `lc-recall-*`
 * exercises), calls the real `summariseMessages`, and prints one line per
 * attempt: latency, the size of what came back, and whether it is a summary
 * at all.
 *
 * The needle is the point of the exercise. It is stated once in the oldest
 * assistant turn and the conversation's LAST message asks for it back —
 * which is exactly the arrangement that made five of fifteen production
 * summarisers answer `RCN-8842-QK` instead of summarising. `needleInSummary`
 * says whether the summary carried the fact forward; `answeredInstead` says
 * whether the model replied to the transcript rather than describing it.
 *
 *   bun --env-file=.env run scripts/measure-compaction-summariser.ts \
 *       [historyTokens] [repeats] [logFile]
 */
import { countTokens } from "@fretik/shared/lib/token-estimate";
import type { UIMessage } from "ai";
import { buildLongHistory } from "../evals/history";
import type { SeededTurn } from "../evals/types";
import { flushLangfuse } from "../src/lib/langfuse";
import { ensureModelRegistryWarm } from "../src/lib/model-registry/resolve";
import { summariseMessages } from "../src/services/compaction/summarizer";

const NEEDLE = {
  statement:
    "Le lot de rapprochement de référence porte le code RCN-8842-QK, et l'écart résiduel validé s'élève à 41 328,60 €.",
  expected: "RCN-8842-QK",
} as const;

const FINAL_QUESTION =
  "Quel est le code du lot de rapprochement de référence dont je t'ai parlé plus haut dans cette conversation ? Réponds depuis l'historique, ne relis aucun fichier, et donne uniquement le code.";

/** The eval's seeded turns, in the shape a conversation is persisted in. */
const toUiMessages = (turns: readonly SeededTurn[]): UIMessage[] =>
  turns.map((turn, index) => ({
    id: `seed-${index.toString()}`,
    role: turn.role,
    parts: [
      { type: "text" as const, text: turn.text },
      ...(turn.toolCalls ?? []).map((call) => ({
        type: `tool-${call.toolName}` as const,
        toolCallId: `seed-call-${index.toString()}-${call.toolName}`,
        state: "output-available" as const,
        input: call.input,
        output: call.output,
      })),
    ],
  }));

const targetTokens = Number(Bun.argv[2] ?? "120000");
const repeats = Number(Bun.argv[3] ?? "5");
/**
 * Optional third argument: a file every line is flushed to as it is produced.
 * Bun buffers stdout when it is a pipe, so a run of this length shows nothing
 * at all until it exits — which is no use while it is the thing being waited
 * on.
 */
const logPath = Bun.argv[4];
const sink = logPath ? Bun.file(logPath).writer() : undefined;
const say = (line: string): void => {
  console.log(line);
  if (sink) {
    void sink.write(`${line}\n`);
    void sink.flush();
  }
};

say(`[${new Date().toISOString()}] warming the model registry`);
await ensureModelRegistryWarm();

const history = buildLongHistory({
  seed: "measure",
  targetTokens,
  needle: NEEDLE,
});
const messages: UIMessage[] = [
  ...toUiMessages(history.turns),
  {
    id: "seed-final",
    role: "user",
    parts: [{ type: "text", text: FINAL_QUESTION }],
  },
];
const transcriptTokens = countTokens(JSON.stringify(messages));

say(
  `history target=${targetTokens.toLocaleString()} actual=${transcriptTokens.toLocaleString()} tokens over ${messages.length.toString()} messages; ${repeats.toString()} repeats\n`,
);

const latencies: number[] = [];
let usable = 0;
let carriedNeedle = 0;
let answeredInstead = 0;

for (let attempt = 1; attempt <= repeats; attempt += 1) {
  const startedAt = Date.now();
  const summary = await summariseMessages(messages, undefined);
  const elapsed = Date.now() - startedAt;
  latencies.push(elapsed);
  if (summary === null) {
    say(
      `#${attempt.toString()}  ${(elapsed / 1000).toFixed(1)}s  REJECTED (no usable summary)`,
    );
    continue;
  }
  usable += 1;
  const tokens = countTokens(summary);
  const hasNeedle = summary.includes(NEEDLE.expected);
  if (hasNeedle) carriedNeedle += 1;
  // A summary is prose about a conversation; an answer is the needle and
  // little else. 400 characters separates them by two orders of magnitude.
  const answered = hasNeedle && summary.length < 400;
  if (answered) answeredInstead += 1;
  say(
    `#${attempt.toString()}  ${(elapsed / 1000).toFixed(1)}s  chars=${summary.length.toLocaleString()}  tokens=${tokens.toLocaleString()}  reduction=${Math.round((1 - tokens / transcriptTokens) * 100).toString()}%  needle=${hasNeedle ? "kept" : "LOST"}${answered ? "  ANSWERED-INSTEAD" : ""}`,
  );
}

const sorted = [...latencies].sort((a, b) => a - b);
const p = (q: number): number =>
  (sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ??
    0) / 1000;
say(
  `\nusable ${usable.toString()}/${repeats.toString()}  needle kept ${carriedNeedle.toString()}/${repeats.toString()}  answered-instead ${answeredInstead.toString()}/${repeats.toString()}`,
);
say(
  `latency min=${p(0).toFixed(1)}s p50=${p(0.5).toFixed(1)}s max=${p(1).toFixed(1)}s`,
);

await flushLangfuse();
