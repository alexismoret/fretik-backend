import { describe, expect, it } from "bun:test";
import type { ProviderManifest } from "../../src/external-apps/manifest-schema";
import type { ResolvedAction } from "../../src/external-apps/registry";
import { buildRequest } from "../../src/services/external-apps/exec/build-request";

/**
 * Header threading was added so providers like Microsoft Planner can send
 * the `If-Match: <etag>` header that Graph PATCH/DELETE require. These tests
 * lock in that a request mapper's `headers` reach the built request, and that
 * the generic (no-mapper) path leaves headers undefined.
 */

const manifest = { key: "test" } as unknown as ProviderManifest;

const resolved = (overrides: Partial<ResolvedAction>): ResolvedAction => ({
  providerKey: "test",
  manifest,
  transport: { kind: "nango-proxy" },
  action: {
    name: "do_thing",
    kind: "write",
    summary: "Do a thing",
    endpoint: { method: "PATCH", path: "/v1.0/things/{thing_id}" },
    params: { thing_id: { type: "string", in: "path" } },
    returns: { ref: "WriteResult" },
  },
  ...overrides,
});

describe("buildRequest header threading", () => {
  it("forwards a request mapper's headers (e.g. If-Match) to the built request", () => {
    const built = buildRequest(
      resolved({
        requestMapper: (args) => ({
          headers: { "If-Match": String(args.etag) },
          body: { title: args.title },
        }),
      }),
      { thing_id: "T1", etag: 'W/"abc"', title: "New" },
    );

    expect(built.method).toBe("PATCH");
    expect(built.endpoint).toBe("/v1.0/things/T1");
    expect(built.headers).toEqual({ "If-Match": 'W/"abc"' });
    expect(built.body).toEqual({ title: "New" });
  });

  it("leaves headers undefined when no request mapper is declared", () => {
    const built = buildRequest(resolved({}), { thing_id: "T1" });
    expect(built.headers).toBeUndefined();
  });

  it("propagates the action's `paginate` flag onto the built request", () => {
    const action = {
      name: "list_things",
      kind: "read" as const,
      summary: "List things",
      endpoint: { method: "GET" as const, path: "/v1.0/things" },
      params: {},
      returns: { list: "Thing" },
      paginate: true,
    };
    const withMapper = buildRequest(
      resolved({ action, requestMapper: () => ({ query: { a: "1" } }) }),
      {},
    );
    const generic = buildRequest(resolved({ action }), {});
    expect(withMapper.paginate).toBe(true);
    expect(generic.paginate).toBe(true);
    // Off by default.
    expect(
      buildRequest(resolved({}), { thing_id: "T1" }).paginate,
    ).toBeUndefined();
  });
});

/**
 * Multipart exists for upload endpoints that accept nothing else — Directus'
 * `POST /files` is the case that forced it. Nango Proxy serialises a JSON
 * body, so handing it a file part would drop the bytes and still answer 2xx:
 * the mistake has to fail where it is made.
 */
describe("buildRequest multipart", () => {
  const multipart = {
    fields: { title: "BL.pdf" },
    file: {
      field: "file",
      filename: "BL.pdf",
      contentType: "application/pdf",
      base64: "JVBERi0=",
    },
  };

  it("carries a mapper's multipart body through on http-direct", () => {
    const built = buildRequest(
      resolved({
        transport: {
          kind: "http-direct",
          baseUrl: "https://example.test",
          auth: {
            kind: "header",
            name: "Authorization",
            source: "credentials.api_key",
          },
        },
        requestMapper: () => ({ multipart }),
      }),
      { thing_id: "T1" },
    );
    expect(built.multipart).toEqual(multipart);
    expect(built.body).toBeUndefined();
  });

  it("refuses it on any other transport rather than dropping the file", () => {
    expect(() =>
      buildRequest(resolved({ requestMapper: () => ({ multipart }) }), {
        thing_id: "T1",
      }),
    ).toThrow(/http-direct only/);
  });

  it("is undefined on every request that does not ask for it", () => {
    expect(
      buildRequest(resolved({ requestMapper: () => ({ body: {} }) }), {
        thing_id: "T1",
      }).multipart,
    ).toBeUndefined();
  });
});
