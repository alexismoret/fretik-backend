import { describe, expect, test } from "bun:test";
import {
  CURATED_MCP_SERVERS,
  CURATED_QUALIFIED_NAMES,
  CURATED_REMOTE_HOSTS,
  findCuratedMcp,
  matchCuratedEntries,
  toCuratedServerEntry,
} from "../../src/lib/mcp-registry/curated";

/**
 * The curated "featured" head: real names + brand logos + known auth for the
 * SaaS vendors people actually connect, shown before the registry tail.
 */

describe("CURATED_MCP_SERVERS", () => {
  test("every entry has an https vendor URL and a supported transport", () => {
    for (const e of CURATED_MCP_SERVERS) {
      expect(e.serverUrl.startsWith("https://")).toBe(true);
      expect(["http", "sse"]).toContain(e.transport);
      expect(["oauth", "api-key", "none"]).toContain(e.auth);
    }
  });

  test("qualified names are unique", () => {
    expect(CURATED_QUALIFIED_NAMES.size).toBe(CURATED_MCP_SERVERS.length);
  });

  test("dedup sets are populated for the tail filter", () => {
    expect(CURATED_QUALIFIED_NAMES.has("com.notion/mcp")).toBe(true);
    expect(CURATED_REMOTE_HOSTS.has("mcp.notion.com")).toBe(true);
  });
});

describe("findCuratedMcp", () => {
  test("resolves a known vendor, undefined otherwise", () => {
    expect(findCuratedMcp("com.notion/mcp")?.displayName).toBe("Notion");
    expect(findCuratedMcp("io.github.pipeworx-io/google_maps")).toBeUndefined();
  });
});

describe("toCuratedServerEntry", () => {
  test("is always verified and carries a brand favicon logo", () => {
    const notion = CURATED_MCP_SERVERS.find((e) => e.displayName === "Notion");
    if (notion === undefined) throw new Error("fixture missing");
    const entry = toCuratedServerEntry(notion);
    expect(entry.verified).toBe(true);
    expect(entry.iconUrl).toContain("faviconV2");
    expect(entry.iconUrl).toContain("notion.so");
  });
});

describe("matchCuratedEntries", () => {
  test("no query returns the whole featured set", () => {
    expect(matchCuratedEntries(undefined).length).toBe(
      CURATED_MCP_SERVERS.length,
    );
  });

  test("matches on display name, case-insensitive", () => {
    const hits = matchCuratedEntries("stripe");
    expect(hits.map((e) => e.displayName)).toContain("Stripe");
    expect(hits.length).toBeLessThan(CURATED_MCP_SERVERS.length);
  });

  test("no match returns empty", () => {
    expect(matchCuratedEntries("zzz-not-a-vendor")).toEqual([]);
  });
});
