import type { ModelAlertRow } from "@fretik/shared/db/schema";
import { describe, expect, test } from "bun:test";
import { buildAlertDigest } from "../../src/workers/model-alert-digest";

/**
 * The digest builder is pure, and this suite is why it was split out of the
 * sweep: `@fretik/shared/lib/email` throws at module load without its Scaleway
 * variables, so a test that reached it would die before its first assertion.
 * The only import here that touches `@fretik/shared` is a type, which is erased
 * — this file reaches no database and no Redis. (Since 2026-09-02 that is
 * guaranteed rather than merely true: `tests/preload.ts` points every service
 * variable at a dead port, so a future import that opens a connection fails
 * loudly instead of finding the developer's real one through `.env`.)
 */

const alert = (over: Partial<ModelAlertRow>): ModelAlertRow => ({
  id: "00000000-0000-0000-0000-000000000000",
  kind: "policy-fail",
  severity: "warning",
  modelKey: null,
  provider: null,
  message: "something happened",
  context: null,
  notifiedAt: null,
  acknowledgedAt: null,
  createdAt: new Date("2026-08-29T00:30:00Z"),
  ...over,
});

describe("buildAlertDigest", () => {
  test("empty input yields a zero-count subject and no alert lines", () => {
    const digest = buildAlertDigest([]);
    expect(digest.subject).toBe("[Fretik] 0 model alerts (0 critical)");
    expect(digest.text).toBe("[Fretik] 0 model alerts (0 critical)");
    expect(digest.html).not.toContain("<li>");
  });

  test("orders severities critical first, then warning, then info", () => {
    const digest = buildAlertDigest([
      alert({ severity: "info", message: "info-line" }),
      alert({ severity: "warning", message: "warning-line" }),
      alert({ severity: "critical", message: "critical-line" }),
    ]);
    const order = ["critical-line", "warning-line", "info-line"];
    const positions = order.map((needle) => digest.text.indexOf(needle));
    expect(positions.every((at) => at > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Same order in the other rendering — the HTML is not built from a
    // different traversal.
    const htmlPositions = order.map((needle) => digest.html.indexOf(needle));
    expect(htmlPositions.every((at) => at > -1)).toBe(true);
    expect(htmlPositions).toEqual([...htmlPositions].sort((a, b) => a - b));
  });

  test("subject counts every alert and the criticals separately", () => {
    const digest = buildAlertDigest([
      alert({ severity: "critical" }),
      alert({ severity: "critical" }),
      alert({ severity: "warning" }),
    ]);
    expect(digest.subject).toBe("[Fretik] 3 model alerts (2 critical)");
  });

  test("a single alert is not pluralised", () => {
    expect(buildAlertDigest([alert({})]).subject).toBe(
      "[Fretik] 1 model alert (0 critical)",
    );
  });

  test("names kind, model and provider on each line", () => {
    const digest = buildAlertDigest([
      alert({
        kind: "quarantine",
        modelKey: "flash-lite",
        provider: "coreweave",
        message: "zero-width space injected into emitted text",
      }),
    ]);
    expect(digest.text).toContain(
      "quarantine flash-lite/coreweave — zero-width space injected into emitted text",
    );
  });

  test("escapes < and & in the message so free text cannot become markup", () => {
    const digest = buildAlertDigest([
      alert({ message: `price jumped <script>alert(1)</script> AT&T` }),
    ]);
    expect(digest.html).toContain(
      "price jumped &lt;script&gt;alert(1)&lt;/script&gt; AT&amp;T",
    );
    expect(digest.html).not.toContain("<script>");
    // `&` is escaped once, not twice: `&lt;` must not have become `&amp;lt;`.
    expect(digest.html).not.toContain("&amp;lt;");
    // The plain-text part carries the message verbatim.
    expect(digest.text).toContain(
      "price jumped <script>alert(1)</script> AT&T",
    );
  });
});
