import { describe, expect, test } from "bun:test";
import { isOwnedByThisDeployment } from "../../src/services/e2b/reclaim-orphans";

/**
 * The orphan sweep kills every sandbox whose conversation id is absent from
 * the LOCAL Redis. Its only ownership signal used to be "this sandbox carries
 * a conversationId" — so a dev server booting against an `E2B_API_KEY` shared
 * with production would find production's sandboxes, miss their ids in its own
 * Redis, and kill live turns.
 *
 * These pin the rule that stops that. The sweep runs unattended on boot and
 * after every release, so a regression here is silent until someone's turn
 * dies mid-run.
 */

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const MIN_AGE_MS = 5 * 60 * 1000;
const opts = { environment: "production", now: NOW, minAgeMs: MIN_AGE_MS };
const old = new Date(NOW - 60 * 60 * 1000);

describe("isOwnedByThisDeployment", () => {
  test("claims a sandbox tagged with our own environment", () => {
    expect(
      isOwnedByThisDeployment(
        {
          sandboxId: "s1",
          metadata: { conversationId: "c1", environment: "production" },
          startedAt: old,
        },
        opts,
      ),
    ).toBe(true);
  });

  test("spares another deployment's sandbox", () => {
    expect(
      isOwnedByThisDeployment(
        {
          sandboxId: "s2",
          metadata: { conversationId: "c2", environment: "development" },
          startedAt: old,
        },
        opts,
      ),
    ).toBe(false);
  });

  test("still claims an untagged sandbox so the legacy population drains", () => {
    expect(
      isOwnedByThisDeployment(
        { sandboxId: "s3", metadata: { conversationId: "c3" }, startedAt: old },
        opts,
      ),
    ).toBe(true);
  });

  test("ignores a sandbox that is not ours at all", () => {
    expect(
      isOwnedByThisDeployment({ sandboxId: "s4", startedAt: old }, opts),
    ).toBe(false);
    expect(
      isOwnedByThisDeployment(
        {
          sandboxId: "s5",
          metadata: { environment: "production" },
          startedAt: old,
        },
        opts,
      ),
    ).toBe(false);
  });

  test("spares a sandbox younger than the grace period", () => {
    // `acquireSandbox` writes Redis only after `Sandbox.create` returns, so a
    // sandbox created seconds ago is legitimately absent from the registry.
    expect(
      isOwnedByThisDeployment(
        {
          sandboxId: "s6",
          metadata: { conversationId: "c6", environment: "production" },
          startedAt: new Date(NOW - 10_000),
        },
        opts,
      ),
    ).toBe(false);
  });

  test("claims a sandbox exactly at the grace boundary", () => {
    expect(
      isOwnedByThisDeployment(
        {
          sandboxId: "s7",
          metadata: { conversationId: "c7", environment: "production" },
          startedAt: new Date(NOW - MIN_AGE_MS),
        },
        opts,
      ),
    ).toBe(true);
  });

  test("claims a sandbox with no start time rather than leaking it", () => {
    expect(
      isOwnedByThisDeployment(
        {
          sandboxId: "s8",
          metadata: { conversationId: "c8", environment: "production" },
        },
        opts,
      ),
    ).toBe(true);
  });
});
