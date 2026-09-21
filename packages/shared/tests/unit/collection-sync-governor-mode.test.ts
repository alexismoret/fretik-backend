import { beforeEach, describe, expect, test } from "bun:test";
import type { ExternalAppConnection } from "../../src/db/schema";
import type { ProviderManifest } from "../../src/external-apps/manifest-schema";
import { setProviders } from "../../src/external-apps/registry";
import type { GovernorMode } from "../../src/services/external-apps/exec/governor/permit";
import { mockModule } from "../lib/mock-module";

/**
 * A sync run waits for its permit as a BACKGROUND caller.
 *
 * The distinction is not cosmetic. An interactive caller gives up after the
 * policy's `maxWaitMs` — 8 s by default — because somebody is watching a
 * spinner. A run has the whole `runBudgetMs` and, unlike a person, something
 * useful to do with a refusal: the walker turns `UpstreamRateLimitedError`
 * into a `rate_limited` stop that KEEPS its position and reschedules.
 *
 * `read-executor.ts` has documented "a sync run passes `background` with its
 * own deadline" since the governor shipped, and no call site passed it: every
 * sync read queued as if a person were waiting, so a busy connection cost a
 * leg after eight seconds instead of a pause. Nothing failed — the run just
 * gave up minutes early, and the counters looked like the app was refusing.
 *
 * So the assertion is on the ARGUMENT, which is the only place the difference
 * is visible before the wait happens.
 */

const captured: { opts: { governor?: GovernorMode } | undefined }[] = [];

await mockModule("../../src/services/external-apps/exec/read-executor", {
  executeReadAction: async (
    _resolved: unknown,
    _connection: unknown,
    _args: unknown,
    opts?: { governor?: GovernorMode },
  ) => {
    captured.push({ opts });
    return { items: [] };
  },
});

const { resolveSyncAction } =
  await import("../../src/services/collection-sync/resolve-action");

const manifest: ProviderManifest = {
  key: "paced-app",
  displayName: "Paced App",
  description: "Test provider",
  nangoProviderConfigKey: "paced-app",
  icon: "i-lucide-plug",
  iconColor: "#000000",
  scopes: [],
  transport: { kind: "nango-proxy" },
  categories: ["productivity"],
  types: { Thing: { id: { type: "string" } } },
  actions: [
    {
      name: "list_things",
      kind: "read",
      summary: "List things.",
      endpoint: { method: "GET", path: "/things" },
      params: {},
      returns: { list: "Thing" },
    },
  ],
};

setProviders({
  "paced-app": {
    manifest,
    mappers: { request: {}, response: {} },
    summaries: {},
  },
});

const connection: ExternalAppConnection = {
  id: "11111111-1111-7111-8111-111111111111",
  organizationId: "22222222-2222-7222-8222-222222222222",
  teamId: "33333333-3333-7333-8333-333333333333",
  userId: null,
  providerKey: "paced-app",
  displayName: "Acme",
  nangoConnectionId: "nango-conn",
  nangoProviderConfigKey: "paced-app",
  mcpAuthKind: null,
  mcpServerUrl: null,
  mcpApiKeyHeader: null,
  mcpTransport: null,
  iconUrl: null,
  description: null,
  catalogMeta: null,
  toolFingerprint: null,
  status: "active",
  options: null,
  actionPolicies: null,
  concurrencyMode: null,
  rateLimitRequests: null,
  rateLimitPerSeconds: null,
  maxConcurrent: null,
  lastErrorMessage: null,
  createdByUserId: "44444444-4444-7444-8444-444444444444",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  captured.length = 0;
});

describe("resolveSyncAction — how its calls wait", () => {
  test("a run's deadline reaches the call it resolved", async () => {
    const deadlineAt = Date.now() + 600_000;
    const resolved = await resolveSyncAction(connection, "list_things", {
      governor: { kind: "background", deadlineAt },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    await resolved.action.call({});
    expect(captured).toHaveLength(1);
    expect(captured[0]?.opts?.governor).toEqual({
      kind: "background",
      deadlineAt,
    });
  });

  test("resolved without one, the call keeps the interactive default", async () => {
    // The preview resolves this way, and it is right there: somebody pressed
    // "See what comes back" and is watching.
    const resolved = await resolveSyncAction(connection, "list_things");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    await resolved.action.call({});
    expect(captured).toHaveLength(1);
    expect(captured[0]?.opts?.governor).toBeUndefined();
  });
});
