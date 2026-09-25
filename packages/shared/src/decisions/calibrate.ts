/**
 * Threshold sweeps over labelled decisions — the arithmetic behind
 * `scripts/decisions-calibrate.ts`, pure so it is tested without a database.
 *
 * The journal's `label` is the TRUE answer, so one set of labels scores every
 * candidate bar. What "good" means differs by family, and the two sweeps say
 * it in their own terms rather than one accuracy number that would hide the
 * asymmetry each bar exists for.
 */

export interface BooleanSample {
  probability: number;
  /** The true answer: did the event really meet the condition? */
  label: boolean;
}

export interface BooleanSweepRow {
  threshold: number;
  /** Refused although the answer was yes: the invisible failure. */
  wrongRefusals: number;
  /** Refused, rightly: the saving. */
  rightRefusals: number;
  /** Let through although the answer was no: a visible, cheap mistake. */
  wrongLaunches: number;
  /** Of the true-yes samples, the share refused. */
  wrongRefusalRate: number;
  /** Of the true-no samples, the share refused. */
  savingRate: number;
}

/**
 * The gate's view. A launch is refused below the bar, and the number that
 * matters most is `wrongRefusalRate`: a run that never happened is one nobody
 * sees, so it is the rate to hold near zero while `savingRate` climbs.
 */
export const sweepBoolean = (
  samples: readonly BooleanSample[],
  thresholds: readonly number[],
): BooleanSweepRow[] => {
  const yes = samples.filter((s) => s.label).length;
  const no = samples.length - yes;
  return thresholds.map((threshold) => {
    let wrongRefusals = 0;
    let rightRefusals = 0;
    let wrongLaunches = 0;
    for (const s of samples) {
      const refused = s.probability < threshold;
      if (refused && s.label) wrongRefusals += 1;
      else if (refused) rightRefusals += 1;
      else if (!s.label) wrongLaunches += 1;
    }
    return {
      threshold,
      wrongRefusals,
      rightRefusals,
      wrongLaunches,
      wrongRefusalRate: yes === 0 ? 0 : wrongRefusals / yes,
      savingRate: no === 0 ? 0 : rightRefusals / no,
    };
  });
};

/** The highest bar whose wrong-refusal rate stays within `maxRate`. */
export const recommendBooleanThreshold = (
  sweep: readonly BooleanSweepRow[],
  maxRate: number,
): number | null => {
  const fitting = sweep.filter((row) => row.wrongRefusalRate <= maxRate);
  if (fitting.length === 0) return null;
  return Math.max(...fitting.map((row) => row.threshold));
};

export interface ChoiceSample {
  confidence: number;
  probability: number | null;
  choice: string;
  /** The true answer: the option that was right. */
  label: string;
}

export interface ChoiceSweepRow {
  threshold: number;
  /** Share of all samples the filer would act on at this bar. */
  coverage: number;
  /** Of those it acts on, the share where its choice was right. */
  precision: number;
  acted: number;
}

/**
 * The filer's view. It acts at or above the bar (and above the chosen-option
 * floor), and what matters is `precision` — a misfiled document is worse than
 * an unfiled one — with `coverage` as the price of each point of it.
 */
export const sweepChoice = (
  samples: readonly ChoiceSample[],
  thresholds: readonly number[],
  minChosenProbability: number,
  /** The "none of these" option: choosing it is never an action. */
  abstainOption: string,
): ChoiceSweepRow[] =>
  thresholds.map((threshold) => {
    let acted = 0;
    let right = 0;
    for (const s of samples) {
      if (s.choice === abstainOption) continue;
      if (s.confidence < threshold) continue;
      if (s.probability !== null && s.probability < minChosenProbability) {
        continue;
      }
      acted += 1;
      if (s.choice === s.label) right += 1;
    }
    return {
      threshold,
      acted,
      coverage: samples.length === 0 ? 0 : acted / samples.length,
      precision: acted === 0 ? 1 : right / acted,
    };
  });

/** The lowest bar whose precision reaches `minPrecision` with something to act on. */
export const recommendChoiceThreshold = (
  sweep: readonly ChoiceSweepRow[],
  minPrecision: number,
): number | null => {
  const fitting = sweep.filter(
    (row) => row.acted > 0 && row.precision >= minPrecision,
  );
  if (fitting.length === 0) return null;
  return Math.min(...fitting.map((row) => row.threshold));
};

/** 0.01 steps between two bounds, rounded so they print and compare clean. */
export const centesimalRange = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let c = Math.round(from * 100); c <= Math.round(to * 100); c += 1) {
    out.push(c / 100);
  }
  return out;
};
