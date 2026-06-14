/**
 * Guard the resumable-stream config (C4). Changing `keyPrefix` would
 * orphan every in-flight resumable stream (clients reconnect on the old
 * prefix); `waitUntil` must stay `null` for a long-lived Bun server.
 * The buffer's Redis TTL is the library's fixed 24h (not configurable) —
 * verified once in `resumable-stream/dist/runtime.js` (`EX: 24*60*60`).
 */

import { describe, expect, test } from "bun:test";
import { RESUMABLE_STREAM_CONFIG } from "../../../src/lib/resumable-stream-context";

describe("RESUMABLE_STREAM_CONFIG", () => {
  test("keyPrefix is pinned — a change orphans in-flight resumable streams", () => {
    expect(RESUMABLE_STREAM_CONFIG.keyPrefix).toBe("fretik-chatbot-stream");
  });

  test("waitUntil stays null for a long-lived Bun server", () => {
    expect(RESUMABLE_STREAM_CONFIG.waitUntil).toBeNull();
  });
});
