import { describe, expect, test } from "bun:test";
import { byReceivedAtDesc } from "../../src/imap-smtp/handlers";

/**
 * IMAP hands a page back in UID order (≈ server arrival), which is not the
 * order a mail client shows. `byReceivedAtDesc` re-orders the FETCHED page
 * by the message's own `received_at`. These tests pin the two properties a
 * consumer relies on: newest first, and a bad date never scrambles the rest.
 */
describe("byReceivedAtDesc", () => {
  const row = (received_at: string): { received_at: string } => ({
    received_at,
  });

  test("orders a page newest-first regardless of input order", () => {
    const page = [
      row("2026-08-01T10:00:00.000Z"),
      row("2026-08-03T10:00:00.000Z"),
      row("2026-08-02T10:00:00.000Z"),
    ];
    expect(page.sort(byReceivedAtDesc).map((m) => m.received_at)).toEqual([
      "2026-08-03T10:00:00.000Z",
      "2026-08-02T10:00:00.000Z",
      "2026-08-01T10:00:00.000Z",
    ]);
  });

  test("a newer Date header wins over a higher UID (arrival order)", () => {
    // UID order would put the appended 2020 message first; date order does not.
    const arrivalOrder = [
      row("2020-01-01T00:00:00.000Z"), // highest UID, oldest Date header
      row("2026-08-22T09:00:00.000Z"),
    ];
    expect(arrivalOrder.sort(byReceivedAtDesc)[0]?.received_at).toBe(
      "2026-08-22T09:00:00.000Z",
    );
  });

  test("unparseable and empty dates sort last, valid rows stay ordered", () => {
    const page = [
      row("not-a-date"),
      row("2026-08-01T10:00:00.000Z"),
      row(""),
      row("2026-08-05T10:00:00.000Z"),
    ];
    expect(page.sort(byReceivedAtDesc).map((m) => m.received_at)).toEqual([
      "2026-08-05T10:00:00.000Z",
      "2026-08-01T10:00:00.000Z",
      "not-a-date",
      "",
    ]);
  });

  test("equal timestamps keep their input (UID) order — sort is stable", () => {
    const first = row("2026-08-01T10:00:00.000Z");
    const second = row("2026-08-01T10:00:00.000Z");
    expect([first, second].sort(byReceivedAtDesc)).toEqual([first, second]);
    expect([second, first].sort(byReceivedAtDesc)).toEqual([second, first]);
  });
});
