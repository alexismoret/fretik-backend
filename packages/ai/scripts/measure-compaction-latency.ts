/**
 * Does a user ever WAIT for a compaction?
 *
 * ## The question, and why the eval suite cannot answer it
 *
 * `evals/cases/long-context.ts` seeds a conversation and takes exactly one
 * turn on it. That turn is, by construction, the first this conversation has
 * ever had — so it always finds an over-cap history and no checkpoint, always
 * summarises on the critical path, and always reports the worst TTFT the
 * design can produce. Measured that way the answer is "yes, about 21 seconds",
 * and the answer is an artefact of the harness.
 *
 * Production almost never looks like that. `compactAheadOfNextTurn` runs at
 * the END of a turn, so a conversation that grows gradually is cut while
 * nobody is waiting and the next turn opens on the checkpoint. The
 * critical-path summariser survives only as a fallback: a conversation already
 * over the cap before this code existed, or a background write that failed.
 *
 * So this measures the ONE thing that separates the two designs: turn 1 pays
 * the fallback, turn 2 must not. If turn 2's TTFT is still tens of seconds,
 * the checkpoint is not being read and the whole async design is decoration.
 *
 * `tests/integration/services/compaction/compact-ahead.test.ts` covers the
 * other half — that a turn's END writes a checkpoint and the NEXT window opens
 * on it carrying zero raw rows. Together they say: the first crossing may
 * wait, nothing after it does, and in steady state there is no first crossing.
 *
 * ## Usage
 *
 *   bun --env-file=.env run scripts/measure-compaction-latency.ts [historyTokens] [repeats] [logFile]
 *
 * `AI_SERVICE_URL` selects the arm, so the same script measures a service
 * booted at any `AGENT_CONTEXT_CEILING_TOKENS`.
 *
 * Progress is written to `logFile` through a `Bun.file` sink rather than
 * stdout: Bun buffers stdout on a pipe, so a backgrounded run reports nothing
 * until it exits — and a run that dies reports nothing at all.
 */
import {
  createEphemeralConversation,
  destroyEphemeralConversation,
} from "../evals/conversation-lifecycle";
import { buildLongHistory } from "../evals/history";
import { invokeChatbot } from "../evals/http-client";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

/**
 * Two prompts that cannot be answered from a tool and are cheap to answer, so
 * the number being measured is the PREAMBLE — context load, compaction,
 * message preparation — and not the length of an essay.
 */
const TURN_1 = "En une seule phrase : où en est ce travail ?";
const TURN_2 =
  "Merci. En une seule phrase également : quelle est la prochaine étape ?";

const NEEDLE = {
  statement:
    "Le lot de rapprochement de référence porte le code RCN-8842-QK, et l'écart résiduel validé s'élève à 41 328,60 €.",
  expected: "RCN-8842-QK",
} as const;

const historyTokens = Number(Bun.argv[2] ?? "120000");
const repeats = Number(Bun.argv[3] ?? "3");
const logPath =
  Bun.argv[4] ?? `/tmp/compaction-latency-${Date.now().toString()}.log`;

const sink = Bun.file(logPath).writer();
const say = (line: string): void => {
  // Both return promises this deliberately does not await: the flush is a
  // best-effort "make the log readable while the run is still going", and
  // blocking a measurement on its own logging would put the disk inside the
  // numbers being measured. `sink.end()` at the bottom is what guarantees the
  // bytes land.
  void sink.write(`${line}\n`);
  void sink.flush();
  console.log(line);
};

interface TurnRow {
  repeat: number;
  turn: 1 | 2;
  ttftMs: number | undefined;
  latencyMs: number;
  inputTokens: number | undefined;
  costUsd: number | undefined;
  recoveredNeedle: boolean;
  error: string | undefined;
}

const rows: TurnRow[] = [];

const history = buildLongHistory({
  seed: "latency-probe",
  targetTokens: historyTokens,
  needle: NEEDLE,
});

say(
  `# ${new Date().toISOString()} service=${requireEnv("AI_SERVICE_URL")} history=${history.estimatedTokens.toLocaleString()} tokens repeats=${repeats.toString()}`,
);

for (let repeat = 1; repeat <= repeats; repeat++) {
  const conversationId = await createEphemeralConversation({
    teamId: requireEnv("EVAL_TEAM_ID"),
    organizationId: requireEnv("EVAL_ORGANIZATION_ID"),
    userId: process.env["EVAL_USER_ID"],
    label: `compaction-latency-${repeat.toString()}`,
    prompt: TURN_1,
    history: history.turns,
  });
  try {
    for (const [turn, prompt] of [
      [1, TURN_1],
      [2, TURN_2],
    ] as const) {
      const result = await invokeChatbot(prompt, conversationId);
      rows.push({
        repeat,
        turn,
        ttftMs: result.ttftMs,
        latencyMs: result.latencyMs,
        inputTokens: result.usage?.inputTokens,
        costUsd: result.spend?.costUsd,
        recoveredNeedle: result.text.includes(NEEDLE.expected),
        error: result.error,
      });
      say(
        `repeat=${repeat.toString()} turn=${turn.toString()} ttft=${result.ttftMs === undefined ? "-" : `${(result.ttftMs / 1000).toFixed(1)}s`} total=${(result.latencyMs / 1000).toFixed(1)}s in=${(result.usage?.inputTokens ?? 0).toLocaleString()} steps=${(result.stepsUsed ?? 0).toString()}${result.error ? ` ERROR=${result.error.slice(0, 120)}` : ""}`,
      );
      // The checkpoint is written fire-and-forget after the turn commits, so
      // turn 2 must not start the instant turn 1's stream closes or it races
      // the very write it exists to observe. A real user's think time is far
      // longer than this; three seconds is the smallest pause that makes the
      // measurement about the design rather than about the scheduler.
      if (turn === 1) await Bun.sleep(3_000);
    }
  } finally {
    await destroyEphemeralConversation(conversationId);
  }
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
};

say(`\n## Result (n=${repeats.toString()} per turn)\n`);
say(
  `${"turn".padEnd(6)} ${"ttft p50".padStart(10)} ${"total p50".padStart(10)} ${"input p50".padStart(12)} ${"errors".padStart(7)}`,
);
for (const turn of [1, 2] as const) {
  const mine = rows.filter((r) => r.turn === turn);
  const ttfts = mine
    .map((r) => r.ttftMs)
    .filter((v): v is number => v !== undefined);
  say(
    [
      String(turn).padEnd(6),
      `${(median(ttfts) / 1000).toFixed(1)}s`.padStart(10),
      `${(median(mine.map((r) => r.latencyMs)) / 1000).toFixed(1)}s`.padStart(
        10,
      ),
      median(
        mine
          .map((r) => r.inputTokens)
          .filter((v): v is number => v !== undefined),
      )
        .toLocaleString()
        .padStart(12),
      String(mine.filter((r) => r.error !== undefined).length).padStart(7),
    ].join(" "),
  );
}

const t1 = median(
  rows
    .filter((r) => r.turn === 1)
    .map((r) => r.ttftMs)
    .filter((v): v is number => v !== undefined),
);
const t2 = median(
  rows
    .filter((r) => r.turn === 2)
    .map((r) => r.ttftMs)
    .filter((v): v is number => v !== undefined),
);
say(
  `\nturn 2 is ${t2 === 0 ? "?" : `${(t1 / t2).toFixed(1)}×`} faster to first token than turn 1 (${(t1 / 1000).toFixed(1)}s → ${(t2 / 1000).toFixed(1)}s)`,
);
say(
  `needle recovered on turn 2: ${rows.filter((r) => r.turn === 2 && r.recoveredNeedle).length.toString()}/${repeats.toString()} (informational — turn 2 does not ask for it)`,
);

await sink.end();
process.exit(0);
