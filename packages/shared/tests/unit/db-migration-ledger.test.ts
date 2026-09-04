import { describe, expect, test } from "bun:test";
import {
  compareMigrationLedger,
  type MigrationFile,
  type MigrationLedgerRow,
} from "../../src/db/migrations";

/**
 * What "pending" is allowed to mean.
 *
 * A service that does not migrate crashes its boot on this answer, so a wrong
 * one is not a wrong number — it is a deployment that cannot start and an
 * operator with nothing to run. That is what happened on 2026-09-04: two
 * migrations edited weeks after they were applied kept their rows and lost
 * their hashes, the check compared hashes, and `db:migrate` cleared nothing
 * because `migrate()` compares names and correctly did nothing.
 *
 * Every case below is therefore the same question: does this agree with what
 * `migrate()` would actually apply?
 */

const file = (
  name: string,
  hash: string,
  folderMillis: number,
): MigrationFile => ({ name, hash, folderMillis });

const row = (
  name: string | null,
  hash: string,
  created_at: string | number,
): MigrationLedgerRow => ({ name, hash, created_at });

describe("compareMigrationLedger — a ledger that carries names", () => {
  test("a migration edited after it was applied is not pending", () => {
    // The whole defect in one case: same name, same timestamp, different
    // bytes. `migrate()` skips it, so nothing may block a boot on it.
    const state = compareMigrationLedger(
      [file("20260612123154_harden_sql_tool", "428d7b", 1781267514000)],
      [row("20260612123154_harden_sql_tool", "c0c49e", 1781267514000)],
      true,
    );

    expect(state.pending).toEqual([]);
    // Reported, though: a database rebuilt from these files today would run
    // SQL this one never ran.
    expect(state.drifted).toEqual(["20260612123154_harden_sql_tool"]);
  });

  test("a name the ledger has never seen is pending", () => {
    const state = compareMigrationLedger(
      [
        file("20260612123154_harden_sql_tool", "428d7b", 1781267514000),
        file("20260902233253_amazing_grandmaster", "9f01aa", 1788391973000),
      ],
      [row("20260612123154_harden_sql_tool", "428d7b", 1781267514000)],
      true,
    );

    expect(state.pending).toEqual(["20260902233253_amazing_grandmaster"]);
    expect(state.drifted).toEqual([]);
  });

  test("an untouched migration is neither pending nor drifted", () => {
    const state = compareMigrationLedger(
      [file("20260612123154_harden_sql_tool", "428d7b", 1781267514000)],
      [row("20260612123154_harden_sql_tool", "428d7b", 1781267514000)],
      true,
    );

    expect(state).toEqual({ applied: 1, pending: [], drifted: [] });
  });

  test("a database that has never been migrated has everything pending", () => {
    const state = compareMigrationLedger(
      [file("20260612123154_harden_sql_tool", "428d7b", 1781267514000)],
      [],
      true,
    );

    expect(state.pending).toEqual(["20260612123154_harden_sql_tool"]);
  });
});

describe("compareMigrationLedger — the older ledger, with no name column", () => {
  test("rows are matched on their timestamp, drift included", () => {
    // `migrate()` backfills the missing names by `created_at` before it
    // compares anything, so reading this shape by hash would call an applied
    // migration pending — and then apply it a second time.
    const state = compareMigrationLedger(
      [file("20260612123154_harden_sql_tool", "428d7b", 1781267514000)],
      [row(null, "c0c49e", 1781267514000)],
      false,
    );

    expect(state.pending).toEqual([]);
    expect(state.drifted).toEqual(["20260612123154_harden_sql_tool"]);
  });

  test("a bigint `created_at` arrives as a string and still matches", () => {
    // `pg` hands back `bigint` as text. A strict comparison against the
    // number on disk would call every applied migration pending.
    const state = compareMigrationLedger(
      [file("20260612123154_harden_sql_tool", "428d7b", 1781267514000)],
      [row(null, "428d7b", "1781267514000")],
      false,
    );

    expect(state.pending).toEqual([]);
  });

  test("sub-second precision in the ledger does not lose the match", () => {
    // Folder timestamps have a second's resolution; a legacy row may carry
    // more. Both sides are floored, which is what drizzle's own upgrade does.
    const state = compareMigrationLedger(
      [file("20260612123154_harden_sql_tool", "428d7b", 1781267514000)],
      [row(null, "428d7b", "1781267514873")],
      false,
    );

    expect(state.pending).toEqual([]);
  });
});
