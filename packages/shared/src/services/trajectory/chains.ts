/**
 * Straight chains — the mechanical form of "those five calls should have been
 * one", with no model anywhere in it.
 *
 * The rule comes from TraceCompiler's def-use analysis, and it is one
 * sentence: **a call that uses a value it could only have learned from the
 * previous call's output is a call the model made a decision in front of.**
 * Fusing it away would delete that decision. A call that uses nothing new is a
 * continuation, and a run of such calls is a straight chain, which one script
 * can replace.
 *
 * So the test for each adjacent pair is: does the later call contain a literal
 * that appears in the earlier call's output and was NOT already in the earlier
 * call's own input? If yes, the pair is a join the model looked at, and the
 * chain breaks there. If no, the pair is fusable.
 *
 * **What this is, and is not.** It is a MEASUREMENT: it answers "how much of
 * this run could collapse?" so the question of whether to build the fusion
 * tier can be decided on our own corpus rather than on a published one. It is
 * not a gate and not a safety boundary. What actually authorises a fusion is
 * the replay — running the candidate against the inputs of past successful
 * runs and demanding it reproduce their output — and what contains a write is
 * `/sandbox/exec` plus the approval flow, never a literal scan. Both of those
 * live a tier later, deliberately.
 *
 * Its error direction is chosen on purpose. Missing a carried literal makes a
 * pair look fusable when it is not, so every lever it feeds is conservative in
 * the other direction: minimum literal length, the write evidence below, and
 * above all the replay gate, which discards a candidate that does not
 * reproduce history exactly.
 */

import type { TrajectoryStep } from "./extract";

/**
 * Shortest literal worth tracking.
 *
 * A two-character literal collides with something in almost any JSON output,
 * and a run of false joins reads as "nothing is fusable" — the failure mode
 * that would quietly kill the tier this measures. Four characters keeps
 * identifiers, slugs, uuids and long numeric ids, and drops `id`, `50`, `en`
 * and the punctuation of an argument list. Collection keys shorter than this
 * are missed, which is the optimistic direction, which is why the replay gate
 * exists.
 */
export const MIN_LITERAL_CHARS = 4;

/**
 * Evidence, found in the trajectory itself, that a call wrote something.
 *
 * Deliberately evidence and not an allow-list: an allow-list of "safe" tool
 * names is a list that goes stale silently, and this module would be the last
 * place to notice. These markers are the shapes a write takes on its way out —
 * the external-app op builder, the plan runner, the bulk record paths, a
 * workbook being saved, an upload. Their purpose is to keep a write chain out
 * of an ESTIMATE of what could be collapsed; nothing here prevents anything.
 */
const WRITE_SOURCE_MARKERS = [
  ".op(",
  "run_plan",
  "bulk_create",
  "bulk_update",
  "bulk_delete",
  "bulk_upsert",
  ".save(",
  "upload",
] as const;

/** The output shape of a call parked on a human approval — always a write. */
const APPROVAL_PENDING = "approval_pending";

/**
 * The harness's own progression mechanism, and a write: it commits the run's
 * task states.
 *
 * Named here rather than left to the caller's `writeTools` because it is not a
 * tool like the others — this module already reads its output to follow the
 * task cursor, so the protocol is not something it could avoid knowing about.
 * Without it a two-call task reads as a fusable chain and the estimate counts
 * the act of closing the task as work a script could do.
 */
const PROTOCOL_WRITE_TOOLS = new Set(["completeTask"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * String and long-number literals of a program, by a scan rather than a
 * regular expression: the input is arbitrary agent-written source, and a
 * backtracking pattern over it is a hang waiting for an unlucky run.
 */
const sourceLiterals = (source: string): string[] => {
  const found: string[] = [];
  /** The source with every quoted run removed — where bare numbers live. */
  let code = "";
  let i = 0;
  let plainFrom = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch !== "'" && ch !== '"') {
      i++;
      continue;
    }
    code += source.slice(plainFrom, i);
    const triple = source.slice(i, i + 3);
    const closer = triple === ch.repeat(3) ? triple : ch;
    const start = i + closer.length;
    let j = start;
    while (j < source.length) {
      if (source[j] === "\\") {
        j += 2;
        continue;
      }
      if (source.startsWith(closer, j)) break;
      j++;
    }
    found.push(source.slice(start, Math.min(j, source.length)));
    i = j + closer.length;
    plainFrom = i;
  }
  code += source.slice(plainFrom);
  // Numbers are scanned OUTSIDE the quoted runs only. Scanning the whole
  // source instead finds the `9031` inside `'f-9031ba7c'` and reports one
  // binding as two — and worse, lets an unrelated four-digit run inside a
  // string join two cells that share nothing.
  for (const match of code.matchAll(/\d{4,}/g)) found.push(match[0]);
  return found;
};

/** String values and long numbers of a structured tool input. */
const jsonLiterals = (value: unknown, depth = 0): string[] => {
  if (depth > 8) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) {
    return value.flatMap((v) => jsonLiterals(v, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((v) => jsonLiterals(v, depth + 1));
  }
  return [];
};

/**
 * What a call's arguments say, as literals.
 *
 * A `python` cell's argument is a whole program, so walking its JSON would
 * yield one enormous string that matches nothing; its literals are scanned out
 * of the source instead.
 */
export const literalsOfStep = (step: TrajectoryStep): Set<string> => {
  const raw =
    step.source !== undefined
      ? sourceLiterals(step.source)
      : jsonLiterals(step.input);
  return new Set(raw.filter((lit) => lit.length >= MIN_LITERAL_CHARS));
};

/**
 * The same literal vocabulary, read out of an arbitrary value — a trigger
 * payload, say.
 *
 * Exported beside {@link literalsOfStep} so a caller assembling the
 * `stableLiterals` set uses the DEFINITION the analysis will compare against.
 * Two slightly different notions of "a literal" on the two sides of that set
 * would make known values look invented, and the mismatch would show up as a
 * plausible-looking number rather than as an error.
 */
export const literalsOfValue = (value: unknown): Set<string> =>
  new Set(jsonLiterals(value).filter((lit) => lit.length >= MIN_LITERAL_CHARS));

const serialize = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

/** Did this call leave evidence of having written something? */
const observedWrite = (
  step: TrajectoryStep,
  writeTools: ReadonlySet<string>,
): boolean => {
  if (PROTOCOL_WRITE_TOOLS.has(step.toolName)) return true;
  if (writeTools.has(step.toolName)) return true;
  if (serialize(step.output).includes(APPROVAL_PENDING)) return true;
  const source = step.source;
  if (source === undefined) return false;
  return WRITE_SOURCE_MARKERS.some((marker) => source.includes(marker));
};

/** One adjacent pair of calls, and whether the later one made a decision. */
export interface ChainJoin {
  fromIndex: number;
  toIndex: number;
  /**
   * Literals of the later call that first appear in the earlier call's output:
   * the model READ the result before writing this call.
   * Business data — count them, do not print them.
   */
  carried: string[];
  /**
   * Literals the later call uses that came from nowhere the analysis can see —
   * present only when `stableLiterals` was supplied. The model INVENTED them,
   * so freezing them into a script would replay one run's improvisation as if
   * it were the procedure. Same data rule as `carried`.
   */
  invented: string[];
  /** True when the later call carried nothing and invented nothing. */
  fusable: boolean;
}

/** A maximal run of consecutive calls joined only by fusable pairs. */
export interface StraightChain {
  taskKey?: string;
  /** `TrajectoryStep.index` of each call, in order. */
  stepIndexes: number[];
  toolNames: string[];
  /**
   * True when no call in the chain left evidence of a write. Only these are
   * counted as collapsible — and even they are only a candidate for the
   * replay gate, never a decision.
   */
  readOnly: boolean;
}

export interface ChainAnalysis {
  /** Adjacent same-task pairs examined. */
  joins: ChainJoin[];
  /** Pairs carrying nothing from the previous output. */
  fusableJoins: number;
  chains: StraightChain[];
  /**
   * Calls that would disappear if every read-only chain of two or more became
   * a single call. The headline estimate, and an upper bound: the replay gate
   * will reject some of these.
   */
  callsRemovable: number;
}

export interface ChainOptions {
  /**
   * Tool names the caller knows to write. The AI package can pass the registry
   * it already derives for compaction; `shared` cannot import it, and guessing
   * a list here would be a list that goes stale in silence.
   */
  writeTools?: ReadonlySet<string>;
  /**
   * Restrict the analysis to these tools. The plan's question 3 asks it of
   * consecutive `python` cells; leaving this unset asks it of every call.
   */
  onlyTools?: ReadonlySet<string>;
  /**
   * Literals that are part of the PROCEDURE rather than of this one run: the
   * ones seen in other runs of the same workflow, plus this run's trigger
   * payload. Supplying them turns on the third category.
   *
   * Without it the analysis knows two kinds of literal — carried from the
   * previous output, or not — and everything in the second kind reads as a
   * continuation. Measured on a real workflow, that reported 98% of adjacent
   * pairs as fusable, because sixty-six web searches whose queries the model
   * had made up on the spot each carried nothing from the one before. They
   * carried nothing because they came from the model's own reasoning, and
   * freezing them into a script would replay one run's improvisation as the
   * procedure.
   *
   * With the set supplied, a literal that is neither carried nor known is
   * INVENTED, and an invented literal breaks the chain. A hardcoded constant
   * of the workflow appears in every run, so it stays known and stays fusable —
   * which is the distinction that matters and the one a single run cannot make.
   */
  stableLiterals?: ReadonlySet<string>;
}

/**
 * Find the straight chains of a trajectory.
 *
 * Two calls are adjacent only inside the same task: a task boundary is a
 * boundary of intent, and a chain that crossed one would propose fusing work
 * the playbook separated on purpose.
 */
export const analyzeChains = (
  steps: readonly TrajectoryStep[],
  options: ChainOptions = {},
): ChainAnalysis => {
  const writeTools = options.writeTools ?? new Set<string>();
  const considered = steps.filter(
    (s) => options.onlyTools === undefined || options.onlyTools.has(s.toolName),
  );

  const joins: ChainJoin[] = [];
  const chains: StraightChain[] = [];
  let current: TrajectoryStep[] = [];

  const flush = (): void => {
    if (current.length >= 2) {
      const first = current[0];
      chains.push({
        ...(first?.taskKey !== undefined ? { taskKey: first.taskKey } : {}),
        stepIndexes: current.map((s) => s.index),
        toolNames: current.map((s) => s.toolName),
        readOnly: !current.some((s) => observedWrite(s, writeTools)),
      });
    }
    current = [];
  };

  for (let i = 0; i < considered.length; i++) {
    const earlier = considered[i];
    const later = considered[i + 1];
    if (earlier === undefined) continue;
    if (current.length === 0) current.push(earlier);
    if (later === undefined) break;

    // A task boundary ends the chain whatever the literals say.
    if (earlier.taskKey !== later.taskKey) {
      flush();
      continue;
    }

    const producedHere = serialize(earlier.output);
    const alreadyInHand = serialize(earlier.source ?? earlier.input);
    const literals = [...literalsOfStep(later)];
    const carried = literals.filter(
      (lit) => producedHere.includes(lit) && !alreadyInHand.includes(lit),
    );
    // Only when the caller supplied what the procedure's own literals are.
    // Without that, a literal from nowhere is indistinguishable from a
    // hardcoded constant, and calling it a decision would be a guess.
    const known = options.stableLiterals;
    const invented =
      known === undefined
        ? []
        : literals.filter(
            (lit) =>
              !known.has(lit) &&
              !carried.includes(lit) &&
              !alreadyInHand.includes(lit),
          );
    const fusable = carried.length === 0 && invented.length === 0;
    joins.push({
      fromIndex: earlier.index,
      toIndex: later.index,
      carried,
      invented,
      fusable,
    });
    if (fusable) current.push(later);
    else flush();
  }
  flush();

  const callsRemovable = chains
    .filter((c) => c.readOnly)
    .reduce((total, c) => total + c.stepIndexes.length - 1, 0);

  return {
    joins,
    fusableJoins: joins.filter((j) => j.fusable).length,
    chains,
    callsRemovable,
  };
};
