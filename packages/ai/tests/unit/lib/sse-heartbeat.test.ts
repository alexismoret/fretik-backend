import { describe, expect, test } from "bun:test";
import { withHeartbeat } from "../../../src/lib/sse-heartbeat";

/**
 * The heartbeat has one job: emit while the source is silent.
 *
 * Its predecessor did not do it. A `setInterval` inside a TransformStream's
 * `start()` enqueued exactly once — the immediate ping — and every later tick
 * was swallowed by an empty `catch`. Measured 2026-09-06 on a real stream: one
 * ping in 656 frames, and four page builds killed by `Bun.serve`'s
 * `idleTimeout` while the server kept working.
 *
 * So the assertion that matters is the count of pings from a source that never
 * speaks. A test that only checked pass-through would have been green on the
 * broken version.
 */

const PING = "ping";
const drain = async (stream: ReadableStream<string>): Promise<string[]> => {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

/** A source that stays silent for `ms`, then closes. */
const silentFor = (ms: number): ReadableStream<string> =>
  new ReadableStream<string>({
    start(controller) {
      setTimeout(() => controller.close(), ms);
    },
  });

describe("withHeartbeat", () => {
  test("a silent source still emits pings, more than the one at the start", async () => {
    const chunks = await drain(withHeartbeat(silentFor(120), 20, () => PING));
    // 120ms of silence at 20ms: the opening ping plus several more. The
    // predecessor produced exactly one, forever.
    expect(chunks.filter((c) => c === PING).length).toBeGreaterThan(3);
  });

  test("chunks pass through unchanged and in order", async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.enqueue("c");
        controller.close();
      },
    });
    const chunks = await drain(withHeartbeat(source, 10_000, () => PING));
    expect(chunks.filter((c) => c !== PING)).toEqual(["a", "b", "c"]);
    // The opening ping, and no others: nothing was idle long enough.
    expect(chunks.filter((c) => c === PING).length).toBe(1);
  });

  test("a chunk that arrives during a silent stretch is not lost", async () => {
    // The read that lost a race is still in flight. Starting a second one
    // would drop what the first returns — the reason `pending` is kept.
    const source = new ReadableStream<string>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue("late");
          controller.close();
        }, 70);
      },
    });
    const chunks = await drain(withHeartbeat(source, 10, () => PING));
    expect(chunks.filter((c) => c !== PING)).toEqual(["late"]);
    expect(chunks.filter((c) => c === PING).length).toBeGreaterThan(3);
  });

  test("the source closing closes the stream", async () => {
    const chunks = await drain(withHeartbeat(silentFor(5), 1_000, () => PING));
    expect(chunks).toEqual([PING]);
  });

  test("a source that errors surfaces the error rather than pinging forever", async () => {
    const source = new ReadableStream<string>({
      start(controller) {
        setTimeout(() => controller.error(new Error("upstream gone")), 20);
      },
    });
    let thrown: unknown;
    try {
      await drain(withHeartbeat(source, 5, () => PING));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.message : "").toContain(
      "upstream gone",
    );
  });
});
