import { describe, expect, test } from "bun:test";
import {
  markSince,
  type StageTimings,
  tapFirstChunk,
} from "../../../src/lib/turn-timings";

/**
 * What this guards: TTFT is the one number the pre-turn work is optimised
 * against, and it is measured by tapping the outbound stream. A tap that fires
 * on the wrong frame reports a time the user never experienced — the SDK emits
 * `start` and `start-step` the instant the provider call opens, before the
 * model has produced anything — and a tap that alters the stream corrupts the
 * turn it was only supposed to observe.
 *
 * So the assertions that matter are: it fires on OUTPUT, it fires ONCE, and
 * the chunks come out exactly as they went in.
 */

const streamOf = <C>(chunks: C[]): ReadableStream<C> =>
  new ReadableStream<C>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const drain = async <C>(stream: ReadableStream<C>): Promise<C[]> => {
  const out: C[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

describe("tapFirstChunk", () => {
  test("does not fire on the SDK's opening bookkeeping frames", async () => {
    let fired = 0;
    const chunks = [{ type: "start" }, { type: "start-step" }];
    await drain(
      tapFirstChunk(streamOf(chunks), () => {
        fired += 1;
      }),
    );
    // The provider call is open here and nothing has been generated. Firing
    // would report the HTTP handshake as the time-to-first-token.
    expect(fired).toBe(0);
  });

  test.each([["text-delta"], ["reasoning-delta"], ["tool-input-start"]])(
    "fires on the first %s",
    async (type) => {
      let fired = 0;
      await drain(
        tapFirstChunk(streamOf([{ type: "start" }, { type }]), () => {
          fired += 1;
        }),
      );
      expect(fired).toBe(1);
    },
  );

  test("fires once even when output keeps coming", async () => {
    let fired = 0;
    const chunks = [
      { type: "start" },
      { type: "text-delta" },
      { type: "text-delta" },
      { type: "reasoning-delta" },
    ];
    await drain(
      tapFirstChunk(streamOf(chunks), () => {
        fired += 1;
      }),
    );
    expect(fired).toBe(1);
  });

  test("passes every chunk through, in order and unmodified", async () => {
    const chunks = [
      { type: "start" },
      { type: "text-delta", delta: "a" },
      { type: "text-delta", delta: "b" },
      { type: "finish" },
    ];
    const out = await drain(
      tapFirstChunk(streamOf(chunks), () => {
        /* noop */
      }),
    );
    expect(out).toEqual(chunks);
  });

  test("an empty stream closes without firing", async () => {
    let fired = 0;
    const out = await drain(
      tapFirstChunk(streamOf<{ type: string }>([]), () => {
        fired += 1;
      }),
    );
    expect(out).toEqual([]);
    expect(fired).toBe(0);
  });

  test("a throwing callback never breaks the stream", async () => {
    const chunks = [{ type: "text-delta" }, { type: "finish" }];
    const out = await drain(
      tapFirstChunk(streamOf(chunks), () => {
        throw new Error("telemetry exploded");
      }),
    );
    expect(out).toEqual(chunks);
  });

  test("a source error still reaches the consumer", async () => {
    const boom = new Error("provider died");
    const source = new ReadableStream<{ type: string }>({
      start(controller) {
        controller.enqueue({ type: "text-delta" });
        controller.error(boom);
      },
    });
    expect(
      drain(
        tapFirstChunk(source, () => {
          /* noop */
        }),
      ),
    ).rejects.toThrow("provider died");
  });
});

describe("markSince", () => {
  test("stamps elapsed milliseconds under its label", () => {
    const timings: StageTimings = {};
    markSince(timings, "prelude", Date.now() - 50);
    expect(timings["prelude"]).toBeGreaterThanOrEqual(45);
    expect(timings["prelude"]).toBeLessThan(5_000);
  });
});
