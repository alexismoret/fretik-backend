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
});
