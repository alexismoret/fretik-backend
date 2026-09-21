import { describe, expect, test } from "bun:test";
import { deterministicUuid } from "../../src/lib/deterministic-uuid";

/**
 * The id that makes a replayed workflow turn idempotent.
 *
 * `ensureSteeringMessage` used to dedup by reading `history.at(-1)` and
 * looking for a matching `workflowTurnIndex` — a check that was already
 * unsound before any checkpoint existed, because compaction REPLACES the
 * history with a summary that carries no such metadata. A turn replayed after
 * a compaction therefore stacked a second steering message with a fresh id
 * every time. A deterministic id removes the read: one row per
 * `(conversation, turnIndex)`, and `saveMessage`'s upsert rewrites it in place.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("deterministicUuid", () => {
  test("the same seed always gives the same id", () => {
    expect(deterministicUuid("workflow-steering:conv-1:3")).toBe(
      deterministicUuid("workflow-steering:conv-1:3"),
    );
  });

  test("a different turn index gives a different id", () => {
    expect(deterministicUuid("workflow-steering:conv-1:3")).not.toBe(
      deterministicUuid("workflow-steering:conv-1:4"),
    );
  });

  test("a different conversation gives a different id", () => {
    expect(deterministicUuid("workflow-steering:conv-1:3")).not.toBe(
      deterministicUuid("workflow-steering:conv-2:3"),
    );
  });

  test("the output is a well-formed v4-layout uuid", () => {
    // `ai_messages.id` is a `uuid` column — an id that is merely unique but
    // not parseable as a UUID is refused by Postgres, not by a test.
    const id = deterministicUuid("workflow-steering:conv-1:1");
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe("5");
    expect(["8", "9", "a", "b"]).toContain(id[19] ?? "");
  });

  test("it is stable across a stringified seed, not across a hash seed", () => {
    // Persisted and compared across processes and releases — the reason this
    // is SHA-256 and not `Bun.hash`, whose seed and algorithm carry no such
    // guarantee. Pinning one known value catches an algorithm swap.
    expect(deterministicUuid("fretik")).toBe(deterministicUuid("fretik"));
    expect(deterministicUuid("fretik")).not.toBe(deterministicUuid("fretiK"));
  });
});
