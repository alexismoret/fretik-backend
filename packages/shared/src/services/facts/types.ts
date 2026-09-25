/**
 * The fact sheet — what the platform already KNOWS about the thing an event
 * happened to, gathered once and handed to everything that has to judge it.
 *
 * It exists because of a gap that cost real money. `document.uploaded` is
 * emitted at the END of the document pipeline, after OCR, after the
 * structured classification, after entity extraction — so at that instant the
 * database holds the summary, the language, the page count, every custom field
 * the team configured, and the organisations named inside. The event carried
 * four of those: `documentId`, `filename`, `folderId`, `mentionCount`. Every
 * workflow listening for an upload therefore had nothing to decide on but the
 * folder, and the only way to answer "is this mine?" was to boot a full agent
 * run and ask it — hundreds of thousands of tokens to reach a conclusion the
 * row already implied.
 *
 * So the rule this module exists to enforce: a fact is something ALREADY
 * COMPUTED. Resolvers do a small, bounded number of indexed reads. They never
 * run OCR, never call a model, never fetch a byte from S3. Anything that would
 * cost more than the decision it informs does not belong in a fact sheet.
 *
 * Three consumers read the same sheet, which is the whole reason it is one
 * object rather than three ad-hoc payloads:
 *   1. the trigger gate — the `state` it hands to the decision model;
 *   2. the run itself — the `triggerPayload` an executor opens on, so it stops
 *      spending its first turns rediscovering its own context;
 *   3. the UI + the agent catalog — what a person or the builder agent can see
 *      and write a criterion against.
 */

/**
 * What a fact may hold. Deliberately small and JSON-safe: a fact sheet is
 * serialised into a run payload, rendered in a browser and posted to a
 * third-party decision endpoint, so anything that does not survive
 * `JSON.stringify` unchanged has no business being one.
 *
 * FLAT, and that is load-bearing rather than a simplification. Nesting would
 * force every consumer to agree on a traversal — the matcher, the renderer and
 * the decision model each inventing their own path syntax — and dotted keys
 * (`customFields.invoice_total`) say the same thing with no traversal at all.
 */
export type FactValue = string | number | boolean | null | string[];

/**
 * The semantic type of a fact. It is what a UI dispatches a control on and
 * what tells a reader whether `"2026-09-20"` is a date or a label — never a
 * storage detail, since every value is already one of `FactValue`'s shapes.
 */
export const FACT_KINDS = [
  "text",
  "number",
  "boolean",
  "date",
  "enum",
  "list",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** One declared fact: its key, what it means, and how to read it. */
export interface FactDescriptor {
  /** Stable key as it appears in a sheet. Dotted for namespaced families. */
  key: string;
  kind: FactKind;
  /** i18n key — the frontend owns the wording. */
  labelKey: string;
  /** One line, agent-facing: what the value is, in what units/format. */
  agentHint: string;
  /** false = declared but not yet resolved. The UI disables it, the agent
   * catalog skips it — same convention as the trigger registry. */
  available: boolean;
}

/** Author a descriptor with `available: true` as the default. */
export const fact = (
  descriptor: Omit<FactDescriptor, "available"> & { available?: boolean },
): FactDescriptor => ({ available: true, ...descriptor });

/**
 * Everything known about one event's subject, resolved.
 *
 * `eventType` travels inside the sheet rather than beside it because every
 * consumer needs it and a sheet that loses it cannot be read: the same
 * `documentId` means "a file arrived" under `document.uploaded` and "a file
 * changed" under `document.revised`, and nothing else in the facts says which.
 */
export interface FactSheet {
  eventType: string;
  facts: Record<string, FactValue>;
}

/** An empty sheet for an event family nothing resolves yet. */
export const emptyFactSheet = (eventType: string): FactSheet => ({
  eventType,
  facts: {},
});
