import { describe, expect, test } from "bun:test";
import {
  isOfficialNamespace,
  pickPreferredRemote,
  toServerEntry,
} from "../../src/lib/mcp-registry/normalize";
import type { McpRegistryServer } from "../../src/lib/mcp-registry/types";

/**
 * Catalog classification + endpoint selection. Official = DNS-verified
 * namespace (drives the badge + auto-run trust); no host is filtered out — a
 * discovered server connects through whatever endpoint it advertises.
 */

const server = (over: Partial<McpRegistryServer>): McpRegistryServer => ({
  name: "com.example/mcp",
  title: null,
  description: "",
  websiteUrl: null,
  iconUrl: null,
  remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
  status: "active",
  ...over,
});

describe("isOfficialNamespace", () => {
  test("DNS-verified reverse-DNS namespaces are official", () => {
    expect(isOfficialNamespace("com.notion/mcp")).toBe(true);
    expect(isOfficialNamespace("app.linear/linear")).toBe(true);
  });

  test("community io.github.* namespaces are not official", () => {
    expect(isOfficialNamespace("io.github.someone/tool")).toBe(false);
  });

  test("allow-listed vendor GitHub orgs are official", () => {
    expect(isOfficialNamespace("io.github.github/github-mcp-server")).toBe(
      true,
    );
  });
});

describe("pickPreferredRemote", () => {
  test("prefers streamable-http over sse", () => {
    expect(
      pickPreferredRemote([
        { type: "sse", url: "https://x/sse" },
        { type: "streamable-http", url: "https://x/mcp" },
      ]),
    ).toEqual({ type: "streamable-http", url: "https://x/mcp" });
  });

  test("falls back to the first remote when no streamable-http", () => {
    expect(
      pickPreferredRemote([{ type: "sse", url: "https://x/sse" }]),
    ).toEqual({ type: "sse", url: "https://x/sse" });
  });

  test("undefined when no remotes", () => {
    expect(pickPreferredRemote([])).toBeUndefined();
  });
});

describe("toServerEntry", () => {
  test("maps fields and derives a favicon when no icon", () => {
    const entry = toServerEntry(
      server({ name: "com.notion/mcp", title: "Notion", description: "d" }),
    );
    expect(entry.qualifiedName).toBe("com.notion/mcp");
    expect(entry.displayName).toBe("Notion");
    expect(entry.verified).toBe(true);
    expect(entry.iconUrl).toContain("faviconV2");
  });

  test("keeps the registry icon when present", () => {
    const entry = toServerEntry(
      server({ iconUrl: "https://cdn.example.com/logo.png" }),
    );
    expect(entry.iconUrl).toBe("https://cdn.example.com/logo.png");
  });

  test("falls back to the name when no title", () => {
    expect(
      toServerEntry(server({ name: "com.x/mcp", title: null })).displayName,
    ).toBe("com.x/mcp");
  });
});
