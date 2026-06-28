/**
 * Field-type registry — the single source of truth for what kinds of fields an
 * object type can have, and the per-type configuration each one carries.
 *
 * Why a registry (and not one flat config bag):
 *   - `FIELD_TYPES` drives BOTH the Drizzle `field_definition_type` pg enum and
 *     the `FieldTypeConfigMap` below, so the DB enum and the TS config can never
 *     drift.
 *   - Each field type owns a NAMED config type (`NumberFieldConfig`, …). The
 *     stored `config` JSONB is the union of those, but per-type code uses
 *     `ConfigFor<"number">` and sees exactly the fields that type allows.
 *   - `_AssertConfigMapCoversFieldTypes` makes "added a field type without its
 *     config" a compile error.
 *
 * Adding a new field type later (e.g. `location`, `formula`, `rollup`):
 *   1. append its key to `FIELD_TYPES`,
 *   2. add its `XxxFieldConfig` type + an entry in `FieldTypeConfigMap`,
 *   3. (runtime) add its config Zod schema in the field-definitions service,
 *   4. (frontend) register its renderer/editor.
 * No other file in this module needs to change.
 *
 * `select` vs `multi_select` are kept as separate types (as in Notion and
 * Twenty): the distinction is the stored value SHAPE (scalar vs array), not a
 * presentation toggle — keeping them separate gives each a stable data shape
 * for the typed view, filtering, and the AI query path.
 */

/**
 * Every field type, in display order. Source of truth for the pg enum.
 *
 * Storage note: most types store their value in `object_records.data` under the
 * field key. `relation` is the exception — its instances live in the `links`
 * graph (see `RelationFieldConfig`), never in `data`.
 */
export const FIELD_TYPES = [
  "text",
  "number",
  "date",
  "datetime",
  "boolean",
  "select",
  "multi_select",
  "url",
  "email",
  // Relation to other records, backed by the `links` graph.
  "relation",
  // A team member (Better Auth user); userId(s) in `data`. Distinct from the
  // `person` object type, which models external contacts.
  "member",
  // Monetary amount in a currency: `{ amount, currencyCode }`. Named `money`
  // (not `currency`) because the value IS the amount, not just the ISO code.
  "money",
  // Multi-line formatted text stored as markdown — named for the literal
  // storage format so the agent knows exactly what syntax to read/write.
  "markdown",
  // Numeric star/icon rating.
  "rating",
  // Phone-number string.
  "phone",
  // Read-only aggregate over a `relation` field's linked records (Notion
  // rollup). Computed in the typed view; never stored in `data`.
  "rollup",
] as const;

export type FieldDefinitionType = (typeof FIELD_TYPES)[number];

/**
 * An option for the select-family fields. `group` (optional) gives the option
 * Notion-style "status" semantics so the kanban board can lane records into
 * To-do / In-progress / Done.
 */
export type FieldDefinitionOption = {
  value: string;
  label: string;
  color?: string;
  icon?: string;
  group?: "todo" | "in_progress" | "done";
};

export type FieldRelationCardinality = "one" | "many";
/** Number display ("Progress" in Notion is a display option of Number). */
export type FieldNumberDisplay = "plain" | "bar" | "ring";
export type FieldNumberFormat = "plain" | "percent";

/** Types with no extra configuration (the value is self-describing). */
export type NoFieldConfig = Record<string, never>;

export type TextFieldConfig = {
  /** Render as a textarea rather than a single-line input. */
  multiline?: boolean;
};

export type NumberFieldConfig = {
  min?: number;
  max?: number;
  /** `percent` + `divideBy` drive the bar/ring fill ("Progress"). */
  numberFormat?: FieldNumberFormat;
  display?: FieldNumberDisplay;
  divideBy?: number;
  color?: string;
  showNumber?: boolean;
};

export type SelectFieldConfig = {
  /** Closed list of allowed values. */
  options?: FieldDefinitionOption[];
  /** multi_select only: allow values outside `options`. */
  freeform?: boolean;
};

export type RelationFieldConfig = {
  /**
   * Target object type. Omitted = polymorphic (any type). Equal to the field's
   * own object type = self-relation (sub-items / parent-child).
   */
  targetTypeKey?: string;
  cardinality?: FieldRelationCardinality;
  /** Key of the backing `link_type` this field projects (set on create). */
  linkTypeKey?: string;
  /** `attachment` = a relation to the `document` type with an upload-and-link UI. */
  widget?: "attachment";
};

export type MemberFieldConfig = {
  /** Allow assigning more than one teammate. */
  multiple?: boolean;
};

export type MoneyFieldConfig = {
  /** Default ISO-4217 code for new values (e.g. "EUR"). */
  defaultCurrencyCode?: string;
};

export type RatingFieldConfig = {
  /** Number of icons (default 5). */
  ratingMax?: number;
  /** Icon name to render (default a star). */
  ratingIcon?: string;
};

/** Aggregate functions a rollup can apply over a relation's linked records. */
export type RollupFn =
  | "sum"
  | "count"
  | "avg"
  | "min"
  | "max"
  | "count_not_empty"
  | "percent_not_empty";

export type RollupFieldConfig = {
  /**
   * Key of a `relation` field on THIS type whose linked records are aggregated.
   * The rollup reads that field's backing `linkTypeKey` to find the edges.
   */
  relationFieldKey?: string;
  /**
   * Key of the field on the TARGET records to aggregate. Omitted for `count`
   * (which counts linked records regardless of any field value).
   */
  targetFieldKey?: string;
  fn?: RollupFn;
};

/** Field type → its config shape. Add a row here per new field type. */
export type FieldTypeConfigMap = {
  text: TextFieldConfig;
  number: NumberFieldConfig;
  date: NoFieldConfig;
  datetime: NoFieldConfig;
  boolean: NoFieldConfig;
  select: SelectFieldConfig;
  multi_select: SelectFieldConfig;
  url: NoFieldConfig;
  email: NoFieldConfig;
  relation: RelationFieldConfig;
  member: MemberFieldConfig;
  money: MoneyFieldConfig;
  markdown: NoFieldConfig;
  rating: RatingFieldConfig;
  phone: NoFieldConfig;
  rollup: RollupFieldConfig;
};

/** Config for a known field type — use this in per-type code. */
export type ConfigFor<T extends FieldDefinitionType> = FieldTypeConfigMap[T];

/** The union stored in the `config` JSONB column. */
export type FieldDefinitionConfig = FieldTypeConfigMap[FieldDefinitionType];

// Compile-time guard: the config map and FIELD_TYPES must cover exactly the
// same keys. If a field type is added to FIELD_TYPES without a config entry (or
// vice versa), `true` stops being assignable to `never` and the build fails —
// the const is referenced (exported) so it is never flagged as dead code.
type AssertExtends<A extends B, B> = A extends B ? true : never;
export const _fieldTypeConfigCoverage: [
  AssertExtends<FieldDefinitionType, keyof FieldTypeConfigMap>,
  AssertExtends<keyof FieldTypeConfigMap, FieldDefinitionType>,
] = [true, true];

// ---------------------------------------------------------------------------
// Config accessors
//
// `config` is stored as the union of every per-type shape, so a property that
// belongs to one type (e.g. `options`, `divideBy`) can't be read off the union
// directly. These helpers narrow with the `in` operator — cast-free (the
// codebase forbids `as`) — and return safe fallbacks, so callers that don't
// know the field type can still read a config value without a `switch`.
// ---------------------------------------------------------------------------

/** Options of a select-family field (empty for any other type). */
export const fieldOptions = (
  config: FieldDefinitionConfig,
): FieldDefinitionOption[] =>
  "options" in config && config.options ? config.options : [];

/** Number bounds — only present on `number` fields. */
export const numberBounds = (
  config: FieldDefinitionConfig,
): { min?: number; max?: number } => ({
  min: "min" in config ? config.min : undefined,
  max: "max" in config ? config.max : undefined,
});

/** Whether a `multi_select` field accepts values outside its option list. */
export const isFreeform = (config: FieldDefinitionConfig): boolean =>
  "freeform" in config ? (config.freeform ?? false) : false;

/** Whether a `member` field accepts more than one teammate. */
export const isMultiMember = (config: FieldDefinitionConfig): boolean =>
  "multiple" in config ? (config.multiple ?? false) : false;

/** Default ISO-4217 currency for a `money` field, if configured. */
export const defaultCurrencyCode = (
  config: FieldDefinitionConfig,
): string | undefined =>
  "defaultCurrencyCode" in config &&
  typeof config.defaultCurrencyCode === "string"
    ? config.defaultCurrencyCode
    : undefined;

/** Icon count for a `rating` field (default 5). */
export const ratingMax = (config: FieldDefinitionConfig): number =>
  "ratingMax" in config && typeof config.ratingMax === "number"
    ? config.ratingMax
    : 5;
