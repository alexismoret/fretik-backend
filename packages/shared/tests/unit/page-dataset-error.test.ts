import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `common/params`, which calls `.openapi()` — the
// method only exists once `@hono/zod-openapi` has patched Zod.
import "@hono/zod-openapi";
import { describeDatasetError } from "../../src/services/pages/run-page-data";

/**
 * What a failed dataset says to the agent that has to fix it.
 *
 * The driver's message is `Failed query: <the entire SQL>`, and that is what
 * used to travel: a wall of generated SQL naming the physical table
 * `data.obj_<uuid>`, with the cause — one wrong column — buried inside it.
 * Observed on a real run (2026-08-17): the agent read three of those, could not
 * tell which layer had failed, concluded "the transform keeps failing in the
 * sandbox" (it was an aggregate, and no sandbox was involved), and rewrote the
 * page to bucket its rows in the component instead.
 */

/** What Drizzle actually throws: its own message, wrapping the driver's. */
const drizzleError = (innerMessage: string, code?: string): Error => {
  const inner = new Error(innerMessage);
  if (code !== undefined) Reflect.set(inner, "code", code);
  const outer = new Error(
    `Failed query: SELECT e."status"::text AS group_value, COALESCE(sum(e."nope"), 0)::float8 AS m0 FROM "object_records" JOIN data.obj_01a00f76e915 e ON e."id" = "object_records"."id" WHERE (("object_records"."object_type_id" = $1))`,
  );
  Reflect.set(outer, "cause", inner);
  return outer;
};

describe("describeDatasetError", () => {
  test("an unknown column becomes the cause plus the way to check", () => {
    const message = describeDatasetError(
      drizzleError("column e.nope does not exist", "42703"),
    );
    expect(message).toContain("column e.nope does not exist");
    expect(message).toContain("dry_run");
    // The whole point: none of the SQL, and none of the physical table name.
    expect(message).not.toContain("SELECT");
    expect(message).not.toContain("data.obj_");
  });

  test("any other database error still loses the SQL wrapper", () => {
    const message = describeDatasetError(
      drizzleError("division by zero", "22012"),
    );
    expect(message).toBe("division by zero");
  });

  test("a long message is bounded — an error is a prompt, not a log", () => {
    const message = describeDatasetError(drizzleError("x".repeat(2000)));
    expect(message.length).toBeLessThanOrEqual(300);
  });

  test("an error thrown without a cause is reported as itself", () => {
    expect(describeDatasetError(new Error("connection lost"))).toBe(
      "connection lost",
    );
  });

  test("something that is not an Error at all still reads", () => {
    expect(describeDatasetError("boom")).toBe("boom");
    expect(describeDatasetError(null)).toBe("unknown error");
  });
});
