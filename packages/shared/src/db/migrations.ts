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

/**
 * Migrations present in this build but not yet applied to the target.
 *
 * Reads the same folder and the same bookkeeping table `migrate()` writes, so
 * "pending" here means exactly "`migrate()` would apply it".
 *
 * STRICTLY READ-ONLY, including on a database that has never been migrated:
 * the bookkeeping table is probed with `to_regclass` rather than created, and
 * its absence answers "every migration is pending" — which is the truth, and
 * the whole point of a function two of whose three callers exist precisely
 * because they must not write. `migrate()` creates the table when it runs.
 */
export const listPendingMigrations = async (): Promise<{
  applied: number;
  pending: string[];
}> => {
  const onDisk = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const all = { applied: 0, pending: onDisk.map((file) => file.name) };

  const ledger = await db.execute(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  );
  const present = (ledger.rows[0] as { present: boolean } | undefined)?.present;
  if (present !== true) return all;

  const rows = await db.execute(
    sql`select hash from drizzle.__drizzle_migrations`,
  );
  const applied = new Set(
    rows.rows.map((row) => String((row as { hash: unknown }).hash)),
  );

  return {
    applied: applied.size,
    pending: onDisk
      .filter((file) => !applied.has(file.hash))
      .map((file) => file.name),
  };
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
