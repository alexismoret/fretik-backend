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
  // A calendar day, or an instant when `config.hasTime` is set (Notion-style
  // single date type with an "include time" toggle). Stored as `timestamptz`.
  "date",
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
  // A geocoded place — `{ address, lat?, lng?, mapboxId? }` in `data` (jsonb).
  // The address is geocoded to coordinates server-side (see geocode-location).
  "location",
  // Auto-incrementing per-type reference (Notion "Unique ID"): a `bigint`
  // filled by a dedicated sequence on insert; the UI shows `<prefix>-<n>`.
  // Read-only — never written through record data.
  "unique_id",
  // System properties (Notion): read-only projections of the record's registry
  // columns, surfaced as fields so views can sort/filter/show them. No storage.
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  // Read-only aggregate over a `relation` field's linked records (Notion
  // rollup). Computed in the typed view; never stored in `data`.
  "rollup",
  // Read-only value derived from the record's OWN fields by a formula, computed
  // by the database itself (a `GENERATED … STORED` column). Being a real column
  // is the point: it sorts, filters and aggregates server-side like any other.
  // Distinct from `rollup`, which reaches across a relation to OTHER records.
  "formula",
] as const;

export type FieldDefinitionType = (typeof FIELD_TYPES)[number];

/**
 * Field types no record write can ever set — their value is DERIVED, never
 * entered: a relation is an edge in the `links` graph (moved with a link
 * operation), a rollup aggregates other records, a formula is a column the
 * database computes and physically refuses to accept a value for, `unique_id`
 * comes from its sequence, and the system properties mirror the registry.
 *
 * One exported set rather than a copy per consumer: `buildRecordShape` (which
 * strips these keys from a write) and the pages field descriptors (which tell a
 * generated page not to offer them in a form) previously carried the same list
 * twice, coupled only by a comment — so a new derived type was one forgotten
 * edit away from being offered as writable in a form that silently saves
 * nothing.
 */
export const NON_WRITABLE_FIELD_TYPES: ReadonlySet<FieldDefinitionType> =
  new Set([
    "relation",
    "rollup",
    "formula",
    "unique_id",
    "created_time",
    "last_edited_time",
    "created_by",
    "last_edited_by",
  ]);

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
/**
 * Text format of a plain number (Notion: Number / Number with commas /
 * Percent). `commas` groups thousands; `percent` renders the value ×100 with a
 * `%` (0.25 → "25%") — distinct from a literal `%` suffix. Bar/ring keep
 * showing their fill percentage regardless. Currencies are the `money` type.
 */
export type FieldNumberFormat = "plain" | "commas" | "percent";

/** Types with no extra configuration (the value is self-describing). */
export type NoFieldConfig = Record<string, never>;

export type TextFieldConfig = {
  /** Render as a textarea rather than a single-line input. */
  multiline?: boolean;
};

export type DateFieldConfig = {
  /**
   * Capture (and display) a time-of-day, not just a calendar day. Off by
   * default (Notion-aligned). Toggling it never changes the physical column —
   * the date family is always stored as `timestamptz`; a time-less value is
   * midnight UTC.
   */
  hasTime?: boolean;
};

export type NumberFieldConfig = {
  min?: number;
  max?: number;
  /** Text format of the value (see `FieldNumberFormat`). */
  numberFormat?: FieldNumberFormat;
  /** Fixed number of decimal places to show (0–10). Omitted = as typed. */
  precision?: number;
  /**
   * Short unit text rendered after the value (e.g. "kg", "pts"). A prefix/
   * currency symbol is the `money` type's job — Notion has no generic prefix.
   */
  suffix?: string;
  display?: FieldNumberDisplay;
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

export type UniqueIdFieldConfig = {
  /** Text shown before the counter, e.g. "TASK" → "TASK-42". */
  prefix?: string;
};

/**
 * Mapbox feature types (Geocoding v6 + Search Box). Open union: known literals
 * give autocomplete + an icon mapping, `(string & {})` keeps any new Mapbox type
 * assignable at runtime (the value comes from the API / jsonb).
 */
export const MAPBOX_FEATURE_TYPES = [
  // Geocoding v6, largest → most granular.
  "country",
  "region",
  "postcode",
  "district",
  "place",
  "locality",
  "neighborhood",
  "street",
  "block",
  "address",
  "secondary_address",
  // Search Box points of interest.
  "poi",
] as const;

/**
 * A recognized Mapbox feature type. Closed on purpose: since `featureType` is
 * optional and only drives a UI icon, an unrecognized Mapbox value is dropped to
 * `undefined` (never stored) rather than widening the type — data stays clean
 * and both sides stay fully typed. Extend the list to support a new one.
 */
export type MapboxFeatureType = (typeof MAPBOX_FEATURE_TYPES)[number];

/** Bounding box of an area feature, `[minLon, minLat, maxLon, maxLat]`. */
export type LocationBbox = [number, number, number, number];

/** A geocoded place value, stored as jsonb in `data`. */
export type LocationValue = {
  address: string;
  lat?: number;
  lng?: number;
  /** Mapbox feature id, kept so the exact place can be re-resolved. */
  mapboxId?: string;
  /**
   * What kind of place this is, so the UI can show a type-specific icon.
   * Absent for AI/text writes until geocoded.
   */
  featureType?: MapboxFeatureType;
  /**
   * Bounding box for area features (city/region/country/…). Lets the map draw
   * the zone / fit its bounds instead of dropping a lone pin. Absent for points.
   */
  bbox?: LocationBbox;
};

/** Aggregate functions a rollup can apply over a relation's linked records. */
export type RollupFn =
  | "sum"
  | "count"
  | "avg"
  | "min"
  | "max"
  | "count_not_empty"
  | "percent_not_empty"
  // Share (%) of linked records whose boolean target field is true — Notion
  // "Percent checked", for task/subtask progress.
  | "percent_checked";

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

/**
 * What a formula evaluates to. Kept here rather than in the formula compiler
 * because it is a PERSISTED value (`config.resultType`) — the schema owns the
 * vocabulary, the language re-exports it so the two can never drift.
 */
export const FORMULA_RESULT_TYPES = [
  "number",
  "text",
  "boolean",
  "date",
] as const;

export type FormulaResultType = (typeof FORMULA_RESULT_TYPES)[number];

export type FormulaFieldConfig = {
  /**
   * The formula, in Fretik's formula language (`revenue - cost`,
   * `round(margin / revenue * 100, 1)`, `if(status = "won", amount, 0)`).
   * Compiled to SQL server-side; raw SQL is never accepted here.
   */
  expression?: string;
  /**
   * What the expression evaluates to — INFERRED by the compiler at save and
   * stored so readers never re-infer. Writing it by hand would create a second
   * source of truth that can disagree with the expression itself.
   */
  resultType?: FormulaResultType;
  /** Display options, mirroring their `number` / `money` / `date` counterparts. */
  precision?: number;
  suffix?: string;
  numberFormat?: FieldNumberFormat;
  /** ISO-4217 code — renders a `number` result as money. */
  currencyCode?: string;
  /** `date` result: show the time of day too. */
  hasTime?: boolean;
};

/** Field type → its config shape. Add a row here per new field type. */
export type FieldTypeConfigMap = {
  text: TextFieldConfig;
  number: NumberFieldConfig;
  date: DateFieldConfig;
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
  location: NoFieldConfig;
  unique_id: UniqueIdFieldConfig;
  created_time: NoFieldConfig;
  last_edited_time: NoFieldConfig;
  created_by: NoFieldConfig;
  last_edited_by: NoFieldConfig;
  rollup: RollupFieldConfig;
  formula: FormulaFieldConfig;
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
// belongs to one type (e.g. `options`, `precision`) can't be read off the union
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

/** Whether a `date` field captures a time-of-day (default false). */
export const hasTime = (config: FieldDefinitionConfig): boolean =>
  "hasTime" in config ? (config.hasTime ?? false) : false;

/** Prefix for a `unique_id` field (e.g. "TASK"), empty when unset. */
export const uniqueIdPrefix = (config: FieldDefinitionConfig): string =>
  "prefix" in config && typeof config.prefix === "string" ? config.prefix : "";

/** Icon count for a `rating` field (default 5). */
export const ratingMax = (config: FieldDefinitionConfig): number =>
  "ratingMax" in config && typeof config.ratingMax === "number"
    ? config.ratingMax
    : 5;
