import { drizzle } from "drizzle-orm/node-postgres";
import { relations } from "./relations";

/**
 * The database handle — and NOTHING else.
 *
 * This module used to end by applying migrations at import time, so every
 * process that read a row also had the power to rewrite the schema of whatever
 * `DATABASE_URL` pointed at. See `./migrations.ts` for the incident that
 * caused, and for the explicit entry points that replaced it.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Missing env var DATABASE_URL");
}

const db = drizzle(databaseUrl, {
  // Everywhere but production AND tests. It used to be "anything but
  // production", which meant an integration run printed every statement it
  // issued — several hundred lines per file, with the one failing assertion
  // buried somewhere inside them.
  logger:
    process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test",
  relations,
});

/**
 * A Drizzle transaction handle — the argument the `db.transaction` callback
 * receives. The canonical type for services that accept an optional `tx` so a
 * mutation and its dependent writes (e.g. the domain-events outbox) commit
 * atomically. Import this rather than re-deriving `Parameters<…>` locally.
 */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A read/write executor: either the root `db` or an open `Transaction`. The
 * canonical parameter type for helpers that run a statement on whichever handle
 * the caller has — declared ONCE here and reused everywhere (no per-file
 * re-declaration). Services that own their transaction boundary should still
 * take `tx?: Transaction` and resolve `const exec = tx ?? db`.
 */
export type Executor = typeof db | Transaction;

export default db;
