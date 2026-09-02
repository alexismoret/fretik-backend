import { describe, expect, test } from "bun:test";
import { mockModule } from "../lib/mock-module";

/**
 * The nightly timetable, pinned as data.
 *
 * `registerSchedulers` is imperative — thirteen `upsertJobScheduler` calls in a
 * row — and nothing until now read it back. That matters because every claim it
 * makes is a claim about things NOT colliding, and a collision is silent:
 *
 *  - two schedulers sharing an id do not error, they overwrite each other, and
 *    one of the two jobs simply stops existing;
 *  - a job moved onto the 15-second maintenance queue does not error either —
 *    it just holds a concurrency-1 worker for minutes, once a night, and the
 *    journal and trigger sweeps stop running for the duration. The comments in
 *    `schedulers.ts` are almost entirely about avoiding exactly this, and
 *    comments do not fail;
 *  - a legacy `{ repeat }` registration (the BullMQ 5 API) hard-crashes the
 *    process at boot on BullMQ 6. That already happened once — it is what
 *    `scripts/drop-legacy-orphan-repeatable.ts` exists to clean up.
 *
 * The queues are doubled because the subject is the REGISTRATION, not Redis.
 */

interface Registration {
  queue: string;
  id: string;
  repeat: Record<string, unknown>;
  template: { name: string; opts?: Record<string, unknown> };
}

const registrations: Registration[] = [];

const fakeQueue = (queue: string) => ({
  upsertJobScheduler: (
    id: string,
    repeat: Record<string, unknown>,
    template: { name: string; opts?: Record<string, unknown> },
  ) => {
    registrations.push({ queue, id, repeat, template });
    return Promise.resolve();
  },
});

await mockModule("../../src/queues/queues", {
  getMemoryMaintenanceQueue: () => fakeQueue("memory-maintenance"),
  getCollectionIndexQueue: () => fakeQueue("collection-index"),
  getMcpRefreshQueue: () => fakeQueue("mcp-refresh"),
  getModelSyncQueue: () => fakeQueue("model-sync"),
  getVectorReconcileQueue: () => fakeQueue("vector-reconcile"),
});

const { registerSchedulers } = await import("../../src/queues/schedulers");

await registerSchedulers();

const byId = new Map(registrations.map((r) => [r.id, r]));
const on = (queue: string): string[] =>
  registrations.filter((r) => r.queue === queue).map((r) => r.id);

/** `m h dom mon dow`, the only pattern shape used here. */
const CRON = /^[\d*,\-/]+ [\d*,\-/]+ [\d*,\-/]+ [\d*,\-/]+ [\d*,\-/]+$/;

const patternOf = (id: string): string => {
  const value = byId.get(id)?.repeat["pattern"];
  if (typeof value !== "string") {
    throw new Error(`scheduler "${id}" has no cron pattern`);
  }
  return value;
};

const minuteOfDay = (pattern: string): number => {
  const [minute, hour] = pattern.split(" ");
  return Number(hour) * 60 + Number(minute);
};

describe("scheduler identities", () => {
  test("every scheduler id is unique — a duplicate silently deletes a job", () => {
    const ids = registrations.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the id and the job name are the same string", () => {
    // The worker dispatches on the job NAME (`maintenance.ts` switches on it)
    // while BullMQ keys the schedule on the ID. Letting them drift registers a
    // schedule whose jobs no handler answers: the pass silently never runs.
    for (const r of registrations) expect(r.template.name).toBe(r.id);
  });

  test("the whole timetable is thirteen entries", () => {
    // A count, so that adding or removing a scheduled pass has to be a
    // deliberate edit to this file rather than a diff nobody reads.
    expect(registrations).toHaveLength(13);
  });
});

describe("what may share the 15-second maintenance queue", () => {
  test("the frequent sweeps live there, and only cheap work joins them", () => {
    expect(on("memory-maintenance").sort()).toEqual(
      [
        "conversation-task-sweep",
        "dreaming-sweep",
        "gc-demote",
        "journal-sweep",
        "model-alert-sweep",
        "model-telemetry-rollup",
        "workflow-stall-sweep",
        "workflow-trigger-sweep",
      ].sort(),
    );
  });

  test("the long passes each have their own queue", () => {
    // Each of these can hold its worker for minutes — a `CREATE INDEX
    // CONCURRENTLY`, a crawl of four public catalogues, one AI call per repair,
    // an introspection of every MCP connection. On the maintenance queue that
    // is head-of-line blocking for the two sweeps that must run every 15s.
    expect(on("collection-index")).toEqual(["collection-index-sweep"]);
    expect(on("mcp-refresh")).toEqual(["mcp-snapshot-refresh"]);
    expect(on("vector-reconcile")).toEqual(["vector-reconcile-sweep"]);
    expect(on("model-sync").sort()).toEqual([
      "model-candidate-bench",
      "model-sync-nightly",
    ]);
  });

  test("the bench runs after the sync, on the same queue", () => {
    // Same queue at concurrency 1 is what makes the order a guarantee rather
    // than a hope: the pass that rewrites candidate rows and the pass that
    // measures them can never touch the same rows at once. Splitting them onto
    // two queues would leave only the 45-minute gap, which is not a promise.
    expect(byId.get("model-sync-nightly")?.queue).toBe(
      byId.get("model-candidate-bench")?.queue,
    );
    expect(minuteOfDay(patternOf("model-sync-nightly"))).toBeLessThan(
      minuteOfDay(patternOf("model-candidate-bench")),
    );
  });
});

describe("repeat definitions", () => {
  test("nothing uses the legacy BullMQ 5 repeat option", () => {
    // `queue.add(name, data, { repeat })` was removed in BullMQ 6 and throws at
    // BOOT — "Legacy repeatable job metadata is not supported" — taking the
    // whole jobs container with it. That is the incident
    // `drop-legacy-orphan-repeatable.ts` was written to clean up after.
    for (const r of registrations) {
      expect(r.template.opts).not.toHaveProperty("repeat");
      expect(Object.keys(r.repeat).sort()).toEqual(
        r.repeat["every"] !== undefined ? ["every"] : ["pattern", "tz"],
      );
    }
  });

  test("every cron pattern is well formed and anchored to UTC", () => {
    // A pattern with a missing field shifts the run by hours or never fires,
    // and a schedule with no `tz` follows the container's clock — which is how
    // "the nightly chain" quietly stops being nightly after a host change.
    for (const r of registrations) {
      if (r.repeat["pattern"] === undefined) continue;
      expect(patternOf(r.id)).toMatch(CRON);
      expect(r.repeat["tz"]).toBe("UTC");
    }
  });

  test("the two 15-second sweeps are intervals, not crons", () => {
    for (const id of ["journal-sweep", "workflow-trigger-sweep"]) {
      expect(byId.get(id)?.repeat).toEqual({ every: 15_000 });
    }
  });

  test("the nightly chain is staggered rather than simultaneous", () => {
    // Not a correctness guarantee (an overrun simply queues), but the ordering
    // is deliberate and reasoned about in comments: sync, reconcile, index
    // sweep, dreaming, GC, MCP refresh, each in its own hour.
    const nightly = [
      "model-sync-nightly",
      "vector-reconcile-sweep",
      "collection-index-sweep",
      "dreaming-sweep",
      "gc-demote",
      "mcp-snapshot-refresh",
    ].map((id) => minuteOfDay(patternOf(id)));
    expect(nightly).toEqual([...nightly].sort((a, b) => a - b));
    expect(new Set(nightly).size).toBe(nightly.length);
  });
});

describe("retention", () => {
  test("every scheduled job caps both its completed and its failed history", () => {
    // A repeatable job with no cap grows a Redis key set forever. At every 15
    // seconds that is 5 760 entries a day from one scheduler.
    for (const r of registrations) {
      expect(r.template.opts?.["removeOnComplete"]).toBeDefined();
      expect(r.template.opts?.["removeOnFail"]).toBeDefined();
    }
  });

  test("the model sync is the only pass that retries, and it retries twice", () => {
    // Everything else reports its own failures as data and returns normally, so
    // a BullMQ retry would re-run a pass that did not fail. An unbounded
    // `attempts` on a nightly crawl of four public APIs is a way to get rate
    // limited on the one night nobody is watching.
    const withAttempts = registrations.filter(
      (r) => r.template.opts?.["attempts"] !== undefined,
    );
    expect(withAttempts.map((r) => r.id)).toEqual(["model-sync-nightly"]);
    expect(withAttempts[0]?.template.opts?.["attempts"]).toBe(2);
  });
});
