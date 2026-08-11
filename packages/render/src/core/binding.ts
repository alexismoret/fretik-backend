import { z } from "zod";

/**
 * The `$` binding — our expression vocabulary, registered with json-render as
 * a custom directive.
 *
 * json-render ships its own dynamic values (`$state`, `$cond`, `$template`,
 * `$computed`), but they are path lookups plus a structured comparison, not an
 * expression language. Our doctrine — every prop accepts a binding, so the
 * agent expresses JUDGEMENT rather than us shipping enum sugar for each case
 * ("is this delta good?" depends on whether the metric is revenue or churn) —
 * needs real expressions: `$sum(data.rows.amount) > 1000 ? "error" : "success"`.
 *
 * The key is literally `$`, which is what stored definitions already use, so
 * migrating a definition never rewrites a binding.
 *
 * This module declares the CONTRACT only (shape + how to describe it to the
 * agent). The evaluator stays in the runtime that owns the sandbox
 * guardrails — `@fretik/shared/lib/page-expressions` wires `resolve` on top,
 * with JSONata's native timeout / stack / sequence limits. Keeping the
 * evaluator out of here is what lets this package stay dependency-light and
 * importable from a bare script.
 */

/** Upper bound on an expression's source length. */
export const MAX_EXPRESSION_CHARS = 2000;

export const bindingSchema = z.object({
  $: z.string().min(1).max(MAX_EXPRESSION_CHARS),
});

export type Binding = z.infer<typeof bindingSchema>;

/**
 * How the `$` directive is described to the agent. json-render prints this
 * ONCE under "CUSTOM DYNAMIC VALUES" — not per prop — which is exactly why
 * prop schemas stay literal (see `catalogs/pages.ts`).
 */
export const BINDING_DESCRIPTION =
  "JSONata expression evaluated against { state, data, item, index }. `data.<datasetId>` holds a dataset's rows. Use it anywhere a value depends on the data: a computed label, a conditional colour, a total. Inside a predicate the context is the ROW, so page state must be reached as $$.state.x.";

/** The `$`-prefixed keys json-render resolves natively. */
const NATIVE_EXPRESSION_KEYS = [
  "$state",
  "$item",
  "$index",
  "$bindState",
  "$bindItem",
  "$template",
  "$cond",
  "$computed",
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** True for `{ $: "…" }`. */
export const isBinding = (value: unknown): value is Binding =>
  isPlainObject(value) && typeof value["$"] === "string";

/**
 * True for any value resolved at RENDER time — our binding or one of
 * json-render's native forms.
 *
 * The validator uses this to know what it cannot judge statically: the type of
 * `{ $: "…" }` is unknowable until the data arrives, so a prop holding one is
 * skipped rather than reported as the wrong type. Without this the sanitizer
 * would strip every bound prop it was asked to check.
 */
export const isDynamicValue = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false;
  if (isBinding(value)) return true;
  return NATIVE_EXPRESSION_KEYS.some((key) => key in value);
};

/** The four breakpoints a responsive prop may vary across. */
export const BREAKPOINTS = ["base", "sm", "md", "lg"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/**
 * True for `{ base, sm, md, lg }`.
 *
 * Responsiveness is authored as VALUES, never as class prefixes: the agent
 * writes `{ base: "1", md: "3" }` and the renderer picks. A generated class
 * string could not be scanned by Tailwind at build time and would render
 * unstyled.
 */
export const isResponsiveValue = (
  value: unknown,
): value is Partial<Record<Breakpoint, unknown>> => {
  if (!isPlainObject(value) || isDynamicValue(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((key) => (BREAKPOINTS as readonly string[]).includes(key))
  );
};
