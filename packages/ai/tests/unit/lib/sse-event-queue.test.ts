import { describe, expect, test } from "bun:test";
import { createSseEventQueue } from "../../../src/lib/sse-event-queue";

/**
 * What a viewer's event channel must never do is LOSE an event, because the
 * two it carries are both latches: `turn-started` is the invitation to attach
 * to the running turn, and `turn-ended` is what lifts the send gate. Drop the
 * first and a viewer watches a blank conversation; drop the second and its
 * composer refuses every prompt until the page is reloaded.
 *
 * The tests below are the drop conditions the previous shape actually had —
 * an event arriving in the same tick as the heartbeat deadline, and one
 * arriving before anybody was waiting.
 */

const HEARTBEAT_MS = 20;

describe("createSseEventQueue", () => {
  test("an event that arrived before anyone waited is reported, not lost", async () => {
    const events = createSseEventQueue(HEARTBEAT_MS);
    // The subscription fires before the writer's first wait — which is the
    // normal case for anything published while the initial snapshot is on
    // the wire.
    events.push("turn-ended");

    expect(await events.waitForEventOrHeartbeat()).toBe("event");
    expect(events.take()).toBe("turn-ended");
    expect(events.take()).toBeUndefined();
  });

  test("waiting never consumes: the payload survives the race", async () => {
    const events = createSseEventQueue(HEARTBEAT_MS);
    const waiting = events.waitForEventOrHeartbeat();
    events.push("turn-started");

    expect(await waiting).toBe("event");
    // The old shape resolved the race by SHIFTING the payload into a promise
    // the heartbeat branch never read. Here the writer still finds it.
    expect(events.take()).toBe("turn-started");
  });

  test("silence yields a heartbeat, and the queue stays usable after it", async () => {
    const events = createSseEventQueue(HEARTBEAT_MS);

    expect(await events.waitForEventOrHeartbeat()).toBe("heartbeat");

    events.push("presence");
    expect(await events.waitForEventOrHeartbeat()).toBe("event");
    expect(events.take()).toBe("presence");
  });

  test("a burst keeps its order", async () => {
    const events = createSseEventQueue(HEARTBEAT_MS);
    events.push("turn-started");
    events.push("message-added");
    events.push("turn-ended");

    expect(await events.waitForEventOrHeartbeat()).toBe("event");
    const drained: string[] = [];
    for (let next = events.take(); next; next = events.take()) {
      drained.push(next);
    }
    expect(drained).toEqual(["turn-started", "message-added", "turn-ended"]);
  });

  test("an event landing during a write is picked up by the next drain", async () => {
    const events = createSseEventQueue(HEARTBEAT_MS);
    events.push("first");

    await events.waitForEventOrHeartbeat();
    expect(events.take()).toBe("first");
    // The writer is awaiting its SSE write here; a publish in that window
    // must still be waiting when it comes back round.
    events.push("second");

    expect(await events.waitForEventOrHeartbeat()).toBe("event");
    expect(events.take()).toBe("second");
  });
});
