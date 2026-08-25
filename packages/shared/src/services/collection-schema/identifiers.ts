/**
 * Identifier safety + naming for the per-type physical tables.
 *
 * This is the anti-DDL-injection boundary of the objects system. Object-type
 * and field keys are already slug-validated at write, but the schema layer owns
 * its own safety: a key that fails these guards NEVER reaches a `CREATE` /
 * `ALTER`. Carried over from the old typed-view layer (`sync-typed-view.ts`);
 * only the cast logic was dropped.
 */

/** The dedicated schema holding every per-type physical table. */
export const DATA_SCHEMA = "data";

/** Least-privilege role the SQL read tool connects as (see `harden_sql_tool`). */
export const SQL_TOOL_ROLE = "fretik_sql_tool";

/** Strict slug grammar — re-validated before composing any DDL identifier. */
export const SAFE_IDENT = /^[a-z][a-z0-9_]*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres identifier limit (NAMEDATALEN − 1). Silent truncation past this. */
export const MAX_PG_IDENT = 63;

/**
 * The extension table's own structural columns. `_team_id` / `_label` /
 * `_status` are UNDERSCORE-PREFIXED so they can NEVER collide with a user field's
 * column: a field key must start with a letter (`SAFE_IDENT`), so a field named
 * `status` gets a bare `status` column that coexists with the system `_status`.
 *
 * `id`, `created_at` and `updated_at` are the BARE system columns — kept bare on
 * purpose because they match the universal SQL prior (every reader, agent or
 * human, expects a bare `created_at`/`id`), and made safe by RESERVING those
 * keys so no field can take them. `created_at`/`updated_at` are populated by the
 * DB (`DEFAULT now()` on insert; `updated_at = now()` on update) and let the
 * agent query per-row timestamps directly, without joining the registry.
 */
export const SYS_COL = {
  id: "id",
  team: "_team_id",
  label: "_label",
  status: "_status",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

/** Every structural column name (for "is this a system column?" checks). */
export const SYSTEM_COLUMN_NAMES: ReadonlySet<string> = new Set(
  Object.values(SYS_COL),
);

/**
 * Column names a field key may never take: the BARE system columns (`id`,
 * `created_at`, `updated_at`). The underscore-prefixed ones are already
 * unreachable by a (letter-initial) key.
 */
export const RESERVED_FIELD_KEYS = new Set<string>([
  SYS_COL.id,
  SYS_COL.createdAt,
  SYS_COL.updatedAt,
]);

export const assertSafeUuid = (value: string, what: string): void => {
  if (!UUID_RE.test(value)) {
    throw new Error(`Refusing to compose DDL with a non-UUID ${what}`);
  }
};

export const assertSafeKey = (key: string, what: string): void => {
  if (!SAFE_IDENT.test(key) || key.length > 60) {
    throw new Error(`Refusing to compose DDL with an unsafe ${what}: '${key}'`);
  }
  if (RESERVED_FIELD_KEYS.has(key)) {
    throw new Error(`Field key '${key}' is reserved and cannot be a column`);
  }
};

/** Hex of a UUID with dashes stripped (32 chars). */
const hex = (id: string): string => id.replace(/-/g, "");

/**
 * Physical table name for a collection: `coll_<collectionId-hex>`. Opaque and
 * STABLE — derived from the immutable id, never the (renameable) key — so a type
 * rename is a catalog-only change and never a `RENAME TABLE`. Lives in the
 * `data` schema; the qualified form is `data.coll_<hex>`.
 */
export const collectionTableName = (collectionId: string): string => {
  assertSafeUuid(collectionId, "collection id");
  return `coll_${hex(collectionId)}`;
};

/** Fully-qualified, quote-free physical table reference (`data.coll_<hex>`). */
export const qualifiedCollectionTable = (collectionId: string): string =>
  `${DATA_SCHEMA}.${collectionTableName(collectionId)}`;

/**
 * Sequence backing a `unique_id` field: `data.seq_<fieldId-hex>`. Keyed by the
 * STABLE field-definition id (never the renameable key), so renaming a field —
 * or deleting one and re-adding another with the same key — can never collide
 * with or reuse an existing sequence. The sequence is `OWNED BY` its column, so
 * Postgres drops it with the column; the name is only reconstructed at create.
 */
export const uniqueIdSequenceName = (fieldId: string): string => {
  assertSafeUuid(fieldId, "field id");
  return `${DATA_SCHEMA}.seq_${hex(fieldId)}`;
};
