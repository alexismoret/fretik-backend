/**
 * `viewMemory` — Anthropic-style line-numbered file render, depth-2
 * directory listing, and 404 mapping for unknown paths.
 */
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { viewMemory } from "@fretik/shared/services/ai-memory/view";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("viewMemory", () => {
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
    await createMemory({
      rawPath: "/memories/team/conventions.md",
      content: "line one\nline two\nline three",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    await createMemory({
      rawPath: "/memories/team/carriers/dhl.md",
      content: "DHL",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("renders a file with line-numbered tab-prefixed body", async () => {
    const result = await viewMemory({
      rawPath: "/memories/team/conventions.md",
      scopeKey,
    });
    expect(result.kind).toBe("file");
    expect(result.rendered).toContain(
      "Here's the content of /memories/team/conventions.md with line numbers:",
    );
    // Line numbers padded + tab + content.
    expect(result.rendered).toMatch(/\n\s+1\tline one/);
    expect(result.rendered).toMatch(/\n\s+2\tline two/);
    expect(result.rendered).toMatch(/\n\s+3\tline three/);
  });

  test("respects view_range slicing (1-indexed inclusive)", async () => {
    const result = await viewMemory({
      rawPath: "/memories/team/conventions.md",
      viewRange: [2, 3],
      scopeKey,
    });
    expect(result.rendered).not.toContain("line one");
    expect(result.rendered).toContain("line two");
    expect(result.rendered).toContain("line three");
  });

  test("lists a directory with sub-counts", async () => {
    const result = await viewMemory({
      rawPath: "/memories/team",
      scopeKey,
    });
    expect(result.kind).toBe("directory");
    expect(result.rendered).toContain("/memories/team/conventions.md");
    expect(result.rendered).toContain("/memories/team/carriers/");
  });

  test("returns 404 for an unknown path", async () => {
    let thrown: unknown;
    try {
      await viewMemory({
        rawPath: "/memories/team/never-existed.md",
        scopeKey,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    if (thrown instanceof HTTPException) {
      expect(thrown.status).toBe(404);
      const body = JSON.parse(thrown.message) as { code: string };
      expect(body.code).toBe("MEMORY_FILE_NOT_FOUND");
    }
  });
});
