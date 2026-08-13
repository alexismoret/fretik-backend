import { describe, expect, test } from "bun:test";
import { idCursor } from "../../src/lib/cursor";

describe("id cursor", () => {
  test("accepts an id and hands it straight back", () => {
    const id = "01933eb8-541f-7000-a9f4-e4eee80ff04e";
    expect(idCursor(id)).toBe(id);
  });

  test("is case-insensitive — an id may travel upper-cased through a URL", () => {
    const id = "01933EB8-541F-7000-A9F4-E4EEE80FF04E";
    expect(idCursor(id)).toBe(id);
  });

  // Each of these reaches the server eventually — a tab left open across a
  // deploy, a truncated URL, a hand-written value. None may reach the `uuid`
  // comparison, which Postgres answers with an error; null restarts the walk.
  test.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["truncated", "01933eb8-541f-7000-a9f4-e4eee80ff0"],
    ["over-long", "01933eb8-541f-7000-a9f4-e4eee80ff04ee"],
    ["non-hex", "01933eb8-541f-7000-a9f4-zzzzzzzzzzzz"],
    ["unseparated", "01933eb8541f7000a9f4e4eee80ff04e"],
    ["a SQL fragment", "' OR 1=1 --"],
    ["a whole sentence", "the tenth page please"],
  ])("refuses a %s cursor", (_label, raw) => {
    expect(idCursor(raw)).toBeNull();
  });

  test("refuses padding around an otherwise valid id", () => {
    expect(idCursor(" 01933eb8-541f-7000-a9f4-e4eee80ff04e")).toBeNull();
    expect(idCursor("01933eb8-541f-7000-a9f4-e4eee80ff04e\n")).toBeNull();
  });
});
