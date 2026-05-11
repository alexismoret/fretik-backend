/**
 * `grepMemory` — substring search with stopword filtering, auto-glob
 * folder shorthand, line-content truncation centred on the match,
 * and the `truncationReason` discriminator surfaced to the agent.
 */
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { grepMemory } from "@fretik/shared/services/ai-memory/grep";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("grepMemory", () => {
  let fx: MemoryTestFixture;
  let scopeKey: {
    organizationId: string;
    teamId: string;
    userId: string;
  };

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
    const [userA] = fx.userIds;
    scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    // Seed a few carriers to exercise auto-glob + scope filters.
    await createMemory({
      rawPath: "/memories/team/carriers/dhl.md",
      content: "## DHL\nContact: Marie Dupont\nemail: marie@dhl.com",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    await createMemory({
      rawPath: "/memories/team/carriers/maersk.md",
      content: "## Maersk\nContact: Jean Martin\nlong line: " + "x".repeat(400),
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    await createMemory({
      rawPath: "/memories/team/conventions.md",
      content: "## Acronymes\n- BL: Bill of Lading\n- CMR: Convention",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("rejects a stopword pattern with PATTERN_TOO_GENERIC", async () => {
    let thrown: unknown;
    try {
      await grepMemory({ pattern: "the", scopeKey });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    if (thrown instanceof HTTPException) {
      const body = JSON.parse(thrown.message) as { code: string };
      expect(body.code).toBe("MEMORY_PATTERN_TOO_GENERIC");
    }
  });

  test("rejects a multi-token all-stopwords pattern", async () => {
    // Both tokens are in the stopword list — see grep.ts STOPWORDS.
    let thrown: unknown;
    try {
      await grepMemory({ pattern: "the and", scopeKey });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    if (thrown instanceof HTTPException) {
      const body = JSON.parse(thrown.message) as { code: string };
      expect(body.code).toBe("MEMORY_PATTERN_TOO_GENERIC");
    }
  });

  test("auto-globs a bare folder name (carriers → carriers/*)", async () => {
    const result = await grepMemory({
      pattern: "Marie",
      scopeKey,
      pathGlob: "carriers",
    });
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits.every((h) => h.path.startsWith("carriers/"))).toBe(true);
  });

  test("centres line truncation on the match for long lines", async () => {
    const result = await grepMemory({ pattern: "long line", scopeKey });
    const hit = result.hits.find((h) => h.line_content.includes("long line"));
    expect(hit).toBeDefined();
    if (hit) {
      // Truncated lines start AND/OR end with an ellipsis when the
      // window does not cover the original line.
      expect(hit.truncated).toBe(true);
      expect(hit.line_content.length).toBeLessThanOrEqual(240);
      expect(hit.line_content).toContain("long line");
    }
  });

  test("returns truncationReason='none' on a small result set", async () => {
    const result = await grepMemory({ pattern: "Convention", scopeKey });
    expect(result.truncationReason).toBe("none");
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
  });
});
