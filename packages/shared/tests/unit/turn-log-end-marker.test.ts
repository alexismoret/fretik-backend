import { describe, expect, test } from "bun:test";
import { mockModule } from "../lib/mock-module";

/**
 * The turn log's TERMINAL contract, which the chat handler's teardown is
 * built on.
 *
 * A reader turns the end marker into the SSE `[DONE]` that lets the client
 * call the turn over — unlock the composer, accept the next prompt. So when
 * the marker is written decides how long a finished answer sits on screen
 * behind a Stop button, and whether it is written at all decides whether the
 * conversation ever unlocks.
 *
 * Two properties, and the chat handler leans on both:
 *
 *  - The marker lands only once the chunk source has CLOSED. The AI SDK runs
 *    `onFinish` inside that stream's `flush()`, so everything awaited there
 *    delays the marker — which is why the chat turn's slow bookkeeping (the
 *    Langfuse flush above all) now hangs off the pump's completion instead of
 *    off `onFinish`. Measured on a real turn before that move: seconds of a
 *    complete answer with the composer still refusing to send.
 *  - The marker is written on EVERY outcome, a failed source included. The
 *    handler attaches its post-turn settle to the pump's promise, so a pump
 *    that could end without marking the log would strand both the viewers and
 *    the settle.
 */

interface Recorded {
  key: string;
  fields: string[];
}

const xadds: Recorded[] = [];

/** Chainable pipeline stub — the three commands the log actually issues. */
const pipeline = () => {
  const chain = {
    xadd: (key: string, ...args: unknown[]) => {
      // `MAXLEN ~ <n> *` then the field pairs.
      xadds.push({ key, fields: args.slice(4).map(String) });
      return chain;
    },
    expire: () => chain,
    publish: () => chain,
    exec: () => Promise.resolve([]),
  };
  return chain;
};

await mockModule("../../src/lib/redis", {
  redis: { pipeline },
});

const { endTurnLog, pumpChunksToTurnLog } =
  await import("../../src/services/ai/turn-log");

/** Did an end marker land, and with which reason? */
const endReason = (): string | undefined => {
  for (const { fields } of xadds) {
    const at = fields.indexOf("m");
    if (at !== -1 && fields[at + 1] === "end") {
      const r = fields.indexOf("r");
      return r === -1 ? "" : fields[r + 1];
    }
  }
  return undefined;
};

describe("pumpChunksToTurnLog", () => {
  test("marks the log ended only once the source closes", async () => {
    xadds.length = 0;
    let closeSource: (() => void) | undefined;
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "hello" });
        closeSource = () => controller.close();
      },
    });

    const pumped = pumpChunksToTurnLog("turn-1", source);

    // Let the chunk land, then look: the turn is still producing, and a
    // client that saw `[DONE]` here would unlock on an unfinished answer.
    await Bun.sleep(5);
    expect(xadds.length).toBeGreaterThan(0);
    expect(endReason()).toBeUndefined();

    closeSource?.();
    await pumped;
    expect(endReason()).toBe("finish");
  });

  test("marks the log ended even when the source fails", async () => {
    xadds.length = 0;
    const source = new ReadableStream<unknown>({
      start(controller) {
        controller.error(new Error("producer died"));
      },
    });

    await pumpChunksToTurnLog("turn-2", source);

    expect(endReason()).toBe("error");
  });
});

describe("endTurnLog", () => {
  test("writes the reason alongside the marker", async () => {
    xadds.length = 0;
    await endTurnLog("turn-3", "error");
    expect(endReason()).toBe("error");
  });
});
