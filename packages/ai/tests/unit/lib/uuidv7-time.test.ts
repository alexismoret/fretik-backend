import { randomUUIDv7 } from "bun";
import { describe, expect, test } from "bun:test";
import { uuidv7TimestampMs } from "../../../src/lib/uuidv7-time";

describe("uuidv7TimestampMs", () => {
  test("reads back the mint time of a fresh v7 id", () => {
    const before = Date.now();
    const ms = uuidv7TimestampMs(randomUUIDv7());
    expect(ms).not.toBeNull();
    // The 48-bit prefix is whole milliseconds, so allow a small window.
    expect(ms ?? 0).toBeGreaterThanOrEqual(before - 1000);
    expect(ms ?? 0).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("null for non-v7 uuids and malformed strings", () => {
    // v4 — the version nibble decides, not the shape.
    expect(
      uuidv7TimestampMs("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
    ).toBeNull();
    expect(uuidv7TimestampMs("not-a-uuid")).toBeNull();
    expect(uuidv7TimestampMs("")).toBeNull();
  });

  test("decodes a known timestamp", () => {
    // 0x018FB3C4D2E0 ms since epoch, version 7 in the 13th hex digit.
    const ms = uuidv7TimestampMs("018fb3c4-d2e0-7abc-8def-0123456789ab");
    expect(ms).toBe(0x018fb3c4d2e0);
  });
});
