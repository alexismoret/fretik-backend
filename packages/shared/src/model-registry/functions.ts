/**
 * The functions a team controls its models through.
 *
 * A function is a JOB the product does, not a price band. The three tiers it
 * replaces (flagship / workhorse / utility) described how much a model costs,
 * which is the one axis a team cannot act on: told that "utility" serves both
 * the memory writers and the title generator, nobody can reason about what
 * changing it breaks. A function names the work, so the choice carries its own
 * consequence — picking the `recall` model is picking what judges every turn's
 * memory, and picking `vision` is picking what reads a scanned page.
 *
 * Seven, and each one earns its separation by a property no sibling shares:
 *
 * - `assistant` — the chat and workflow loop. The model a team means when it
 *   says "our AI".
 * - `documents` — extraction, transformation and compaction. Separated by the
 *   CONTEXT it must swallow: compaction runs on a nearly full window.
 * - `memory` — what writes to long-term memory. Separated because a bad write
 *   persists, while a bad answer is one turn.
 * - `recall` — the judge that decides what memory a turn sees, under a 15 s
 *   ceiling ON THE HOT PATH OF EVERY TURN. Split from `memory` for that reason
 *   alone: a model chosen for the quality of its writing would break reading.
 * - `quick-tasks` — titles, reformulation, repair. Volume work where speed or
 *   price is the point.
 * - `vision` — anything that reads an image. The only function with a HARD
 *   capability gate rather than a quality floor.
 * - `pages` — the generated-dashboard builder. Separated because a page is the
 *   one artefact a team keeps and reopens, so its cost/quality trade is
 *   genuinely its own.
 *
 * Roles the product never lets a team steer — every `*-fallback`, and the page
 * critic — belong to no function on purpose. A fallback that a team could
 * repoint onto its primary would silently remove the redundancy it exists for.
 */
export const MODEL_FUNCTION_KEYS = [
  "assistant",
  "documents",
  "memory",
  "recall",
  "quick-tasks",
  "vision",
  "pages",
] as const;

export type ModelFunctionKey = (typeof MODEL_FUNCTION_KEYS)[number];

export const isModelFunctionKey = (value: string): value is ModelFunctionKey =>
  (MODEL_FUNCTION_KEYS as readonly string[]).includes(value);

/**
 * A team's stored pick per function — the shape of the `function_profile_keys`
 * jsonb column. A missing key means "use the code default", exactly as a `null`
 * tier column did.
 */
export type FunctionProfileKeys = Partial<Record<ModelFunctionKey, string>>;

/**
 * The key a team stored for one function, or `undefined` for "code default".
 *
 * Structurally typed rather than taking the row type, so this stays a pure
 * function in the vocabulary layer — a settings ACCESSOR is not a database
 * read, and pulling the schema in here would drag Drizzle into every file that
 * asks what a team chose.
 *
 * The `?? {}` is not defensive padding: a settings row cached BEFORE the
 * migration ran carries no `functionProfileKeys` at all, and the 30-minute
 * cache makes that window real rather than theoretical. Reading `undefined[fn]`
 * there would throw on a personalisation read that must never break a turn.
 */
export interface StoredModelSettings {
  functionProfileKeys?: FunctionProfileKeys;
}

export const functionProfileKey = (
  settings: StoredModelSettings | null,
  fn: ModelFunctionKey,
): string | undefined => (settings?.functionProfileKeys ?? {})[fn];
