import { describe, expect, test } from "bun:test";
import type { PolicyReport } from "../../src/model-registry/types";
import { isDiscoveryVariant } from "../../src/services/model-registry/discovery-probes";
import type { AllowedPool } from "../../src/services/model-registry/sync/compute";
import { rejectionReason } from "../../src/services/model-registry/sync/run";

/**
 * Discovery had a budget and no memory, which is a stuck frontier rather than a
 * bounded one: 392 unknown models against 40 endpoint fetches a night, ordered
 * by a release date that never moves, so the same 40 were examined every night
 * and the other 350 were never reached (measured 2026-09-02, when the registry
 * held 25 candidates against a catalogue of 628).
 *
 * These are the two pure halves of the fix: what is not worth a fetch at all,
 * and what to write down about the ones that were fetched.
 */

describe("isDiscoveryVariant", () => {
  test("routing variants are not models, and they sort to the FRONT", () => {
    // 95 of 797 catalogue entries on 2026-09-02, and the newest-first sort put
    // them at the head of the queue — so they spent the budget every night.
    expect(isDiscoveryVariant("qwen/qwen3.8-2.4t-a95b:batch")).toBe(true);
    expect(isDiscoveryVariant("dots-studio/dots-3-note-preview:free")).toBe(
      true,
    );
    // A moving alias: what it points at changes without notice, so every figure
    // measured on the row would describe a model that has since been swapped.
    expect(isDiscoveryVariant("~z-ai/glm-latest")).toBe(true);
  });

  test("a real model with a colon-free id is untouched", () => {
    expect(isDiscoveryVariant("deepseek/deepseek-v4-flash-0731")).toBe(false);
    expect(isDiscoveryVariant("glm-5.2")).toBe(false);
    // Not a suffix match on the whole string: `free` inside a name is a name.
    expect(isDiscoveryVariant("someone/freeform-8b")).toBe(false);
  });
});

describe("rejectionReason", () => {
  const rule = (
    over: Partial<PolicyReport["rules"][number]> = {},
  ): PolicyReport["rules"][number] => ({
    rule: "throughput-floor",
    severity: "hard",
    passed: true,
    detail: "",
    ...over,
  });

  const report = (rules: PolicyReport["rules"]): PolicyReport => ({
    passed: false,
    evaluatedAt: new Date("2026-09-02T00:00:00Z").toISOString(),
    rules,
    excludedProviders: [],
    hardFailures: rules.filter((r) => r.severity === "hard" && !r.passed)
      .length,
    softFailures: rules.filter((r) => r.severity === "soft" && !r.passed)
      .length,
  });

  const pool = (over: Partial<AllowedPool> = {}): AllowedPool => ({
    endpoints: [],
    excluded: [],
    ...over,
  });

  test("an empty pool is reported before any rule", () => {
    // With nothing to grade every rule fails for the same single reason, so
    // quoting one of them names a symptom rather than the cause.
    const reason = rejectionReason(
      report([rule({ passed: false, detail: "no endpoint measured" })]),
      pool({
        excluded: [
          { provider: "alibaba", reason: "no zero-retention agreement" },
        ],
      }),
    );
    expect(reason).toBe(
      "no eligible host: alibaba (no zero-retention agreement)",
    );
  });

  test("the HARD failure is quoted, not the first failure", () => {
    // A soft failure only costs health score; naming it would misdescribe why
    // the model was refused.
    const reason = rejectionReason(
      report([
        rule({
          rule: "price-cap",
          severity: "soft",
          passed: false,
          detail: "above the cap",
        }),
        rule({
          rule: "context-floor",
          severity: "hard",
          passed: false,
          detail: "65 536 usable against a 128 000 floor",
        }),
      ]),
      pool({ endpoints: [{ provider: "x" }] as AllowedPool["endpoints"] }),
    );
    expect(reason).toBe("context-floor: 65 536 usable against a 128 000 floor");
  });

  test("a rule nobody could grade is never quoted as the reason", () => {
    // A skipped rule is an absence of evidence. Reporting "this model was
    // refused because we could not measure it" would be a lie about a decision
    // the policy did not take on those grounds.
    const reason = rejectionReason(
      report([
        rule({
          rule: "throughput-floor",
          passed: false,
          skipped: "not-measured",
          detail: "no throughput published",
        }),
        rule({
          rule: "uptime-floor",
          severity: "soft",
          passed: false,
          detail: "96.2% against 98%",
        }),
      ]),
      pool({ endpoints: [{ provider: "x" }] as AllowedPool["endpoints"] }),
    );
    expect(reason).toBe("uptime-floor: 96.2% against 98%");
  });
});
