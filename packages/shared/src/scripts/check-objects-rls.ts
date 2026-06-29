// oxlint-disable no-await-in-loop
import { eq, inArray, sql } from "drizzle-orm";
import { Client } from "pg";
import db from "../db";
import {
  objectGrants,
  objectRecords,
  objectTypes,
  recordShares,
  team,
} from "../db/schema";
import {
  qualifiedObjectTable,
  SQL_TOOL_ROLE,
  SYS_COL,
} from "../services/object-schema/identifiers";
import {
  dropObjectTable,
  reconcileObjectTable,
} from "../services/object-schema/table";

/**
 * Deterministic RLS / grant verification for the objects refonte — the repeatable
 * "is the data plane actually fenced?" check (P7), not a one-off eyeball.
 *
 * Two phases:
 *   1. STRUCTURAL (owner connection, read-only): every `data.obj_*` extension
 *      table has `rowsecurity = on`, the `sql_tool_read` policy, and a SELECT
 *      grant to the `fretik_sql_tool` role; the registry/catalog tables
 *      (`object_records`, `object_types`) keep their sharing-aware policies; the
 *      `fretik_*` RLS helper functions exist.
 *   2. FUNCTIONAL (as the `fretik_sql_tool` role): builds a throwaway fixture
 *      (two temp teams in an existing org + a temp type + two records owned by
 *      team A), then proves — connecting AS the least-privilege role with the
 *      per-transaction `fretik.team_id` / `fretik.organization_id` GUCs set —
 *      that team A sees its own rows, team B is isolated, and a type GRANT /
 *      record SHARE (team-scoped and org-wide) flips visibility on and off.
 *      Everything is torn down in `finally`.
 *
 * Run from `backend/packages/shared`:
 *   bun --env-file=../../.env run src/scripts/check-objects-rls.ts
 * Provide `AI_DB_READONLY_URL` (the `fretik_sql_tool` role connection) to run the
 * functional phase; without it the script runs STRUCTURAL-only and warns.
 */

let failures = 0;
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);
const fail = (msg: string): void => {
  failures += 1;
  console.error(`  ✗ ${msg}`);
};
const check = (cond: boolean, msg: string): void =>
  cond ? ok(msg) : fail(msg);

const TEMP_TAG = "__rls_check_temp__";

// ── Phase 1: structural ────────────────────────────────────────────────────

const structural = async (): Promise<void> => {
  console.log("\n[1/2] Structural — RLS armed on every data.obj_* + catalog\n");

  // Every per-type extension table.
  const tables = await db.execute<{ tablename: string; rowsecurity: boolean }>(
    sql`SELECT tablename, rowsecurity FROM pg_tables
        WHERE schemaname = 'data' AND tablename LIKE 'obj\\_%' ESCAPE '\\'
        ORDER BY tablename`,
  );
  console.log(`Found ${tables.rows.length.toString()} data.obj_* table(s).`);

  for (const { tablename, rowsecurity } of tables.rows) {
    check(rowsecurity, `data.${tablename}: rowsecurity = on`);

    const pol = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_policies
          WHERE schemaname = 'data' AND tablename = ${tablename}
            AND policyname = 'sql_tool_read'`,
    );
    check(
      (pol.rows[0]?.n ?? 0) === 1,
      `data.${tablename}: sql_tool_read policy present`,
    );

    const grant = await db.execute<{ has: boolean }>(
      sql`SELECT has_table_privilege(${SQL_TOOL_ROLE}, ${"data." + tablename}, 'SELECT') AS has`,
    );
    check(
      grant.rows[0]?.has === true,
      `data.${tablename}: SELECT granted to ${SQL_TOOL_ROLE}`,
    );
  }

  // Registry + catalog sharing-aware policies.
  for (const [tbl, policy] of [
    ["object_records", "sql_tool_team_isolation"],
    ["object_types", "sql_tool_team_isolation"],
  ] as const) {
    const r = await db.execute<{ rowsecurity: boolean }>(
      sql`SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = ${tbl}`,
    );
    check(r.rows[0]?.rowsecurity === true, `${tbl}: rowsecurity = on`);
    const pol = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ${tbl} AND policyname = ${policy}`,
    );
    check((pol.rows[0]?.n ?? 0) === 1, `${tbl}: ${policy} policy present`);
    const grant = await db.execute<{ has: boolean }>(
      sql`SELECT has_table_privilege(${SQL_TOOL_ROLE}, ${tbl}, 'SELECT') AS has`,
    );
    check(
      grant.rows[0]?.has === true,
      `${tbl}: SELECT granted to ${SQL_TOOL_ROLE}`,
    );
    // Both catalog/registry policies must be grant-aware (call fretik_type_granted),
    // else a shared foreign type's rows are invisible to the SQL role.
    const qual = await db.execute<{ qual: string | null }>(
      sql`SELECT qual FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ${tbl} AND policyname = ${policy}`,
    );
    check(
      (qual.rows[0]?.qual ?? "").includes("fretik_type_granted"),
      `${tbl}: ${policy} is grant-aware (fretik_type_granted)`,
    );
  }

  // RLS helper functions.
  for (const fn of [
    "fretik_team",
    "fretik_org",
    "fretik_type_granted",
    "fretik_record_shared",
  ]) {
    const r = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_proc WHERE proname = ${fn}`,
    );
    check((r.rows[0]?.n ?? 0) >= 1, `function ${fn}() exists`);
  }
};

// ── Phase 2: functional ────────────────────────────────────────────────────

interface Fixture {
  orgId: string;
  teamA: string;
  teamB: string;
  typeId: string;
  recordIds: string[];
}

const buildFixture = async (orgId: string): Promise<Fixture> => {
  const now = new Date();
  const [a, b] = await db
    .insert(team)
    .values([
      {
        name: `${TEMP_TAG}_A`,
        organizationId: orgId,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: `${TEMP_TAG}_B`,
        organizationId: orgId,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .returning({ id: team.id });
  const teamA = a!.id;
  const teamB = b!.id;

  const [t] = await db
    .insert(objectTypes)
    .values({
      organizationId: orgId,
      teamId: teamA,
      key: "zz_rls_check_tmp",
      label: "RLS check (temp)",
    })
    .returning({ id: objectTypes.id });
  const typeId = t!.id;

  // Build + arm the extension table through the real DDL engine (so the
  // structural arm we assert is the engine's actual output, not a copy).
  await reconcileObjectTable({ objectTypeId: typeId });

  const recs = await db
    .insert(objectRecords)
    .values([
      {
        organizationId: orgId,
        teamId: teamA,
        objectTypeId: typeId,
        label: "row 1",
      },
      {
        organizationId: orgId,
        teamId: teamA,
        objectTypeId: typeId,
        label: "row 2",
      },
    ])
    .returning({ id: objectRecords.id });
  const recordIds = recs.map((r) => r.id);

  const tbl = qualifiedObjectTable(typeId);
  const cols = sql.raw(`${SYS_COL.id}, ${SYS_COL.team}, ${SYS_COL.label}`);
  for (const id of recordIds) {
    await db.execute(
      sql`INSERT INTO ${sql.raw(tbl)} (${cols}) VALUES (${id}, ${teamA}, 'row')`,
    );
  }
  return { orgId, teamA, teamB, typeId, recordIds };
};

const teardown = async (fx: Fixture): Promise<void> => {
  // Drop the engine-managed table explicitly (no DB cascade owns it), then let
  // the team cascade clear records / grants / shares / the type row.
  await dropObjectTable({ objectTypeId: fx.typeId }).catch(() => {});
  await db.delete(team).where(inArray(team.id, [fx.teamA, fx.teamB]));
};

const functional = async (readonlyUrl: string): Promise<void> => {
  console.log("\n[2/2] Functional — isolation + grant/share as the SQL role\n");

  const orgRow = await db.execute<{ id: string }>(
    sql`SELECT id FROM organization LIMIT 1`,
  );
  const orgId = orgRow.rows[0]?.id;
  if (!orgId) {
    console.warn(
      "  ⚠ no organization in DB — skipping functional phase (seed first).",
    );
    return;
  }

  const role = new Client({ connectionString: readonlyUrl });
  await role.connect();

  // Count visible rows of the fixture type AS the role, scoped to a team.
  const visibleAs = async (fx: Fixture, teamId: string): Promise<number> => {
    await role.query("BEGIN");
    try {
      await role.query(
        "SELECT set_config('fretik.team_id', $1, true), set_config('fretik.organization_id', $2, true)",
        [teamId, fx.orgId],
      );
      const r = await role.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM ${qualifiedObjectTable(fx.typeId)}`,
      );
      return Number(r.rows[0]?.n ?? 0);
    } finally {
      await role.query("COMMIT").catch(() => {});
    }
  };

  // Count the type's own CATALOG row (object_types) AS the role — the gap the
  // grant-aware object_types policy closes (data rows were already grant-aware).
  const typeRowVisibleAs = async (
    fx: Fixture,
    teamId: string,
  ): Promise<number> => {
    await role.query("BEGIN");
    try {
      await role.query(
        "SELECT set_config('fretik.team_id', $1, true), set_config('fretik.organization_id', $2, true)",
        [teamId, fx.orgId],
      );
      const r = await role.query<{ n: string }>(
        "SELECT count(*)::int AS n FROM object_types WHERE id = $1",
        [fx.typeId],
      );
      return Number(r.rows[0]?.n ?? 0);
    } finally {
      await role.query("COMMIT").catch(() => {});
    }
  };

  let fx: Fixture | null = null;
  try {
    fx = await buildFixture(orgId);

    check(
      (await visibleAs(fx, fx.teamA)) === 2,
      "owner team A sees its 2 rows",
    );
    check(
      (await visibleAs(fx, fx.teamB)) === 0,
      "team B isolated (0 rows, no grant)",
    );
    check(
      (await typeRowVisibleAs(fx, fx.teamB)) === 0,
      "team B cannot see the foreign type's catalog row (no grant)",
    );

    // Type grant (team-scoped) flips all rows on, revoke flips off.
    await db.insert(objectGrants).values({
      organizationId: fx.orgId,
      objectTypeId: fx.typeId,
      ownerTeamId: fx.teamA,
      granteeTeamId: fx.teamB,
      permission: "read",
    });
    check(
      (await visibleAs(fx, fx.teamB)) === 2,
      "type grant → team B sees all rows",
    );
    check(
      (await typeRowVisibleAs(fx, fx.teamB)) === 1,
      "type grant → team B sees the type's catalog row",
    );
    await db
      .delete(objectGrants)
      .where(eq(objectGrants.objectTypeId, fx.typeId));
    check(
      (await visibleAs(fx, fx.teamB)) === 0,
      "revoke type grant → team B blocked again",
    );

    // Org-wide type grant (granteeTeamId NULL) also makes B see.
    await db.insert(objectGrants).values({
      organizationId: fx.orgId,
      objectTypeId: fx.typeId,
      ownerTeamId: fx.teamA,
      granteeTeamId: null,
      permission: "read",
    });
    check(
      (await visibleAs(fx, fx.teamB)) === 2,
      "org-wide grant → team B sees all rows",
    );
    await db
      .delete(objectGrants)
      .where(eq(objectGrants.objectTypeId, fx.typeId));

    // Record share (single record) flips exactly one row on, unshare flips off.
    await db.insert(recordShares).values({
      organizationId: fx.orgId,
      recordId: fx.recordIds[0]!,
      ownerTeamId: fx.teamA,
      granteeTeamId: fx.teamB,
      permission: "read",
    });
    check(
      (await visibleAs(fx, fx.teamB)) === 1,
      "record share → team B sees exactly 1 row",
    );
    await db
      .delete(recordShares)
      .where(eq(recordShares.recordId, fx.recordIds[0]!));
    check(
      (await visibleAs(fx, fx.teamB)) === 0,
      "unshare record → team B blocked again",
    );
  } finally {
    await role.end().catch(() => {});
    if (fx) await teardown(fx);
  }
};

// ── Entry ───────────────────────────────────────────────────────────────────

const run = async (): Promise<void> => {
  await structural();

  const readonlyUrl = process.env.AI_DB_READONLY_URL;
  if (readonlyUrl) {
    await functional(readonlyUrl);
  } else {
    console.warn(
      "\n  ⚠ AI_DB_READONLY_URL not set — skipping functional phase. " +
        "Pass it (the fretik_sql_tool role) to prove isolation/grant/share end-to-end.",
    );
  }

  console.log(
    failures === 0
      ? "\n✅ RLS check passed.\n"
      : `\n❌ RLS check FAILED — ${failures.toString()} assertion(s).\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error("[check-objects-rls] crashed:", error);
  process.exit(1);
});
