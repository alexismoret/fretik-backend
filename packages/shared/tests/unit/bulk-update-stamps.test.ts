import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildRegistryUpdateBatch } from "../../src/services/object-records/bulk-update";

/**
 * Regression: a bulk update must stamp the REGISTRY's `updated_at`.
 *
 * The column declares `$onUpdate` in the schema, so the single-row
 * `updateObjectRecord` gets the stamp for free — but that is a Drizzle
 * query-builder convenience, and this statement is set-based SQL, which never
 * triggers it. It was omitted, and the result was a value that is wrong in the
 * most expensive way: `last_edited_time` and "sort by recently updated" both
 * read the CREATION date, sitting next to an updated-BY stamp that HAD been
 * refreshed. Half-right reads as working.
 *
 * Measured on the dev database before the fix: registry `2026-08-17 11:24`,
 * typed table `2026-08-21 15:05`, on the same record. After: both
 * `2026-08-21 15:10:24.114914` — identical, because `now()` is the transaction
 * clock and both statements run in one transaction.
 */

const render = (stmt: ReturnType<typeof buildRegistryUpdateBatch>): string =>
  new PgDialect().sqlToQuery(stmt).sql;

describe("buildRegistryUpdateBatch", () => {
  const rows = [
    {
      id: "019f0b8b-25e8-7b13-acce-2f2162bd81ed",
      label: "Northwind Trading",
      normalizedLabel: "northwind trading",
      searchText: "Northwind Trading",
      eventId: "019f0b8b-25e8-7b13-acce-2f2162bd81ee",
    },
  ];
  const actor = { actorType: "user" as const, actorUserId: null };

  it("stamps updated_at with the transaction clock", () => {
    expect(render(buildRegistryUpdateBatch({ rows, actor }))).toContain(
      "updated_at = now()",
    );
  });

  it("keeps the updated-BY stamp alongside it", () => {
    // The two travel together or the row lies about who last touched it.
    const text = render(buildRegistryUpdateBatch({ rows, actor }));
    expect(text).toContain("updated_by_actor =");
    expect(text).toContain("updated_by_user_id =");
  });

  it("binds one VALUES tuple per row and joins on the id", () => {
    const text = render(
      buildRegistryUpdateBatch({
        rows: [
          rows[0]!,
          { ...rows[0]!, id: "019f0b8b-25e8-7b13-acce-000000000001" },
        ],
        actor,
      }),
    );
    expect(text).toContain("FROM (VALUES ($");
    expect(text).toContain("WHERE r.id = v.id");
    // Bare SET targets, source read from the VALUES alias — Postgres rejects an
    // alias-qualified target, the same rule `buildExtensionUpdateBatch` follows.
    expect(text).toContain("SET label = v.label");
    expect(text).not.toContain("r.label =");
  });
});
