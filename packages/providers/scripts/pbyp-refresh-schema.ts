#!/usr/bin/env bun
/**
 * Regenerates `src/pbyp/directus-schema.ts` — the trimmed snapshot of the
 * Pbyp Directus schema the provider validates writes against.
 *
 *   PBYP_DIRECTUS_URL=https://directus.app.pbyp.fr \
 *   PBYP_ADMIN_TOKEN=… \
 *   bun run scripts/pbyp-refresh-schema.ts
 *
 * Why a snapshot rather than a live read: the agent's mistakes are made at
 * ARGUMENT-BUILDING time, in a sandbox with no Directus reachable, and the
 * checks that catch them (`invariants.ts`) run in our process before the
 * request leaves. A live read would also make the wire tests depend on a
 * running Directus — they would then be testing Pbyp's uptime, not our code.
 *
 * The snapshot is committed. `pbyp-schema-contract.test.ts` pins every
 * collection, field and enum value the manifest names against it, so a Pbyp
 * schema change surfaces as a failing test after this script is re-run —
 * not as a 400 in front of a user.
 *
 * Admin token: a non-admin account cannot read `/fields` for collections it
 * has no permission on, and the snapshot must describe the whole schema, not
 * one persona's slice.
 */

interface DirectusField {
  collection: string;
  field: string;
  type: string;
  schema: {
    is_nullable?: boolean;
    is_primary_key?: boolean;
    is_generated?: boolean;
    has_auto_increment?: boolean;
    default_value?: unknown;
    max_length?: number | null;
  } | null;
  meta: {
    required?: boolean | null;
    readonly?: boolean | null;
    special?: string[] | null;
    options?: { choices?: Array<{ value?: unknown }> | null } | null;
  } | null;
}

interface DirectusRelation {
  collection: string;
  field: string;
  related_collection: string | null;
  meta: {
    one_field?: string | null;
    junction_field?: string | null;
  } | null;
}

interface DirectusCollection {
  collection: string;
  meta: { singleton?: boolean | null; hidden?: boolean | null } | null;
}

import type {
  PbypRelationShape as RelationShape,
  PbypSchemaCollection as SnapshotCollection,
} from "../src/pbyp/schema-types";

const BASE = process.env.PBYP_DIRECTUS_URL;
const TOKEN = process.env.PBYP_ADMIN_TOKEN;

if (BASE === undefined || TOKEN === undefined) {
  console.error(
    "PBYP_DIRECTUS_URL and PBYP_ADMIN_TOKEN are required (admin token: /fields is permission-scoped).",
  );
  process.exit(1);
}

/**
 * One `/fields`-style list. The rows are narrowed by the reader functions
 * below rather than asserted here: Directus adds columns freely, and a
 * cast would hide the day one we depend on stops arriving.
 */
const fetchAll = async (path: string): Promise<unknown[]> => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status.toString()}`);
  }
  const body: unknown = await res.json();
  const data: unknown = isRecord(body) && "data" in body ? body.data : body;
  if (!Array.isArray(data)) throw new Error(`GET ${path} → not a list`);
  // `Array.isArray` narrows to `any[]`; re-declare so nothing downstream
  // inherits `any` from a JSON body.
  const rows: unknown[] = data;
  return rows;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, key: string): string | undefined => {
  const raw = isRecord(value) ? value[key] : undefined;
  return typeof raw === "string" ? raw : undefined;
};

const readBoolean = (value: unknown, key: string): boolean | undefined => {
  const raw = isRecord(value) ? value[key] : undefined;
  return typeof raw === "boolean" ? raw : undefined;
};

const readObject = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  const raw = isRecord(value) ? value[key] : undefined;
  return isRecord(raw) ? raw : undefined;
};

// ── Narrowing the API rows ────────────────────────────────────────────
//
// One parser per endpoint, each returning `undefined` for a row it cannot
// read. Directus adds columns freely; a blanket cast would keep compiling
// the day one we depend on stops arriving, and the snapshot would quietly
// lose it.

const parseField = (row: unknown): DirectusField | undefined => {
  const collection = readString(row, "collection");
  const field = readString(row, "field");
  const type = readString(row, "type");
  if (collection === undefined || field === undefined || type === undefined) {
    return undefined;
  }
  const schema = readObject(row, "schema");
  const meta = readObject(row, "meta");
  return {
    collection,
    field,
    type,
    schema:
      schema === undefined
        ? null
        : {
            is_nullable: readBoolean(schema, "is_nullable"),
            is_primary_key: readBoolean(schema, "is_primary_key"),
            is_generated: readBoolean(schema, "is_generated"),
            has_auto_increment: readBoolean(schema, "has_auto_increment"),
            default_value: schema.default_value,
          },
    meta:
      meta === undefined
        ? null
        : {
            required: readBoolean(meta, "required"),
            readonly: readBoolean(meta, "readonly"),
            options: readObject(meta, "options") ?? null,
          },
  };
};

const parseRelation = (row: unknown): DirectusRelation | undefined => {
  const collection = readString(row, "collection");
  const field = readString(row, "field");
  if (collection === undefined || field === undefined) return undefined;
  const meta = readObject(row, "meta");
  return {
    collection,
    field,
    related_collection: readString(row, "related_collection") ?? null,
    meta:
      meta === undefined
        ? null
        : {
            one_field: readString(meta, "one_field") ?? null,
            junction_field: readString(meta, "junction_field") ?? null,
          },
  };
};

const parseCollection = (row: unknown): DirectusCollection | undefined => {
  const collection = readString(row, "collection");
  if (collection === undefined) return undefined;
  const meta = readObject(row, "meta");
  return {
    collection,
    meta:
      meta === undefined
        ? null
        : { singleton: readBoolean(meta, "singleton") ?? null },
  };
};

const parseAll = <T>(
  rows: unknown[],
  parse: (row: unknown) => T | undefined,
): T[] => rows.map(parse).filter((row): row is T => row !== undefined);

const isBusinessCollection = (name: string): boolean =>
  !name.startsWith("directus_");

const choicesOf = (field: DirectusField): string[] | undefined => {
  const raw = field.meta?.options?.choices;
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map((choice) => (isRecord(choice) ? choice.value : undefined))
    .filter((value): value is string => typeof value === "string");
  return values.length > 0 ? values : undefined;
};

/**
 * A field is required when the application says so OR when the column
 * refuses null with no default — the second is what actually produces a
 * 400, and Directus does not always mirror it into `meta.required`.
 */
const isRequired = (field: DirectusField): boolean => {
  if (field.meta?.required === true) return true;
  const s = field.schema;
  if (s === null || s === undefined) return false;
  return (
    s.is_nullable === false &&
    s.is_primary_key !== true &&
    s.is_generated !== true &&
    s.has_auto_increment !== true &&
    (s.default_value === null || s.default_value === undefined)
  );
};

const main = async (): Promise<void> => {
  const [rawFields, rawRelations, rawCollections] = await Promise.all([
    fetchAll("/fields"),
    fetchAll("/relations"),
    fetchAll("/collections"),
  ]);
  const fields = parseAll(rawFields, parseField);
  const relations = parseAll(rawRelations, parseRelation);
  const collections = parseAll(rawCollections, parseCollection);

  // Index the M2O side once: `<collection>.<field>` → related collection.
  const m2o = new Map<string, string>();
  for (const r of relations) {
    if (r.related_collection === null) continue;
    m2o.set(`${r.collection}.${r.field}`, r.related_collection);
  }

  // Index the alias side: an O2M/M2M field is declared on the ONE side via
  // `meta.one_field`, but the row itself lives on the MANY side.
  const alias = new Map<string, DirectusRelation>();
  for (const r of relations) {
    const oneField = r.meta?.one_field;
    if (r.related_collection === null || !oneField) continue;
    alias.set(`${r.related_collection}.${oneField}`, r);
  }

  const shapeOf = (
    collection: string,
    field: string,
  ): RelationShape | undefined => {
    const aliasRel = alias.get(`${collection}.${field}`);
    if (aliasRel !== undefined) {
      const junctionField = aliasRel.meta?.junction_field;
      if (junctionField) {
        const other = m2o.get(`${aliasRel.collection}.${junctionField}`);
        if (other !== undefined) {
          return {
            kind: "m2m",
            through: aliasRel.collection,
            fk: aliasRel.field,
            otherFk: junctionField,
            to: other,
          };
        }
      }
      return { kind: "o2m", to: aliasRel.collection, fk: aliasRel.field };
    }
    const target = m2o.get(`${collection}.${field}`);
    return target === undefined ? undefined : { kind: "m2o", to: target };
  };

  const singletons = new Set(
    collections
      .filter((c) => c.meta?.singleton === true)
      .map((c) => c.collection),
  );

  const out: Record<string, SnapshotCollection> = {};
  for (const field of fields) {
    if (!isBusinessCollection(field.collection)) continue;

    const entry = (out[field.collection] ??= {
      primaryKey: "id",
      ...(singletons.has(field.collection) ? { singleton: true as const } : {}),
      fields: {},
    });

    if (field.schema?.is_primary_key === true) {
      entry.primaryKey = field.field;
    }

    const choices = choicesOf(field);
    const relation = shapeOf(field.collection, field.field);
    entry.fields[field.field] = {
      type: field.type,
      ...(isRequired(field) ? { required: true as const } : {}),
      ...(field.meta?.readonly === true ? { readonly: true as const } : {}),
      ...(choices !== undefined ? { choices } : {}),
      ...(relation !== undefined ? { relation } : {}),
    };
  }

  // A collection Directus knows but that carries no field row would be a
  // silent hole in the whitelist — surface it rather than drop it.
  for (const c of collections) {
    if (!isBusinessCollection(c.collection)) continue;
    out[c.collection] ??= { primaryKey: "id", fields: {} };
  }

  const sorted = Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, def]) => [
        name,
        {
          ...def,
          fields: Object.fromEntries(
            Object.entries(def.fields).sort(([a], [b]) => a.localeCompare(b)),
          ),
        },
      ]),
  );

  const fieldCount = Object.values(sorted).reduce(
    (n, c) => n + Object.keys(c.fields).length,
    0,
  );

  // Emitted as TypeScript, not JSON: the backend tsconfig does not enable
  // `resolveJsonModule`, and turning it on for every package to ship one
  // snapshot is the wrong trade. A typed module also gets checked — a
  // generator that drifts from `schema-types.ts` fails `bun run check`
  // instead of failing at the first agent write.
  const header = [
    "// GENERATED by scripts/pbyp-refresh-schema.ts — do not edit by hand.",
    `// Source: ${BASE} · ${Object.keys(sorted).length.toString()} collections · ${fieldCount.toString()} fields.`,
    "//",
    "// Regenerate after any Pbyp schema change:",
    "//   PBYP_DIRECTUS_URL=… PBYP_ADMIN_TOKEN=… bun run scripts/pbyp-refresh-schema.ts",
    "",
    'import type { PbypSchema } from "./schema-types";',
    "",
    "export const PBYP_SCHEMA: PbypSchema = ",
  ].join("\n");

  const target = `${import.meta.dir}/../src/pbyp/directus-schema.ts`;
  await Bun.write(target, `${header}${JSON.stringify(sorted, null, 2)};\n`);

  console.log(
    `✓ ${Object.keys(sorted).length.toString()} collections · ${fieldCount.toString()} fields → src/pbyp/directus-schema.ts`,
  );
};

await main();
