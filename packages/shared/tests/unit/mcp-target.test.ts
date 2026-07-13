import { describe, expect, test } from "bun:test";
import {
  buildMcpTarget,
  type McpCredential,
} from "../../src/services/external-apps/mcp/target";

/**
 * `buildMcpTarget` is the pure secret→headers half of the MCP target resolver —
 * unit-testable without Nango. One case per credential scheme.
 */

const URL_ = "https://mcp.example.com/mcp";

describe("buildMcpTarget", () => {
  test("none → no auth headers", () => {
    const target = buildMcpTarget(URL_, { scheme: "none" });
    expect(target).toEqual({ url: URL_, headers: {}, transportType: "http" });
  });

  test("threads the SSE transport when requested", () => {
    const target = buildMcpTarget(URL_, { scheme: "none" }, "sse");
    expect(target.transportType).toBe("sse");
  });

  test("bearer → Authorization: Bearer (api-key default + nango-oauth)", () => {
    const cred: McpCredential = { scheme: "bearer", token: "tok_123" };
    expect(buildMcpTarget(URL_, cred).headers).toEqual({
      Authorization: "Bearer tok_123",
    });
  });

  test("header → raw custom header (api-key with X-Api-Key)", () => {
    const cred: McpCredential = {
      scheme: "header",
      name: "X-Api-Key",
      value: "k_secret",
    };
    expect(buildMcpTarget(URL_, cred).headers).toEqual({
      "X-Api-Key": "k_secret",
    });
  });

  test("basic → Authorization: Basic base64(user:pass)", () => {
    const cred: McpCredential = {
      scheme: "basic",
      username: "alice",
      password: "s3cr3t",
    };
    expect(buildMcpTarget(URL_, cred).headers).toEqual({
      Authorization: `Basic ${btoa("alice:s3cr3t")}`,
    });
  });

  test("preserves the server URL verbatim", () => {
    expect(buildMcpTarget(URL_, { scheme: "none" }).url).toBe(URL_);
  });
});
