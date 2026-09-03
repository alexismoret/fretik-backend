import { describe, expect, it } from "bun:test";
import type { HttpDirectTransport } from "../../src/external-apps/manifest-schema";
import { projectHttpDirectAuth } from "../../src/services/external-apps/exec/http-direct";

/**
 * `http-direct` decides what a connection is even allowed to send. These
 * tests pin the one rule that is not obvious and that a provider gets to
 * choose: an extra header may be declared `optional`, and then a
 * connection that left its source empty sends NOTHING for it — rather
 * than the call failing, or the header going out empty.
 *
 * It exists because the opposite behaviour shipped: `X-Account-ID` was
 * mandatory, so no Shiptify connection could be created without naming an
 * account, and naming the wrong one made the provider answer 403 to every
 * later call. Any future API whose tenant selector is really a narrowing
 * filter has the same shape.
 */

const transport = (
  extraHeaders?: HttpDirectTransport["extraHeaders"],
  auth?: Partial<HttpDirectTransport["auth"]>,
): HttpDirectTransport => ({
  kind: "http-direct",
  baseUrl: "https://api.example.com",
  auth: {
    kind: "header",
    name: "Authorization",
    source: "credentials.api_key",
    ...auth,
  },
  ...(extraHeaders !== undefined ? { extraHeaders } : {}),
});

const CREDS = { api_key: "tok-123" };

describe("projectHttpDirectAuth — optional extra headers", () => {
  it("omits an optional header whose source the connection left empty", () => {
    const t = transport([
      { name: "X-Scope", source: "connection_config.scope", optional: true },
    ]);
    for (const config of [{}, { scope: "" }, { scope: null }]) {
      const { headers } = projectHttpDirectAuth(t, CREDS, config);
      expect(headers).toEqual({ Authorization: "tok-123" });
      expect("X-Scope" in headers).toBe(false);
    }
  });

  it("sends an optional header when the connection did set it", () => {
    const t = transport([
      { name: "X-Scope", source: "connection_config.scope", optional: true },
    ]);
    const { headers } = projectHttpDirectAuth(t, CREDS, { scope: 42 });
    expect(headers).toEqual({ Authorization: "tok-123", "X-Scope": "42" });
  });

  it("still fails on an extra header that did NOT opt out of being required", () => {
    const t = transport([
      { name: "X-Tenant", source: "connection_config.tenant" },
    ]);
    expect(() => projectHttpDirectAuth(t, CREDS, {})).toThrow(
      /missing required value at "connection_config.tenant"/,
    );
  });

  it("never treats the credential itself as optional", () => {
    const t = transport([
      { name: "X-Scope", source: "connection_config.scope", optional: true },
    ]);
    expect(() => projectHttpDirectAuth(t, {}, { scope: "s" })).toThrow(
      /missing required value at "credentials.api_key"/,
    );
  });
});

describe("projectHttpDirectAuth — credential placement", () => {
  it("prefixes the credential with the declared scheme", () => {
    const t = transport(undefined, { scheme: "Bearer " });
    const { headers } = projectHttpDirectAuth(t, CREDS, {});
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("sends the credential verbatim when no scheme is declared", () => {
    const { headers } = projectHttpDirectAuth(transport(), CREDS, {});
    expect(headers.Authorization).toBe("tok-123");
  });

  it("routes a query-kind credential to the query string, not the headers", () => {
    const t = transport(undefined, { kind: "query", name: "api_key" });
    const { headers, query } = projectHttpDirectAuth(t, CREDS, {});
    expect(query).toEqual({ api_key: "tok-123" });
    expect(headers).toEqual({});
  });

  it("rejects a source that names neither credentials nor connection_config", () => {
    const t = transport(undefined, { source: "secrets.api_key" });
    expect(() => projectHttpDirectAuth(t, CREDS, {})).toThrow(
      /source scope must be/,
    );
  });
});
