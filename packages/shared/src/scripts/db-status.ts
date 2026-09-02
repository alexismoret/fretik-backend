import { sql } from "drizzle-orm";
import db from "../db";
import { listPendingMigrations } from "../db/migrations";

/**
 * What schema is this database on, and which database is it?
 *
 * Read-only, by design and by need: the first question after "did the deploy
 * land" is whether the schema moved, and asking it must never be the thing
 * that moves it. It also prints the target the connection actually resolved to
 * — `current_database()` and the server's own address, not what the operator
 * believes the URL says — because an SSH tunnel makes production look exactly
 * like `127.0.0.1`, and that resemblance is what caused the 2026-08-30
 * incident.
 *
 * Exits 1 when migrations are pending, so it can gate a deploy check.
 */
const main = async (): Promise<void> => {
  const target = await db.execute(
    sql`select current_database() as database, inet_server_addr()::text as host, inet_server_port() as port, current_user as "user"`,
  );
  const row = target.rows[0] as
    | {
        database: string;
        host: string | null;
        port: number;
        user: string;
      }
    | undefined;

  if (row === undefined) {
    throw new Error("The database answered no row for current_database()");
  }

  console.log(
    `target: ${row.database} on ${row.host ?? "local socket"}:${row.port.toString()} as ${row.user}`,
  );

  const { applied, pending } = await listPendingMigrations();
  console.log(`applied: ${applied.toString()}`);

  if (pending.length === 0) {
    console.log("pending: none — the schema is current");
    process.exit(0);
  }

  console.log(`pending: ${pending.length.toString()}`);
  for (const name of pending) console.log(`  - ${name}`);
  console.log(
    "\nNothing was applied. Migrations run at the boot of a service carrying " +
      'RUN_MIGRATIONS="true", or through `bun run db:migrate`.',
  );
  process.exit(1);
};

await main();
