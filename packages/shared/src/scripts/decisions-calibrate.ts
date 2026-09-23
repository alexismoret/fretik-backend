// oxlint-disable no-await-in-loop
import { and, eq, gte, isNotNull } from "drizzle-orm";
import db from "../db";
import { decisionLog } from "../db/schema";
import {
  centesimalRange,
  recommendBooleanThreshold,
  recommendChoiceThreshold,
  sweepBoolean,
  sweepChoice,
} from "../decisions/calibrate";
import { DECISION_POINT_KEYS, isDecisionPointKey } from "../decisions/keys";
import { decisionPoint } from "../decisions/points";
import { assertOperatorTarget } from "../lib/operator-guard";

/**
 * Sweep each decision point's threshold over its labelled decisions, and say
 * which bar the data supports.
 *
 * Read-only. It prints; changing a bar is a pull request against
 * `decisions/points.ts`, with this output pasted into it — a threshold is a
 * measurement, and this is the measuring.
 *
 * Only answers from the PINNED model (`transport = openrouter`) and the
 * CURRENT question wording count: the gateway's model floats, and two
 * wordings are two instruments whose probabilities share no scale.
 *
 *   cd backend/packages/shared
 *   bun --env-file=../../.env run src/scripts/decisions-calibrate.ts
 *   bun --env-file=../../.env run src/scripts/decisions-calibrate.ts -- --point workflow.gate --days 180
 *
 * Flags: `--point <key>` (default: every point), `--days <n>` (default 90),
 * `--min-labels <n>` (default 30: below it, no recommendation is printed,
 * because a bar moved on twelve samples is a guess with a decimal point).
 */

const flag = (name: string): string | undefined => {
  const at = Bun.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : Bun.argv[at + 1];
};

/** The gate may refuse at most this share of launches that should have run. */
const MAX_WRONG_REFUSAL_RATE = 0.01;
/** The filer must be right at least this often when it acts. */
const MIN_FILING_PRECISION = 0.95;

const percent = (value: number): string => `${(value * 100).toFixed(1)} %`;

await assertOperatorTarget(Bun.argv);

const days = Number(flag("days") ?? "90");
const minLabels = Number(flag("min-labels") ?? "30");
const requested = flag("point");
const points = requested
  ? [requested].filter(isDecisionPointKey)
  : [...DECISION_POINT_KEYS];
if (requested && points.length === 0) {
  throw new Error(`Unknown decision point "${requested}".`);
}
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

for (const key of points) {
  const spec = decisionPoint(key);
  const rows = await db
    .select({
      family: decisionLog.family,
      probability: decisionLog.probability,
      confidence: decisionLog.confidence,
      choice: decisionLog.choice,
      label: decisionLog.label,
    })
    .from(decisionLog)
    .where(
      and(
        eq(decisionLog.point, key),
        eq(decisionLog.questionVersion, spec.questionVersion),
        eq(decisionLog.transport, "openrouter"),
        isNotNull(decisionLog.label),
        gte(decisionLog.createdAt, since),
      ),
    );

  console.log(
    `\n== ${key} (question v${spec.questionVersion.toString()}, last ${days.toString()} days)`,
  );

  for (const [familyKey, family] of Object.entries(spec.families)) {
    const ofFamily = rows.filter((r) => r.family === familyKey);
    console.log(
      `\n-- family "${familyKey}": ${ofFamily.length.toString()} labelled, current bar ${family.threshold.toString()}`,
    );

    if (family.kind === "boolean") {
      const samples = ofFamily.flatMap((r) =>
        r.probability === null || (r.label !== "true" && r.label !== "false")
          ? []
          : [{ probability: r.probability, label: r.label === "true" }],
      );
      const sweep = sweepBoolean(samples, centesimalRange(0.05, 0.5));
      console.log("  bar    wrong refusals   saving");
      for (const row of sweep.filter((_, i) => i % 5 === 0)) {
        console.log(
          `  ${row.threshold.toFixed(2)}   ${percent(row.wrongRefusalRate).padStart(8)}         ${percent(row.savingRate)}`,
        );
      }
      if (samples.length < minLabels) {
        console.log(`  too few labels to recommend a bar.`);
        continue;
      }
      const best = recommendBooleanThreshold(sweep, MAX_WRONG_REFUSAL_RATE);
      console.log(
        best === null
          ? `  no bar keeps wrong refusals under ${percent(MAX_WRONG_REFUSAL_RATE)}.`
          : `  highest bar with wrong refusals <= ${percent(MAX_WRONG_REFUSAL_RATE)}: ${best.toFixed(2)}`,
      );
      continue;
    }

    if (family.kind === "choice") {
      const samples = ofFamily.flatMap((r) =>
        r.confidence === null || r.choice === null || r.label === null
          ? []
          : [
              {
                confidence: r.confidence,
                probability: r.probability,
                choice: r.choice,
                label: r.label,
              },
            ],
      );
      const sweep = sweepChoice(
        samples,
        centesimalRange(0.5, 0.95),
        family.minChosenProbability ?? 0,
        "__root__",
      );
      console.log("  bar    coverage   precision");
      for (const row of sweep.filter((_, i) => i % 5 === 0)) {
        console.log(
          `  ${row.threshold.toFixed(2)}   ${percent(row.coverage).padStart(8)}   ${percent(row.precision)}`,
        );
      }
      if (samples.length < minLabels) {
        console.log(`  too few labels to recommend a bar.`);
        continue;
      }
      const best = recommendChoiceThreshold(sweep, MIN_FILING_PRECISION);
      console.log(
        best === null
          ? `  no bar reaches ${percent(MIN_FILING_PRECISION)} precision.`
          : `  lowest bar with precision >= ${percent(MIN_FILING_PRECISION)}: ${best.toFixed(2)}`,
      );
      continue;
    }

    console.log(`  ${family.kind} families have no sweep yet.`);
  }
}

process.exit(0);
