import { describe, expect, test } from "bun:test";
import {
  assertPublicHttpsUrl,
  UnsafeUrlError,
} from "../../src/lib/net/assert-public-https-url";

/**
 * SSRF guard contract for direct MCP transport URLs: only well-formed public
 * https targets pass, and a public hostname that resolves to a private address
 * is rejected. A stubbed resolver keeps the test hermetic (no real DNS).
 */

/** Resolver stub — public hostnames resolve to a harmless public IP. */
const publicResolver = async () => [{ address: "93.184.216.34" }];

/** Run the guard and return the thrown error (or undefined on success). */
const guardError = async (
  url: string,
  opts?: Parameters<typeof assertPublicHttpsUrl>[1],
): Promise<unknown> => {
  try {
    await assertPublicHttpsUrl(url, opts);
    return undefined;
  } catch (error) {
    return error;
  }
};

describe("assertPublicHttpsUrl", () => {
  test("accepts a well-formed public https URL", async () => {
    expect(
      await guardError("https://mcp.notion.com/mcp", {
        resolve: publicResolver,
      }),
    ).toBeUndefined();
  });

  test.each([
    ["http scheme", "http://mcp.example.com/mcp"],
    ["ftp scheme", "ftp://mcp.example.com/mcp"],
    ["embedded credentials", "https://user:pw@mcp.example.com/mcp"],
    ["localhost", "https://localhost/mcp"],
    ["loopback v4", "https://127.0.0.1/mcp"],
    ["private 10/8", "https://10.1.2.3/mcp"],
    ["private 172.16/12", "https://172.16.0.1/mcp"],
    ["private 192.168/16", "https://192.168.1.1/mcp"],
    ["cloud metadata", "https://169.254.169.254/mcp"],
    ["loopback v6", "https://[::1]/mcp"],
    ["unique-local v6", "https://[fd00::1]/mcp"],
    ["ipv4-mapped v6", "https://[::ffff:127.0.0.1]/mcp"],
    ["dotless host", "https://intranet/mcp"],
    ["dot-internal", "https://api.internal/mcp"],
  ])("rejects %s", async (_label, url) => {
    expect(await guardError(url, { resolve: publicResolver })).toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  test("rejects an over-long URL", async () => {
    const url = `https://mcp.example.com/${"a".repeat(2100)}`;
    expect(await guardError(url, { resolve: publicResolver })).toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  test("rejects a public host that resolves to a private address", async () => {
    const err = await guardError("https://rebind.example.com/mcp", {
      resolve: async () => [{ address: "10.0.0.5" }],
    });
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });

  test("rejects a host that resolves to no address", async () => {
    const err = await guardError("https://nxdomain.example.com/mcp", {
      resolve: async () => [],
    });
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });

  test("allowPrivate admits http + localhost (dev escape hatch)", async () => {
    expect(
      await guardError("http://localhost:8931/mcp", { allowPrivate: true }),
    ).toBeUndefined();
  });

  test("passes an already-public IP literal without resolving", async () => {
    let resolverCalls = 0;
    const err = await guardError("https://93.184.216.34/mcp", {
      resolve: async () => {
        resolverCalls++;
        return [{ address: "93.184.216.34" }];
      },
    });
    expect(err).toBeUndefined();
    expect(resolverCalls).toBe(0);
  });
});
