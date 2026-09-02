import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { releaseTasks } from "../../../src/db/schema";
import { runReleaseTasks } from "../../../src/services/release-tasks/runner";
import type { ReleaseTask } from "../../../src/services/release-tasks/types";

/**
 * "Once per deployed version", against the table that has to make it true.
 *
 * Three services boot from the same image at the same time, each can have
 * several replicas, and any of them can be killed mid-task. So the claim is a
 * single `insert … on conflict … do update … where` and everything below is an
 * attempt to break it: two processes racing, a redeploy of the same SHA, a
 * process that died holding a claim, a task that throws.
 *
 * The runner also has one property the boot depends on and which no
 * happy-path test would notice: it NEVER throws. A service that cannot reach
 * its ledger still has to serve.
 */

/** Versions this file created, dropped after every test. */
let versions: string[] = [];

const newVersion = (): string => {
  const version = `it-${randomUUID().slice(0, 12)}`;
  versions.push(version);
  return version;
};

const rowsFor = async (version: string) =>
  db.select().from(releaseTasks).where(eq(releaseTasks.version, version));

/** A task that records how many times it actually ran. */
const countingTask = (
  name: string,
  behaviour: { fail?: boolean; detail?: Record<string, unknown> } = {},
): { task: ReleaseTask; runs: () => number } => {
  let runs = 0;
  return {
    task: {
      name,
      run: async () => {
        runs += 1;
        await Bun.sleep(1);
        if (behaviour.fail) throw new Error("the task refused");
        return behaviour.detail;
      },
    },
    runs: () => runs,
  };
};

beforeEach(() => {
  versions = [];
});

afterEach(async () => {
  if (versions.length > 0) {
    await db
      .delete(releaseTasks)
      .where(inArray(releaseTasks.version, versions));
  }
});

describe("once per version", () => {
  test("a task runs, and the ledger says what it reported", async () => {
    const version = newVersion();
    const { task, runs } = countingTask("seed-something", {
      detail: { published: 2, skipped: 3 },
    });

    await runReleaseTasks([task], { service: "ai", version });

    expect(runs()).toBe(1);
    const [row] = await rowsFor(version);
    expect(row?.outcome).toBe("ok");
    expect(row?.service).toBe("ai");
    expect(row?.detail).toEqual({ published: 2, skipped: 3 });
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a second boot of the SAME version does not run it again", async () => {
    // The whole point: a restarted container, a rollback and re-deploy of the
    // same SHA, or simply the third service booting must not republish.
    const version = newVersion();
    const { task, runs } = countingTask("seed-something");

    await runReleaseTasks([task], { service: "ai", version });
    await runReleaseTasks([task], { service: "ai", version });

    expect(runs()).toBe(1);
    expect(await rowsFor(version)).toHaveLength(1);
  });

  test("a NEW version runs it again", async () => {
    // And the other half — without this, every assertion above is satisfied by
    // a runner that never runs anything twice under any circumstances.
    const { task, runs } = countingTask("seed-something");

    await runReleaseTasks([task], { service: "ai", version: newVersion() });
    await runReleaseTasks([task], { service: "ai", version: newVersion() });

    expect(runs()).toBe(2);
  });

  test("replicas racing produce exactly ONE run", async () => {
    // What is asserted is the OUTCOME, and it is worth knowing that two
    // mechanisms uphold it: the atomic claim, and — behind it — the unique
    // index on (name, version). Swapping the claim for a read-then-write keeps
    // this test green, because the losers then fail on the index instead and
    // the runner logs them as unclaimable. The claim's own contribution is
    // retryability, which the two tests below isolate; measured by mutation on
    // 2026-09-02 rather than assumed.
    const version = newVersion();
    const { task, runs } = countingTask("seed-something");

    await Promise.all([
      runReleaseTasks([task], { service: "api", version }),
      runReleaseTasks([task], { service: "ai", version }),
      runReleaseTasks([task], { service: "jobs", version }),
      runReleaseTasks([task], { service: "ai", version }),
    ]);

    expect(runs()).toBe(1);
    expect(await rowsFor(version)).toHaveLength(1);
  });

  test("two different tasks both run, in the same version", async () => {
    const version = newVersion();
    const first = countingTask("task-a");
    const second = countingTask("task-b");

    await runReleaseTasks([first.task, second.task], {
      service: "ai",
      version,
    });

    expect(first.runs()).toBe(1);
    expect(second.runs()).toBe(1);
    expect(await rowsFor(version)).toHaveLength(2);
  });
});

describe("failure is retried, success is not", () => {
  test("a task that throws is recorded failed, with its message", async () => {
    const version = newVersion();
    const { task } = countingTask("seed-something", { fail: true });

    await runReleaseTasks([task], { service: "ai", version });

    const [row] = await rowsFor(version);
    expect(row?.outcome).toBe("failed");
    expect(row?.detail).toEqual({ error: "the task refused" });
  });

  test("the next boot of the same version RETRIES a failed task", async () => {
    // A deploy that failed to publish its prompts must publish them when the
    // container restarts — otherwise the automation is worse than the manual
    // step it replaces, because nobody is watching for it.
    const version = newVersion();
    let attempt = 0;
    const task: ReleaseTask = {
      name: "seed-something",
      run: async () => {
        attempt += 1;
        await Bun.sleep(1);
        if (attempt === 1) throw new Error("transient");
        return { attempt };
      },
    };

    await runReleaseTasks([task], { service: "ai", version });
    await runReleaseTasks([task], { service: "ai", version });

    expect(attempt).toBe(2);
    const [row] = await rowsFor(version);
    expect(row?.outcome).toBe("ok");
    expect(row?.detail).toEqual({ attempt: 2 });
    // Still ONE row: a retry takes the claim over, it does not accumulate.
    expect(await rowsFor(version)).toHaveLength(1);
  });

  test("a task that SUCCEEDED is never retried, whatever happens next", async () => {
    const version = newVersion();
    const { task, runs } = countingTask("seed-something");

    await runReleaseTasks([task], { service: "ai", version });
    await runReleaseTasks([task], { service: "jobs", version });
    await runReleaseTasks([task], { service: "api", version });

    expect(runs()).toBe(1);
  });

  test("a claim abandoned by a dead process is taken over", async () => {
    // A `running` row is the lock. Nothing cleans one up when the process
    // holding it is killed, so without an expiry a single crash would mean the
    // task never runs again for that version — including on the redeploy done
    // to fix the crash.
    const version = newVersion();
    await db.insert(releaseTasks).values({
      name: "seed-something",
      version,
      service: "ai",
      outcome: "running",
      // 31 minutes ago: past the staleness window.
      startedAt: new Date(Date.now() - 31 * 60 * 1000),
    });
    const { task, runs } = countingTask("seed-something");

    await runReleaseTasks([task], { service: "ai", version });

    expect(runs()).toBe(1);
    const [row] = await rowsFor(version);
    expect(row?.outcome).toBe("ok");
  });

  test("a claim held by a LIVE process is left alone", async () => {
    // The same window, from the other side: a task that is genuinely running
    // right now on another replica must not be started a second time.
    const version = newVersion();
    await db.insert(releaseTasks).values({
      name: "seed-something",
      version,
      service: "ai",
      outcome: "running",
      startedAt: new Date(),
    });
    const { task, runs } = countingTask("seed-something");

    await runReleaseTasks([task], { service: "jobs", version });

    expect(runs()).toBe(0);
    const [row] = await rowsFor(version);
    expect(row?.outcome).toBe("running");
  });
});

describe("the boot is never what pays", () => {
  test("a throwing task does not propagate out of the runner", async () => {
    // `runReleaseTasks` is called un-awaited from `index.ts`. An escaping
    // rejection there is an unhandled promise rejection at boot.
    const version = newVersion();
    const { task } = countingTask("seed-something", { fail: true });

    // Awaited directly rather than through `expect(...).resolves`, which
    // bun types as `void`: awaiting it is a lint error and NOT awaiting it
    // lets the test end before the promise settles. Here the await IS the
    // assertion — a rejection propagates and fails the test.
    const result = await runReleaseTasks([task], { service: "ai", version });
    expect(result).toBeUndefined();
  });

  test("an empty task list is a no-op that touches nothing", async () => {
    const before = await db
      .select()
      .from(releaseTasks)
      .where(like(releaseTasks.version, "it-%"));

    await runReleaseTasks([], { service: "api", version: newVersion() });

    const after = await db
      .select()
      .from(releaseTasks)
      .where(like(releaseTasks.version, "it-%"));
    expect(after).toHaveLength(before.length);
  });
});
