import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()` — the method only exists once `@hono/zod-openapi` has patched
// Zod. In a service that happens at boot; here it has to be imported for the
// side effect.
import "@hono/zod-openapi";
import {
  PAGE_LIMITS,
  PageDefinitionSchema,
  type PageBrief,
} from "../../src/schemas/pages";
import { sanitizePageDefinition } from "../../src/services/pages/sanitize";

/**
 * The brief is ADDITIVE: it was introduced without a version bump, so the
 * contract that matters is that every page stored before it existed still
 * parses. If that breaks, the whole pages table stops loading.
 */

const BRIEF: PageBrief = {
  product: {
    job: "Work the team's mailbox without leaving Fretik.",
    audience: "Operations, between two calls, looking for one thread.",
    features: ["read a thread", "reply", "archive", "search"],
  },
  design: {
    layout: "Folder rail, message list, reading pane.",
    signature: "The reading pane keeps the thread collapsed until asked.",
  },
};

const withCode = (extra: Record<string, unknown>) => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: "<template><div /></template>" },
  ...extra,
});

describe("page brief", () => {
  test("a page stored before the brief existed still parses", () => {
    const parsed = PageDefinitionSchema.parse(withCode({}));
    expect(parsed.brief).toBeUndefined();
  });

  test("round-trips through the definition", () => {
    const parsed = PageDefinitionSchema.parse(withCode({ brief: BRIEF }));
    expect(parsed.brief).toEqual(BRIEF);
  });

  test("survives sanitising, which every write passes through", () => {
    const parsed = PageDefinitionSchema.parse(withCode({ brief: BRIEF }));
    const { definition } = sanitizePageDefinition(parsed);
    expect(definition.brief).toEqual(BRIEF);
  });

  test("refuses a feature list past the ceiling", () => {
    const tooMany = {
      ...BRIEF,
      product: {
        ...BRIEF.product,
        features: Array.from(
          { length: PAGE_LIMITS.maxBriefFeatures + 1 },
          (_, i) => `feature ${i.toString()}`,
        ),
      },
    };
    expect(() =>
      PageDefinitionSchema.parse(withCode({ brief: tooMany })),
    ).toThrow();
  });

  test("the design half is required once a brief is sent", () => {
    expect(() =>
      PageDefinitionSchema.parse(
        withCode({ brief: { product: BRIEF.product } }),
      ),
    ).toThrow();
  });
});
