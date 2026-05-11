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

await runMigrationsWithLock();

export default db;
