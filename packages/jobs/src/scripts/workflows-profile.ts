import db from "@fretik/shared/db";
import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import { getConversationMessages } from "@fretik/shared/services/ai/messages";
import {
  analyzeChains,
  literalsOfStep,
  literalsOfValue,
} from "@fretik/shared/services/trajectory/chains";
import {
  extractTrajectory,
  summarizeTrajectory,
  type TrajectoryStep,
} from "@fretik/shared/services/trajectory/extract";
import {
  detectManualReruns,
  judgeRunEvidence,
  type RunEvidenceReason,
} from "@fretik/shared/services/trajectory/ground-truth";

/**
 * Where does a workflow's time actually go?
 *
 * Tier 0 of the agent-learning plan, and the instrument every later decision
 * is settled with. It reads the trajectories runs already persisted and
 * answers the four questions the plan turns on:
 *
 *   1. Where do the steps go, per task and per tool?
 *   2. How much of that is rereading skills and rediscovering a schema?
 *      That is the direct gain of derived recipes.
 *   3. How many consecutive calls carry nothing from the previous output,
 *      and could therefore become one? That is the gain of fusion.
 *   4. Is there a task whose steps go into judgment rather than mechanics?
 *      If so the lever is the playbook, not a recipe.
 *
 * **Read-only, and aggregate-only.** `SELECT`s and nothing else, and the
 * output is counts, histograms, ratios and truncated hashes. It never prints a
 * tool argument or a tool output: those are the customer's business data, and
 * a run id plus a task key is enough to go and look at one case by hand.
 *
 *   bun run workflows:profile -- --workflow=<id|name> --runs 20 --target=prod
 *
 * On production, prefer running it inside the container — see
 * `docs/AGENT-LEARNING-PLAN.md` §6, which also records the trap that
 * `127.0.0.1:5432` on that host is Langfuse's database, not ours.
 */

const argv = process.argv.slice(2);
/** Accepts both `--flag value` and `--flag=value`. */
const opt = (name: string): string | undefined => {
  const equals = argv.find((a) => a.startsWith(`${name}=`));
  if (equals !== undefined) return equals.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const workflowRef = opt("--workflow");
const runsRaw = Number.parseInt(opt("--runs") ?? "", 10);
const runLimit = Number.isFinite(runsRaw) && runsRaw > 0 ? runsRaw : 20;

if (workflowRef === undefined) {
  console.error(
    "Usage: bun run workflows:profile -- --workflow=<id|name> [--runs 20] [--target=prod]",
  );
  process.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Calls that discover a schema the run could have been handed.
 *
 * A heuristic, and labelled as one in the output: it names the shapes schema
 * discovery takes in our SDK today. It sizes a gain; it decides nothing.
 */
const SCHEMA_DISCOVERY_MARKERS = [
  "describe_collection",
  "list_collections",
  "whoami",
  "describe_schema",
] as const;

const SCHEMA_DISCOVERY_TOOLS = new Set(["describeCollection"]);

const isSchemaDiscovery = (step: TrajectoryStep): boolean =>
  SCHEMA_DISCOVERY_TOOLS.has(step.toolName) ||
  (step.source !== undefined &&
    SCHEMA_DISCOVERY_MARKERS.some((m) => step.source?.includes(m) === true));

const pct = (part: number, whole: number): string =>
  whole === 0 ? "—" : `${((part / whole) * 100).toFixed(0)}%`;

const per = (total: number, runs: number): string =>
  runs === 0 ? "—" : (total / runs).toFixed(1);

const quantile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
};

const heading = (title: string): void => {
  console.info("");
  console.info(`── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
};

// Guarded before the first query. A read-only script still has to say which
// database it read, or its numbers describe nothing in particular — and the
// line it prints is the name the SERVER gives itself, not the URL we believe.
await assertOperatorTarget(Bun.argv);

const workflow = await db.query.workflows.findFirst({
  where: UUID.test(workflowRef)
    ? { id: workflowRef }
    : { name: { ilike: `%${workflowRef}%` } },
});

if (workflow === undefined) {
  console.error(`No workflow matches "${workflowRef}".`);
  process.exit(1);
}

const runs = await db.query.workflowRuns.findMany({
  where: { workflowId: workflow.id },
  orderBy: { createdAt: "desc" },
  limit: runLimit,
});

console.info("");
console.info(
  `workflow ${workflow.id} "${workflow.name}" — ${workflow.playbook.tasks.length.toString()} tasks, deliverable: ${workflow.playbook.deliverable?.format ?? "none declared"}`,
);
console.info(
  `runs examined: ${runs.length.toString()} (newest first, limit ${runLimit.toString()})`,
);

if (runs.length === 0) process.exit(0);

// ---- Which runs may teach -------------------------------------------------
// Failed runs stay in the profile: a run that failed AFTER being handed a
// recipe is the most valuable row there is. They are excluded only from the
// evidence set a recipe would be derived from.
const rerunIds = detectManualReruns(runs);

// One query for every run's refused approvals rather than one per run: this
// script is pointed at production, and a loop of small reads there is a choice
// somebody pays for.
const conversationIds = runs
  .map((r) => r.conversationId)
  .filter((id): id is string => id !== null);
const rejectedRows =
  conversationIds.length === 0
    ? []
    : await db.query.toolApprovalRequests.findMany({
        where: { conversationId: { in: conversationIds }, status: "rejected" },
        columns: { conversationId: true },
      });
const rejectedByConversation = new Map<string, number>();
for (const row of rejectedRows) {
  rejectedByConversation.set(
    row.conversationId,
    (rejectedByConversation.get(row.conversationId) ?? 0) + 1,
  );
}

const evidence = new Map<string, ReturnType<typeof judgeRunEvidence>>();
for (const run of runs) {
  evidence.set(
    run.id,
    judgeRunEvidence({
      runId: run.id,
      status: run.status,
      isTest: run.isTest,
      declaresDeliverable: workflow.playbook.deliverable !== undefined,
      outputCount: run.outputs?.length ?? 0,
      rejectedApprovals:
        run.conversationId === null
          ? 0
          : (rejectedByConversation.get(run.conversationId) ?? 0),
      manualRerunWithinWindow: rerunIds.has(run.id),
    }),
  );
}

const byStatus = new Map<string, number>();
for (const run of runs) {
  byStatus.set(run.status, (byStatus.get(run.status) ?? 0) + 1);
}
const rejections = new Map<RunEvidenceReason, number>();
for (const verdict of evidence.values()) {
  if (verdict.usable) continue;
  rejections.set(verdict.reason, (rejections.get(verdict.reason) ?? 0) + 1);
}
const usableIds = new Set(
  [...evidence.entries()].filter(([, v]) => v.usable).map(([id]) => id),
);

heading("Which runs may teach");
console.info(
  `  status: ${[...byStatus.entries()].map(([s, n]) => `${s} ${n.toString()}`).join(", ")}`,
);
console.info(
  `  usable as evidence: ${usableIds.size.toString()} / ${runs.length.toString()}`,
);
for (const [reason, count] of [...rejections.entries()].sort(
  ([, a], [, b]) => b - a,
)) {
  console.info(`    rejected — ${reason}: ${count.toString()}`);
}

// ---- Read the trajectories ------------------------------------------------
interface ProfiledRun {
  runId: string;
  usable: boolean;
  steps: TrajectoryStep[];
}

const profiled: ProfiledRun[] = [];
/** Per run, what the trigger handed it — those literals are user input. */
const triggerLiterals = new Map<string, Set<string>>();
for (const run of runs) {
  if (run.conversationId === null) continue;
  const messages = await getConversationMessages(run.conversationId);
  const firstTask = run.taskStates[0]?.key;
  profiled.push({
    runId: run.id,
    usable: usableIds.has(run.id),
    steps: extractTrajectory(messages, {
      ...(firstTask !== undefined ? { initialTaskKey: firstTask } : {}),
    }),
  });
  triggerLiterals.set(run.id, literalsOfValue(run.triggerPayload));
}

if (profiled.length === 0) {
  console.info("");
  console.info("No run carries a conversation — nothing to read.");
  process.exit(0);
}

const runCount = profiled.length;
const allSteps = profiled.flatMap((p) => p.steps);
const totals = summarizeTrajectory(allSteps);

// ---- 1. Where the steps go ------------------------------------------------
heading("1. Where the calls go");
const callsPerRun = profiled.map((p) => p.steps.length);
console.info(
  `  tool calls: ${totals.totalCalls.toString()} over ${runCount.toString()} runs — ${per(totals.totalCalls, runCount)}/run (p50 ${quantile(callsPerRun, 0.5).toString()}, p90 ${quantile(callsPerRun, 0.9).toString()})`,
);
console.info("  per tool:");
for (const [tool, count] of Object.entries(totals.perTool).sort(
  ([, a], [, b]) => b - a,
)) {
  console.info(
    `    ${tool.padEnd(24)} ${count.toString().padStart(5)}  ${per(count, runCount).padStart(6)}/run  ${pct(count, totals.totalCalls).padStart(4)}`,
  );
}
console.info("  per task:");
for (const task of totals.perTask) {
  console.info(
    `    ${task.taskKey.padEnd(24)} ${task.calls.toString().padStart(5)}  ${per(task.calls, runCount).padStart(6)}/run  python ${task.pythonCells.toString().padStart(3)}  skills ${task.skillReadCalls.toString().padStart(3)}  errors ${task.errorCalls.toString().padStart(3)}`,
  );
}
console.info(
  `  a task with very few calls per run is where JUDGEMENT lives — question 4.`,
);
console.info(`  there, the lever is the playbook, not a recipe.`);

// ---- 2. Rereading and rediscovery -----------------------------------------
heading("2. What a derived recipe would remove");
const schemaCalls = allSteps.filter(isSchemaDiscovery).length;
console.info(
  `  skill reads:        ${totals.skillReads.calls.toString().padStart(5)}  ${per(totals.skillReads.calls, runCount).padStart(6)}/run  ${pct(totals.skillReads.calls, totals.totalCalls).padStart(4)} of calls  (${totals.skillReads.distinctFiles.toString()} distinct files)`,
);
console.info(
  `  schema discovery:   ${schemaCalls.toString().padStart(5)}  ${per(schemaCalls, runCount).padStart(6)}/run  ${pct(schemaCalls, totals.totalCalls).padStart(4)} of calls  (heuristic, by SDK call shape)`,
);
console.info(
  `  repeats within run: ${totals.redundantCalls.toString().padStart(5)}  ${per(totals.redundantCalls, runCount).padStart(6)}/run  ${pct(totals.redundantCalls, totals.totalCalls).padStart(4)} of calls`,
);

// Calls made identically in EVERY usable run: the same tool with the same
// canonical arguments, every time. This is what a snapshot and a recipe
// replace outright, and it is the single number that sizes tier 1.
const usableRuns = profiled.filter((p) => p.usable);
const identityRuns = new Map<string, Set<string>>();
for (const run of usableRuns) {
  for (const step of run.steps) {
    const key = `${step.toolName} ${step.inputHash}`;
    const seen = identityRuns.get(key) ?? new Set<string>();
    seen.add(run.runId);
    identityRuns.set(key, seen);
  }
}
const everyRun = [...identityRuns.entries()].filter(
  ([, seen]) => usableRuns.length > 1 && seen.size === usableRuns.length,
);
console.info("");
console.info(
  `  identical in EVERY usable run (${usableRuns.length.toString()} runs): ${everyRun.length.toString()} distinct calls`,
);
for (const [key] of everyRun.slice(0, 15)) {
  const [tool = "?", hash = ""] = key.split(" ");
  console.info(`    ${tool.padEnd(24)} args#${hash.slice(0, 8)}`);
}
if (everyRun.length > 15) {
  console.info(`    … and ${(everyRun.length - 15).toString()} more`);
}

// ---- 3. Fusable chains ----------------------------------------------------
heading("3. Consecutive calls that carry nothing forward");

// Which literals belong to the PROCEDURE rather than to one run: those seen in
// at least two runs. A literal that appears in exactly one run of several is
// something the model made up that time — freezing it into a script would
// replay one run's improvisation as if it were the method. A workflow profiled
// over a single run cannot make the distinction, and says so below.
const runsPerLiteral = new Map<string, Set<string>>();
for (const run of profiled) {
  for (const step of run.steps) {
    for (const literal of literalsOfStep(step)) {
      const seen = runsPerLiteral.get(literal) ?? new Set<string>();
      seen.add(run.runId);
      runsPerLiteral.set(literal, seen);
    }
  }
}
const stableLiterals = new Set(
  [...runsPerLiteral.entries()]
    .filter(([, seen]) => seen.size >= 2)
    .map(([literal]) => literal),
);
const crossRunPossible = profiled.length >= 2;

const pythonOnly = new Set(["python"]);
let joins = 0;
let looseFusable = 0;
let strictFusable = 0;
let removable = 0;
let chains = 0;
let pyJoins = 0;
let pyLoose = 0;
let pyStrict = 0;
for (const run of profiled) {
  // Each run's own trigger payload counts as known: a fused script reads those
  // values from `run-params.json` instead of hardcoding them.
  const known = new Set(stableLiterals);
  for (const literal of triggerLiterals.get(run.runId) ?? [])
    known.add(literal);
  const strictOptions = crossRunPossible ? { stableLiterals: known } : {};

  const loose = analyzeChains(run.steps);
  const strict = analyzeChains(run.steps, strictOptions);
  joins += loose.joins.length;
  looseFusable += loose.fusableJoins;
  strictFusable += strict.fusableJoins;
  removable += strict.callsRemovable;
  chains += strict.chains.filter((c) => c.readOnly).length;

  pyJoins += analyzeChains(run.steps, { onlyTools: pythonOnly }).joins.length;
  pyLoose += analyzeChains(run.steps, { onlyTools: pythonOnly }).fusableJoins;
  pyStrict += analyzeChains(run.steps, {
    ...strictOptions,
    onlyTools: pythonOnly,
  }).fusableJoins;
}
console.info(
  `  adjacent same-task pairs:   ${joins.toString().padStart(5)}  carrying nothing forward ${looseFusable.toString().padStart(5)}  ${pct(looseFusable, joins).padStart(4)}`,
);
console.info(
  `    of those, using no literal the model invented:   ${strictFusable.toString().padStart(5)}  ${pct(strictFusable, joins).padStart(4)}`,
);
console.info(
  `  consecutive python cells:   ${pyJoins.toString().padStart(5)}  carrying nothing forward ${pyLoose.toString().padStart(5)}  ${pct(pyLoose, pyJoins).padStart(4)}`,
);
console.info(
  `    of those, using no invented literal:             ${pyStrict.toString().padStart(5)}  ${pct(pyStrict, pyJoins).padStart(4)}`,
);
console.info(
  `  read-only straight chains:  ${chains.toString().padStart(5)}  removing up to ${removable.toString()} calls  ${pct(removable, totals.totalCalls).padStart(4)} of all calls`,
);
if (!crossRunPossible) {
  console.info(
    `  ONE run only — "invented" cannot be told from "hardcoded". The second`,
  );
  console.info(
    `  line repeats the first; profile more runs for a real figure.`,
  );
}
console.info(
  `  an upper bound either way: every candidate still has to reproduce past`,
);
console.info(`  runs exactly before it is served to anything.`);

// ---- 4. What went wrong ---------------------------------------------------
heading("4. Failure and recovery");
console.info(
  `  error calls: ${totals.errorCalls.toString()} (${pct(totals.errorCalls, totals.totalCalls)} of calls), ${per(totals.errorCalls, runCount)}/run`,
);
console.info(
  `  error then same tool again: ${totals.errorThenRetry.toString()}; python cells recovered after a failure: ${totals.pythonCells.recoveredAfterError.toString()}`,
);
for (const [code, count] of Object.entries(totals.perErrorCode).sort(
  ([, a], [, b]) => b - a,
)) {
  console.info(`    ${code.padEnd(28)} ${count.toString().padStart(4)}`);
}
console.info("");
console.info(
  `  tool output fed back into context: ${(totals.outputChars / 1000).toFixed(0)}k chars, ${(totals.outputChars / 1000 / runCount).toFixed(0)}k/run`,
);
console.info(
  `  runs that used a recipe: ${totals.recipeUsed ? "yes" : "none"}`,
);
console.info("");

process.exit(0);
