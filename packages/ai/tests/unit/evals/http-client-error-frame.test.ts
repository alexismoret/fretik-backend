/**
 * The eval HTTP client must surface SSE `error` frames as
 * `InvokeResult.error` — an errored turn (e.g. empty provider pool)
 * must NOT be counted as a zombie (no text, no error). Regression
 * test for the 2026-06-12 M3 gate failure mode.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { invokeChatbot } from "../../../evals/http-client";
import { FAILOVER_SENTINEL } from "../../../src/lib/stream-errors";

process.env.EVAL_TEAM_ID ??= "00000000-0000-0000-0000-00000000aaaa";
process.env.EVAL_ORGANIZATION_ID ??= "00000000-0000-0000-0000-00000000bbbb";

const sseResponse = (frames: string[]): Response =>
  new Response(frames.map((f) => `data: ${f}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const stubFetch = (res: Response): void => {
  const stub: typeof fetch = async () => res;
  globalThis.fetch = stub;
};

describe("invokeChatbot — SSE error frames", () => {
  test("an error frame lands on InvokeResult.error (not a zombie)", async () => {
    stubFetch(
      sseResponse([
        '{"type":"start","messageId":"x"}',
        '{"type":"error","errorText":"No endpoints found matching your data policy (Zero data retention)."}',
        "[DONE]",
      ]),
    );
    const result = await invokeChatbot("ping");
    expect(result.error).toContain("Zero data retention");
    expect(result.text).toBe("");
  });

  test("the FIRST error wins; text already streamed is preserved", async () => {
    stubFetch(
      sseResponse([
        '{"type":"start","messageId":"x"}',
        '{"type":"start-step"}',
        '{"type":"text-delta","id":"t","delta":"partial answer"}',
        '{"type":"error","errorText":"root cause"}',
        '{"type":"error","errorText":"downstream noise"}',
        "[DONE]",
      ]),
    );
    const result = await invokeChatbot("ping");
    expect(result.error).toBe("root cause");
    expect(result.text).toBe("partial answer");
    expect(result.stepsUsed).toBe(1);
  });

  test("C4 — a FAILOVER_SENTINEL error frame is ignored (transparent failover)", async () => {
    // The transparent failover emits the sentinel error frame, then the
    // fallback's answer follows on the same stream. The harness must NOT
    // record it as a turn error, or a recovered turn scores as failed.
    stubFetch(
      sseResponse([
        '{"type":"start","messageId":"x"}',
        `{"type":"error","errorText":"${FAILOVER_SENTINEL}"}`,
        '{"type":"start-step"}',
        '{"type":"text-delta","id":"t","delta":"fallback answer"}',
        "[DONE]",
      ]),
    );
    const result = await invokeChatbot("ping");
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("fallback answer");
  });
});
