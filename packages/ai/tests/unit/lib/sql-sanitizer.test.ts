import { describe, expect, test } from "bun:test";
import {
  MAX_SQL_LIMIT,
  SqlValidationException,
  sanitizeSelect,
} from "../../../src/lib/sql-sanitizer";

/**
 * Security-critical tests for the agent-facing SQL sanitizer. These
 * are deterministic (pure function, no DB, no LLM) so they belong in
 * unit tests — the live-LLM eval harness can't reliably exercise the
 * blocked-identifier / placeholder-contract branches because the
 * sanitised model won't emit the bad SQL in the first place.
 *
 * The tests mirror every failure path documented on
 * `SqlValidationError.code`:
 *   - SQL_PARSE_FAILED
 *   - SQL_NOT_READ_ONLY
 *   - SQL_BLOCKED_IDENTIFIER
 *   - SQL_MISSING_PLACEHOLDER
 */

const TEAM_ID = "019cd97b-326e-7000-9ebe-96def6cc53df";

const expectRejection = (
  sql: string,
  code:
    | "SQL_PARSE_FAILED"
    | "SQL_NOT_READ_ONLY"
    | "SQL_BLOCKED_IDENTIFIER"
    | "SQL_MISSING_PLACEHOLDER",
) => {
  try {
    sanitizeSelect(sql, TEAM_ID);
    throw new Error(`Expected rejection with ${code}, got success`);
  } catch (err) {
    expect(err).toBeInstanceOf(SqlValidationException);
    if (err instanceof SqlValidationException) {
      expect(err.error.code).toBe(code);
    }
  }
};

describe("sanitizeSelect — happy path", () => {
  test("accepts a well-formed SELECT with the placeholder", () => {
    const sql = sanitizeSelect(
      "SELECT id, name FROM documents WHERE team_id = __TEAM_ID__",
      TEAM_ID,
    );
    expect(sql).toContain(`'${TEAM_ID}'`);
    expect(sql).not.toContain("__TEAM_ID__");
    expect(sql).not.toMatch(/;$/);
  });

  test("accepts WITH (CTE) statements", () => {
    const sql = sanitizeSelect(
      "WITH x AS (SELECT * FROM documents WHERE team_id = __TEAM_ID__) SELECT * FROM x",
      TEAM_ID,
    );
    expect(sql).toContain(`'${TEAM_ID}'`);
  });

  test("strips trailing semicolon before parsing", () => {
    const sql = sanitizeSelect(
      "SELECT 1 FROM documents WHERE team_id = __TEAM_ID__;",
      TEAM_ID,
    );
    expect(sql.endsWith(";")).toBe(false);
  });

  test("handles both quoted and unquoted placeholder forms", () => {
    const unquoted = sanitizeSelect(
      "SELECT 1 FROM documents WHERE team_id = __TEAM_ID__",
      TEAM_ID,
    );
    const quoted = sanitizeSelect(
      "SELECT 1 FROM documents WHERE team_id = '__TEAM_ID__'",
      TEAM_ID,
    );
    expect(unquoted).toBe(quoted);
    expect(unquoted).toContain(`'${TEAM_ID}'`);
    expect(quoted).not.toContain("''");
  });

  test("escapes single quotes in the teamId literal", () => {
    const teamWithQuote = "00000000-0000-'evil'-8000-000000000001";
    const sql = sanitizeSelect(
      "SELECT 1 FROM documents WHERE team_id = __TEAM_ID__",
      teamWithQuote,
    );
    // Doubled-up single quotes are the Postgres-standard literal escape.
    expect(sql).toContain("''evil''");
  });

  test("MAX_SQL_LIMIT is a sensible positive integer", () => {
    expect(Number.isInteger(MAX_SQL_LIMIT)).toBe(true);
    expect(MAX_SQL_LIMIT).toBeGreaterThan(0);
  });
});

describe("sanitizeSelect — rejections", () => {
  test("rejects an empty / whitespace string", () => {
    expectRejection("   ", "SQL_PARSE_FAILED");
  });

  test("rejects garbage SQL", () => {
    expectRejection("this is not sql", "SQL_PARSE_FAILED");
  });

  test("rejects INSERT", () => {
    expectRejection(
      "INSERT INTO documents (name) VALUES ('x')",
      "SQL_NOT_READ_ONLY",
    );
  });

  test("rejects UPDATE", () => {
    expectRejection(
      "UPDATE documents SET name='x' WHERE team_id = __TEAM_ID__",
      "SQL_NOT_READ_ONLY",
    );
  });

  test("rejects DELETE", () => {
    expectRejection(
      "DELETE FROM documents WHERE team_id = __TEAM_ID__",
      "SQL_NOT_READ_ONLY",
    );
  });

  test("rejects DROP", () => {
    expectRejection("DROP TABLE documents", "SQL_NOT_READ_ONLY");
  });

  test("rejects CREATE", () => {
    expectRejection("CREATE TABLE foo (id INT)", "SQL_NOT_READ_ONLY");
  });

  test("rejects pg_catalog access", () => {
    expectRejection(
      "SELECT * FROM pg_catalog.pg_tables WHERE team_id = __TEAM_ID__",
      "SQL_BLOCKED_IDENTIFIER",
    );
  });

  test("rejects information_schema access", () => {
    expectRejection(
      "SELECT * FROM information_schema.tables WHERE team_id = __TEAM_ID__",
      "SQL_BLOCKED_IDENTIFIER",
    );
  });

  test("rejects pg_sleep — blocked even via call expression", () => {
    expectRejection(
      "SELECT pg_sleep(10) WHERE team_id = __TEAM_ID__",
      "SQL_BLOCKED_IDENTIFIER",
    );
  });

  test("rejects dblink as a table reference", () => {
    // Use parseable SQL that still contains the "dblink" substring —
    // the sanitizer's blocked-identifier check is a substring scan
    // that runs AFTER parse, so the SQL must tokenize first.
    expectRejection(
      "SELECT 1 FROM dblink WHERE team_id = __TEAM_ID__",
      "SQL_BLOCKED_IDENTIFIER",
    );
  });

  test("rejects uppercase blocked identifiers (case-insensitive match)", () => {
    expectRejection(
      "SELECT * FROM PG_CATALOG.pg_tables WHERE team_id = __TEAM_ID__",
      "SQL_BLOCKED_IDENTIFIER",
    );
  });

  test("rejects queries missing the __TEAM_ID__ placeholder", () => {
    expectRejection("SELECT 1 FROM documents", "SQL_MISSING_PLACEHOLDER");
  });

  test("blocked-identifier rejection wins over missing-placeholder", () => {
    // Both failures apply — the blocked check runs before the
    // placeholder check, so that's the code we expect.
    expectRejection(
      "SELECT * FROM pg_catalog.pg_tables",
      "SQL_BLOCKED_IDENTIFIER",
    );
  });
});
