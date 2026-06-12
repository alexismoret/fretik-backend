import { describe, expect, test } from "bun:test";
import {
  MAX_SQL_LIMIT,
  SqlValidationException,
  sanitizeSelect,
} from "../../../src/lib/sql-sanitizer";

/**
 * Security-critical tests for the agent-facing SQL sanitizer. These are
 * deterministic (pure function, no DB, no LLM) so they belong in unit tests —
 * the live-LLM eval harness can't reliably exercise the not-read-only /
 * table-allowlist branches because the sanitised model won't emit the bad SQL
 * in the first place.
 *
 * Team/org scoping is enforced by the database (RLS + the `fretik_sql_tool`
 * role), NOT by this function — so there is no placeholder contract here.
 * The sanitizer's job is: parse, allow only SELECT/WITH, and reject any
 * relation outside the product allowlist.
 *
 * The tests mirror every failure path documented on `SqlValidationError.code`:
 *   - SQL_PARSE_FAILED
 *   - SQL_NOT_READ_ONLY
 *   - SQL_TABLE_NOT_ALLOWED
 */

const expectRejection = (
  sql: string,
  code: "SQL_PARSE_FAILED" | "SQL_NOT_READ_ONLY" | "SQL_TABLE_NOT_ALLOWED",
) => {
  try {
    sanitizeSelect(sql);
    throw new Error(`Expected rejection with ${code}, got success`);
  } catch (err) {
    expect(err).toBeInstanceOf(SqlValidationException);
    if (err instanceof SqlValidationException) {
      expect(err.error.code).toBe(code);
    }
  }
};

describe("sanitizeSelect — happy path", () => {
  test("accepts a well-formed SELECT on an allowed table", () => {
    const sql = sanitizeSelect(
      "SELECT id, name FROM documents WHERE status = 'ready'",
    );
    expect(sql).toBe("SELECT id, name FROM documents WHERE status = 'ready'");
  });

  test("accepts joins across allowed tables and the identity view", () => {
    const sql = sanitizeSelect(
      "SELECT m.name, count(d.id) FROM documents d JOIN chatbot_org_members m ON m.user_id = d.uploaded_by_id GROUP BY m.name",
    );
    expect(sql).toContain("chatbot_org_members");
  });

  test("accepts WITH (CTE) statements and treats the CTE name as a relation", () => {
    const sql = sanitizeSelect(
      "WITH recent AS (SELECT * FROM documents) SELECT * FROM recent",
    );
    expect(sql).toContain("recent");
  });

  test("accepts public-qualified table names", () => {
    const sql = sanitizeSelect("SELECT id FROM public.documents");
    expect(sql).toContain("documents");
  });

  test("strips trailing semicolon before parsing", () => {
    const sql = sanitizeSelect("SELECT 1 FROM documents;");
    expect(sql.endsWith(";")).toBe(false);
  });

  test("accepts a subquery on an allowed table", () => {
    const sql = sanitizeSelect("SELECT * FROM (SELECT id FROM entities) s");
    expect(sql).toContain("entities");
  });

  test("MAX_SQL_LIMIT is a sensible positive integer", () => {
    expect(Number.isInteger(MAX_SQL_LIMIT)).toBe(true);
    expect(MAX_SQL_LIMIT).toBeGreaterThan(0);
  });
});

describe("sanitizeSelect — read-only enforcement", () => {
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
    expectRejection("UPDATE documents SET name='x'", "SQL_NOT_READ_ONLY");
  });

  test("rejects DELETE", () => {
    expectRejection("DELETE FROM documents", "SQL_NOT_READ_ONLY");
  });

  test("rejects DROP", () => {
    expectRejection("DROP TABLE documents", "SQL_NOT_READ_ONLY");
  });

  test("rejects CREATE", () => {
    expectRejection("CREATE TABLE foo (id INT)", "SQL_NOT_READ_ONLY");
  });
});

describe("sanitizeSelect — table allowlist", () => {
  test("rejects auth/secret tables (account)", () => {
    expectRejection(
      "SELECT access_token, password FROM account",
      "SQL_TABLE_NOT_ALLOWED",
    );
  });

  test("rejects the raw user table (identity must go through the view)", () => {
    expectRejection('SELECT email FROM "user"', "SQL_TABLE_NOT_ALLOWED");
  });

  test("rejects two_factor (TOTP secrets)", () => {
    expectRejection("SELECT secret FROM two_factor", "SQL_TABLE_NOT_ALLOWED");
  });

  test("rejects unqualified system catalogs (pg_tables)", () => {
    expectRejection("SELECT tablename FROM pg_tables", "SQL_TABLE_NOT_ALLOWED");
  });

  test("rejects pg_roles enumeration", () => {
    expectRejection("SELECT rolname FROM pg_roles", "SQL_TABLE_NOT_ALLOWED");
  });

  test("rejects schema-qualified pg_catalog access", () => {
    expectRejection(
      "SELECT * FROM pg_catalog.pg_tables",
      "SQL_TABLE_NOT_ALLOWED",
    );
  });

  test("rejects information_schema access", () => {
    expectRejection(
      "SELECT * FROM information_schema.tables",
      "SQL_TABLE_NOT_ALLOWED",
    );
  });

  test("rejects an unknown product table", () => {
    expectRejection("SELECT * FROM secrets_table", "SQL_TABLE_NOT_ALLOWED");
  });

  test("rejects a forbidden table joined onto an allowed one", () => {
    expectRejection(
      "SELECT d.id FROM documents d JOIN account a ON a.id = d.uploaded_by_id",
      "SQL_TABLE_NOT_ALLOWED",
    );
  });

  test("rejects a forbidden table hidden in a CTE", () => {
    expectRejection(
      "WITH leak AS (SELECT password FROM account) SELECT * FROM leak",
      "SQL_TABLE_NOT_ALLOWED",
    );
  });
});
