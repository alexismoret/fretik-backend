import { describe, expect, test } from "bun:test";
import { ACCESS_AUDIT_ACTIONS } from "../../src/schemas/access";
import { JOURNAL_ACTIONS } from "../../src/schemas/access-journal";

describe("the journal's kinds of change", () => {
  test("hold every action the journal records, each once", () => {
    const listed = Object.values(JOURNAL_ACTIONS).flat();
    expect([...listed].sort()).toEqual([...ACCESS_AUDIT_ACTIONS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});
