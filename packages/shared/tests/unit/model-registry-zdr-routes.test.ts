import { describe, expect, test } from "bun:test";
import {
  evaluatePolicy,
  PUBLISHED_POLICY,
} from "../../src/model-registry/policy";
import type { EndpointStat } from "../../src/model-registry/types";
import { zdrRouteKey } from "../../src/services/model-registry/sync/sources/openrouter-zdr";

/**
 * Zero retention is a property of the ROUTE, not of the company, and the two
 * are easy to conflate because a provider name is what everything downstream is
 * keyed on. These cases pin the distinction where it changes an outcome.
 *
 * Shapes are taken from the live APIs on 2026-08-29: OpenRouter serves
 * `x-ai/grok-4.5` as `xai` and `xai/zdr`, and `z-ai/glm-5.2` through Fireworks
 * under three tags.
 */

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 131_072,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["max_tokens", "temperature", "tools", "tool_choice"],
  ...over,
  // The easy case, where identity and filter token coincide. Cases about the
  // hosts where they DIVERGE set this explicitly — see the wire-name suite.
  wireNames: over.wireNames ?? {
    openrouter: over.provider,
    gateway: over.provider,
  },
});

const zdrRuleOf = (
  endpoints: EndpointStat[],
): {
  pass: boolean;
  detail: string;
  severity: "hard" | "soft";
  hardFailures: number;
} => {
  const report = evaluatePolicy(
    PUBLISHED_POLICY,
    { endpoints, excludedProviders: [], requiresTools: true },
    new Date(),
  );
  const found = report.rules.find((r) => r.rule === "zdr");
  if (found === undefined) throw new Error("no zdr rule in the report");
  return {
    pass: found.passed,
    detail: found.detail,
    severity: found.severity,
    hardFailures: report.hardFailures,
  };
};

describe("zdrRouteKey", () => {
  test("keys on the model AND the tag, because a host serves both stances", () => {
    // The whole point: `xai` and `xai/zdr` are the same company and must not
    // collapse, or grok-4.5's non-ZDR route inherits the ZDR verdict.
    expect(zdrRouteKey("x-ai/grok-4.5", "xai")).not.toBe(
      zdrRouteKey("x-ai/grok-4.5", "xai/zdr"),
    );
    // And the same tag under a different model is a different route too.
    expect(zdrRouteKey("z-ai/glm-5.2", "mistral/zdr")).not.toBe(
      zdrRouteKey("x-ai/grok-4.5", "mistral/zdr"),
    );
  });

  test("is stable, so a set built one night matches a lookup the next", () => {
    expect(zdrRouteKey("z-ai/glm-5.2", "fireworks/fast")).toBe(
      zdrRouteKey("z-ai/glm-5.2", "fireworks/fast"),
    );
  });
});

describe("the zdr policy rule counts routes and names hosts separately", () => {
  test("one host on two routes reads as one host, not two", () => {
    // Regression: this reported `2 zero-retention endpoint(s): xai, xai`,
    // which reads as two independent upstreams when there is exactly one.
    const rule = zdrRuleOf([
      endpoint({ provider: "xai", hasZdr: true }),
      endpoint({ provider: "xai", hasZdr: true }),
    ]);
    expect(rule.pass).toBe(true);
    expect(rule.detail).toContain("2 zero-retention route(s)");
    expect(rule.detail).toContain("1 host(s)");
    expect(rule.detail).toEndWith("xai");
  });

  test("a repeated host is named once however many routes it serves", () => {
    const rule = zdrRuleOf([
      endpoint({ provider: "fireworks", hasZdr: true }),
      endpoint({ provider: "fireworks", hasZdr: true }),
      endpoint({ provider: "fireworks", hasZdr: true }),
      endpoint({ provider: "together", hasZdr: true }),
    ]);
    expect(rule.detail).toContain("4 zero-retention route(s) across 2 host(s)");
    // Naming it three times is what made the old message unreadable.
    expect(rule.detail.match(/fireworks/g)).toHaveLength(1);
  });

  test("a host's non-ZDR route does not lend it the ZDR verdict", () => {
    // xAI serving `xai` (retaining) and `xai/zdr` (not) is the real shape.
    // Only the ZDR route may be counted.
    const rule = zdrRuleOf([
      endpoint({ provider: "xai", hasZdr: false }),
      endpoint({ provider: "xai", hasZdr: true }),
    ]);
    expect(rule.detail).toContain("1 zero-retention route(s) across 1 host(s)");
  });

  test("every route declaring retention fails HARD", () => {
    const rule = zdrRuleOf([
      endpoint({ provider: "alibaba", hasZdr: false }),
      endpoint({ provider: "baidu", hasZdr: false }),
    ]);
    expect(rule.pass).toBe(false);
    expect(rule.detail).toContain("2 checked");
  });

  test("an unread source is a SOFT miss, never a hard refusal", () => {
    // The failure mode this guards: if the ZDR list is unreachable one night,
    // "no stance recorded" must not read as "nothing is zero-retention" —
    // that would hard-fail the entire fleet in a single pass. It counts
    // against health and gates nothing.
    const rule = zdrRuleOf([
      endpoint({ provider: "google" }),
      endpoint({ provider: "mistral" }),
    ]);
    expect(rule.severity).toBe("soft");
    expect(rule.pass).toBe(false);
    expect(rule.hardFailures).toBe(0);
    expect(rule.detail).toContain("enforced at request time");
  });
});
