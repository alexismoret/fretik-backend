/**
 * Every decision point in the product, by key.
 *
 * Separate from the registry (`./points.ts`) so the wire schema can validate a
 * key without importing the registry, which imports the fact catalogue, which
 * imports the database types — a chain no protocol file should drag behind it.
 *
 * A key names a JOB, not a model call: `workflow.gate` is "should this firing
 * run?", however many workflows one call asks it for. Adding a point is adding
 * it here AND in `DECISION_POINTS`; the registry test fails on either alone.
 */
export const DECISION_POINT_KEYS = [
  "workflow.gate",
  "drive.file",
  "memory.consolidate.prescreen",
  "memory.resolve.verify",
  "graph.link-type-match",
] as const;

export type DecisionPointKey = (typeof DECISION_POINT_KEYS)[number];

const KEYS: ReadonlySet<string> = new Set(DECISION_POINT_KEYS);

export const isDecisionPointKey = (value: string): value is DecisionPointKey =>
  KEYS.has(value);
