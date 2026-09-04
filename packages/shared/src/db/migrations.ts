import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { resolve } from "node:path";
import { Client } from "pg";
import db from "./index";

/**
 * Applying migrations — an EXPLICIT act, never a side effect of importing the
 * database.
 *
 * `db/index.ts` used to end with `if (NODE_ENV !== "test") await
 * runMigrationsWithLock()`, so every process that touched the database
 * migrated it, using the migration folder of whatever checkout it happened to
 * be running from. On 2026-08-30 that turned an ordinary
 * `bun run models:admin` — a laptop, a tunnel, a read-only intent — into an
 * `ALTER TABLE account ADD COLUMN issuer NOT NULL` against production, two
 * days before the code that fills the column shipped. Every sign-up returned
 * 500 until the next deploy.
 *
 * The mechanism, not the mistake, is what is fixed here: nothing migrates
 * unless it says who authorised it.
 */

/**
 * Who is asking, and what makes that legitimate.
 *
 * `service-boot` is a container starting up. It is only honoured when the
 * deployment opted in with `RUN_MIGRATIONS=true`, which is set on the Dokploy
 * services and nowhere else — so a laptop, a CI job or a script that happens
 * to boot the same code migrates nothing.
 *
 * `operator` is a human running `db:migrate`, and carries the target the
 * operator guard resolved. Naming the target is the point: it is what the log
 * line prints, and what makes "I thought I was on dev" impossible to say
 * afterwards.
 */
export type MigrationAuthority =
  { kind: "service-boot" } | { kind: "operator"; target: string };

const MIGRATION_LOCK_ID = 4242424242424242n;

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../drizzle");

/** A `created_at` from the ledger, floored to the second `migrate()` compares on. */
const migrationMillis = (value: unknown): number =>
  Math.floor(Number(value) / 1000) * 1000;

/**
 * One row of `drizzle.__drizzle_migrations`, as this module reads it.
 *
 * A type alias rather than an interface: `db.execute<T>` wants a
 * `Record<string, unknown>`, and only an alias gets the implicit index
 * signature that satisfies it.
 */
export type MigrationLedgerRow = {
  name: string | null;
  created_at: string | number | null;
  hash: string;
};

/** A migration file on disk, as `readMigrationFiles` returns it. */
export interface MigrationFile {
  name: string;
  folderMillis: number;
  hash: string;
}

export interface MigrationState {
  applied: number;
  pending: string[];
  drifted: string[];
}

/**
 * The comparison itself, over values — the rule, with no database in the way.
 *
 * `named` is whether the ledger carries a `name` column: with one, `migrate()`
 * runs whatever name it has never seen; without one, it first backfills names
 * by matching each row to a file on `created_at`, and only then compares. Both
 * are identity. Neither is the hash.
 */
export const compareMigrationLedger = (
  onDisk: MigrationFile[],
  rows: MigrationLedgerRow[],
  named: boolean,
): MigrationState => {
  const appliedHash = new Map<string, string>();
  for (const row of rows) {
    const key = named
      ? (row.name ?? "")
      : migrationMillis(row.created_at).toString();
    if (key !== "") appliedHash.set(key, row.hash);
  }

  const pending: string[] = [];
  const drifted: string[] = [];
  for (const file of onDisk) {
    const key = named
      ? file.name
      : migrationMillis(file.folderMillis).toString();
    const hash = appliedHash.get(key);
    if (hash === undefined) pending.push(file.name);
    else if (hash !== file.hash) drifted.push(file.name);
  }

  return { applied: appliedHash.size, pending, drifted };
};

/**
 * Migrations present in this build but not yet applied to the target.
 *
 * "Pending" means exactly one thing: `migrate()` would apply it. So this reads
 * the ledger the way `migrate()` reads it — **by identity, never by content**.
 * Drizzle ≥1.0 selects what to run by migration NAME; on the older ledger shape
 * that has no `name` column it first backfills one, matching each row to a file
 * by `created_at`. Both rules are reproduced below.
 *
 * Comparing HASHES instead — which this did until 2026-09-04 — answers a
 * different question, and answers it in a way no operator can act on. A
 * migration edited after it was applied keeps its row and its timestamp but
 * loses its hash, so it reads as pending forever: `db:migrate` runs, `migrate()`
 * correctly does nothing, and the next service boot crashes on the same two
 * names. CI never saw it because CI migrates an empty database, where every
 * hash is written by the file that is on disk.
 *
 * That divergence is still worth knowing, so it is reported as `drifted` —
 * applied, but the file no longer says what was run, which means a database
 * rebuilt from scratch would not get this one's schema. It blocks nothing,
 * because nothing an operator runs can clear it; the remedy is a new migration.
 *
 * STRICTLY READ-ONLY, including on a database that has never been migrated:
 * the bookkeeping table is probed with `to_regclass` rather than created, and
 * its absence answers "every migration is pending" — which is the truth, and
 * the whole point of a function two of whose three callers exist precisely
 * because they must not write. `migrate()` creates the table when it runs.
 */
export const listPendingMigrations = async (): Promise<MigrationState> => {
  const onDisk = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const all = {
    applied: 0,
    pending: onDisk.map((file) => file.name),
    drifted: [],
  };

  const ledger = await db.execute<{ present: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  );
  if (ledger.rows[0]?.present !== true) return all;

  const columns = await db.execute<{ column_name: string }>(
    sql`select column_name from information_schema.columns
        where table_schema = 'drizzle' and table_name = '__drizzle_migrations'`,
  );
  const named = columns.rows.some((row) => row.column_name === "name");

  const rows = await db.execute<MigrationLedgerRow>(
    named
      ? sql`select name, created_at, hash from drizzle.__drizzle_migrations`
      : sql`select null as name, created_at, hash from drizzle.__drizzle_migrations`,
  );

  return compareMigrationLedger(onDisk, rows.rows, named);
};

/**
 * Apply pending migrations under a Postgres advisory lock.
 *
 * The lock makes concurrent boots safe — the three services deploy in no
 * guaranteed order, whichever arrives first migrates and the others wait, then
 * find nothing to do. Unchanged from the original implementation; what is new
 * is that it refuses to run for an authority the environment does not back.
 */
export const runMigrationsWithLock = async (
  authority: MigrationAuthority,
): Promise<void> => {
  if (
    authority.kind === "service-boot" &&
    process.env.RUN_MIGRATIONS !== "true"
  ) {
    throw new Error(
      'Refusing to migrate: this service did not opt in. Set RUN_MIGRATIONS="true" on the deployment, or run `db:migrate` as an operator.',
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error("Missing env var DATABASE_URL");
  }

  const who =
    authority.kind === "operator"
      ? `operator target=${authority.target}`
      : "service-boot";

  const lockClient = new Client({ connectionString: databaseUrl });
  await lockClient.connect();

  try {
    console.log(`[Migrations] authority=${who} — acquiring advisory lock…`);
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    console.log("[Migrations] Lock acquired, running migrations…");

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    console.log("[Migrations] Done");
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [
        MIGRATION_LOCK_ID,
      ]);
    } catch (err) {
      console.error("[Migrations] Failed to release advisory lock:", err);
    }
    await lockClient.end();
  }
};

/**
 * Fail the boot when the schema is older than the code.
 *
 * Called by every service that does NOT migrate. Continuing would mean new
 * code on an old schema — the incident's second half, and the half that is
 * silent: the service answers requests and fails only on the columns it cannot
 * find. A crash loop is loud, the old container keeps serving behind the
 * healthcheck, and the deploy is visibly stuck rather than invisibly broken.
 */
export const assertMigrationsCurrent = async (
  service: string,
): Promise<void> => {
  const { applied, pending } = await listPendingMigrations();
  if (pending.length === 0) {
    console.log(
      `[Migrations] ${service}: schema is current (${applied.toString()} applied)`,
    );
    return;
  }
  throw new Error(
    `[Migrations] ${service}: ${pending.length.toString()} pending migration(s) (${pending.join(", ")}). Set RUN_MIGRATIONS="true" on a service that should migrate, or run \`bun run --filter '@fretik/shared' db:migrate\`.`,
  );
};
