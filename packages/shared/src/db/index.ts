import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { resolve } from "node:path";
import { Client } from "pg";
import { relations } from "./relations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw "Missing env var DATABASE_URL";
}

const db = drizzle(databaseUrl, {
  logger: process.env.NODE_ENV != "production",
  relations,
});

/**
 * A Drizzle transaction handle — the argument the `db.transaction` callback
 * receives. The canonical type for services that accept an optional `tx` so a
 * mutation and its dependent writes (e.g. the domain-events outbox) commit
 * atomically. Import this rather than re-deriving `Parameters<…>` locally.
 */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MIGRATION_LOCK_ID = 4242424242424242n;

export const runMigrationsWithLock = async () => {
  const lockClient = new Client({ connectionString: databaseUrl });
  await lockClient.connect();

  try {
    console.log("[Migrations] Acquiring advisory lock…");
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    console.log("[Migrations] Lock acquired, running migrations…");

    await migrate(db, {
      migrationsFolder: resolve(import.meta.dir, "../../drizzle"),
    });

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

// Skip auto-migration under `bun test` — unit tests don't have a
// real Postgres reachable and the eager `connect()` inside the
// advisory-lock client would crash the top-level await. Production
// + dev (NODE_ENV unset, "development", or "production") still
// auto-migrate at boot exactly as before.
if (process.env.NODE_ENV !== "test") {
  await runMigrationsWithLock();
}

export default db;
