import { describe, expect, test } from "bun:test";
import type { ProviderManifest } from "../../src/external-apps/manifest-schema";
import { providerManifestSchema } from "../../src/external-apps/manifest-schema";
import { mockModule } from "../lib/mock-module";

/**
 * `testOnly` — a provider that answers without a third party.
 *
 * It exists because the sync eval suite spent three runs measuring an app it
 * could not call, and each of the three refusals (a missing manifest, then a
 * missing Nango binding, then a 404 from Nango) reached the agent as a
 * DIFFERENT failure, so it improvised differently against each one. The two
 * properties below are what make such a provider safe, and neither is visible
 * from reading the manifest.
 */

let nangoCalls = 0;
await mockModule("../../src/lib/external-apps/nango-client", {
  getNangoClient: () => {
    nangoCalls += 1;
    return {
      getConnection: () =>
        Promise.reject(new Error("a test double must never reach Nango")),
    };
  },
});

const { callCustomHandler } =
  await import("../../src/services/external-apps/exec/call-custom-handler");

const manifestFor = (testOnly: boolean): ProviderManifest =>
  providerManifestSchema.parse({
    key: "probe",
    displayName: "Probe",
    nangoProviderConfigKey: "probe",
    icon: "i-lucide-flask-conical",
    transport: { kind: "custom-handler" },
    ...(testOnly ? { testOnly: true } : {}),
    categories: ["data"],
    scopes: [],
    types: {},
    actions: [
      {
        name: "list_things",
        kind: "read",
        summary: "List things",
        handler: "listThings",
        params: {},
        returns: { fields: {} },
      },
    ],
  });

describe("a test-only provider holds no credentials", () => {
  test("its handler runs without Nango being asked for anything", async () => {
    nangoCalls = 0;
    const result = await callCustomHandler({
      manifest: manifestFor(true),
      providerConfigKey: "probe",
      connectionId: "conn-nobody-holds",
      handler: (args, ctx) =>
        Promise.resolve({ args, seen: Object.keys(ctx.credentials) }),
      args: { limit: 2 },
    });

    // The whole point: a connection Nango has never heard of still answers, so
    // the eval suite reads a real app over the real transport and stays
    // hermetic.
    expect(nangoCalls).toBe(0);
    expect(result).toEqual({ args: { limit: 2 }, seen: [] });
  });

  test("an ordinary custom-handler provider still fetches its credentials", async () => {
    // The guard is keyed on `testOnly` and nothing else. Were it keyed on
    // anything looser, a real provider would start calling its handler with
    // empty credentials and fail somewhere far from here.
    nangoCalls = 0;
    expect(
      callCustomHandler({
        manifest: manifestFor(false),
        providerConfigKey: "probe",
        connectionId: "conn-nobody-holds",
        handler: () => Promise.resolve("should never run"),
        args: {},
      }),
    ).rejects.toThrow("never reach Nango");
    expect(nangoCalls).toBe(1);
  });
});

describe("the flag cannot be put on a provider a user could connect", () => {
  test("a nango-proxy manifest declaring testOnly does not parse", () => {
    // There is no third party to proxy to, so any other transport would go
    // looking for one.
    expect(() =>
      providerManifestSchema.parse({
        ...manifestFor(true),
        transport: { kind: "nango-proxy" },
        actions: [
          {
            name: "list_things",
            kind: "read",
            summary: "List things",
            endpoint: { method: "GET", path: "/things" },
            params: {},
            returns: { fields: {} },
          },
        ],
      }),
    ).toThrow("custom-handler");
  });

  test("absent is the default — a manifest says nothing and is a real app", () => {
    expect(manifestFor(false).testOnly).toBeUndefined();
  });
});
