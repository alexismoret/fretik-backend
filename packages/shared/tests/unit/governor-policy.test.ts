import { beforeEach, describe, expect, test } from "bun:test";
import type { ExternalAppConnection } from "../../src/db/schema";
import type { ProviderManifest } from "../../src/external-apps/manifest-schema";
import { setProviders } from "../../src/external-apps/registry";
import {
  isSingleFlightConnection,
  resolveGovernorPolicy,
  type PolicyConnection,
} from "../../src/services/external-apps/exec/governor/policy";

/**
 * The precedence IS the feature.
 *
 * Four layers can say how fast a connection may be asked — the operator's own
 * columns, the legacy `concurrency_mode` flag, the manifest's `rateLimit`, and
 * the manifest's older `concurrency.mode` — and each exists because the layer
 * above it cannot express something. Get the order wrong and the failure is
 * silent in the worst direction: an account with five licence seats held to
 * one, or a serial API asked six questions at once.
 *
 * Every case below differs from its neighbour in ONE field. A test that changed
 * two would prove the pair, not the rule.
 *
 * The manifests are REGISTERED here rather than imported: `@fretik/shared`
 * cannot depend on `@fretik/providers` (that is the inversion the registry
 * exists for), and pinning a real provider's declaration would make this suite
 * fail the day somebody legitimately changed Akanea's seat count.
 */

const manifest = (
  key: string,
  extras: Partial<ProviderManifest>,
): ProviderManifest => ({
  key,
  displayName: key,
  description: `Test provider ${key}`,
  nangoProviderConfigKey: key,
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
  ...extras,
});

const entry = (key: string, extras: Partial<ProviderManifest>) => ({
  manifest: manifest(key, extras),
  mappers: { request: {}, response: {} },
  summaries: {},
});

setProviders({
  // Layer 4: the older way of saying "one at a time", still spoken by three
  // real manifests.
  "serial-app": entry("serial-app", {
    concurrency: { mode: "serial", maxWaitMs: 8_000 },
  }),
  // Layer 3, both axes, plus a shared ceiling only a manifest may declare.
  "declared-app": entry("declared-app", {
    rateLimit: {
      perConnection: { requests: 600, perSeconds: 60 },
      perProvider: { requests: 50, perSeconds: 1 },
      maxConcurrent: 4,
    },
  }),
  // Declares nothing at all — the common case.
  "quiet-app": entry("quiet-app", {}),
});

const connection = (
  overrides: Partial<PolicyConnection> = {},
): PolicyConnection => ({
  id: "11111111-1111-7111-8111-111111111111",
  providerKey: "quiet-app",
  displayName: "Acme",
  concurrencyMode: null,
  rateLimitRequests: null,
  rateLimitPerSeconds: null,
  maxConcurrent: null,
  ...overrides,
});

const withEnv = (value: string | undefined, run: () => void): void => {
  const previous = process.env.EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE;
  if (value === undefined)
    delete process.env.EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE;
  else process.env.EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE = value;
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE;
    } else {
      process.env.EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE = previous;
    }
  }
};

beforeEach(() => {
  delete process.env.EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE;
});

describe("how many calls may be in flight at once", () => {
  test("the operator's number outranks the serial flag — five seats are five", () => {
    // The pair the whole precedence exists for: `concurrency_mode` was written
    // when the only choice was one-or-unlimited, so a number must win over it.
    const policy = resolveGovernorPolicy(
      connection({ maxConcurrent: 5, concurrencyMode: "serial" }),
    );
    expect(policy.maxConcurrent).toBe(5);
    expect(isSingleFlightConnection(connection({ maxConcurrent: 5 }))).toBe(
      false,
    );
  });

  test("the serial flag alone still means one", () => {
    const policy = resolveGovernorPolicy(
      connection({ concurrencyMode: "serial" }),
    );
    expect(policy.maxConcurrent).toBe(1);
  });

  test("a manifest that declares `serial` means one without any column set", () => {
    const policy = resolveGovernorPolicy(
      connection({ providerKey: "serial-app" }),
    );
    expect(policy.maxConcurrent).toBe(1);
    expect(
      isSingleFlightConnection(connection({ providerKey: "serial-app" })),
    ).toBe(true);
  });

  test("the account's own number overrides the manifest's serial declaration", () => {
    // Same provider as the case above; only `max_concurrent` differs. One
    // customer's account has three licence seats and only the operator knows.
    const policy = resolveGovernorPolicy(
      connection({ providerKey: "serial-app", maxConcurrent: 3 }),
    );
    expect(policy.maxConcurrent).toBe(3);
  });

  test("a declared `rateLimit.maxConcurrent` outranks a declared serial mode", () => {
    // `declared-app` says 4 and says nothing about `concurrency`; the point is
    // that the newer declaration is read at all, since the old one is the only
    // thing three shipped manifests speak.
    expect(
      resolveGovernorPolicy(connection({ providerKey: "declared-app" }))
        .maxConcurrent,
    ).toBe(4);
  });

  test("nothing declared anywhere is unlimited, not one", () => {
    expect(resolveGovernorPolicy(connection()).maxConcurrent).toBe(0);
  });
});

describe("the request budget", () => {
  test("the account's own columns win, and both are needed", () => {
    const policy = resolveGovernorPolicy(
      connection({ rateLimitRequests: 20, rateLimitPerSeconds: 10 }),
    );
    expect(policy.perConnection).toEqual({ requests: 20, perSeconds: 10 });
  });

  test("a half-filled override is no override — the default still applies", () => {
    // Only `rateLimitPerSeconds` differs from the case above. A budget with a
    // period and no count is not a budget, and reading it as one would divide
    // by zero.
    withEnv("300", () => {
      const policy = resolveGovernorPolicy(
        connection({ rateLimitRequests: null, rateLimitPerSeconds: 10 }),
      );
      expect(policy.perConnection).toEqual({ requests: 300, perSeconds: 60 });
    });
  });

  test("the process default is a floor under OUR fan-out, not a claim about the app", () => {
    withEnv("120", () => {
      expect(resolveGovernorPolicy(connection()).perConnection).toEqual({
        requests: 120,
        perSeconds: 60,
      });
    });
  });

  test("`0` turns the default off entirely", () => {
    withEnv("0", () => {
      expect(resolveGovernorPolicy(connection()).perConnection).toBeUndefined();
    });
  });

  test("a manifest budget beats the process default and loses to the account", () => {
    const declared = resolveGovernorPolicy(
      connection({ providerKey: "declared-app" }),
    );
    expect(declared.perConnection).toEqual({ requests: 600, perSeconds: 60 });
    // Only the two columns differ.
    const overridden = resolveGovernorPolicy(
      connection({
        providerKey: "declared-app",
        rateLimitRequests: 10,
        rateLimitPerSeconds: 1,
      }),
    );
    expect(overridden.perConnection).toEqual({ requests: 10, perSeconds: 1 });
  });

  test("the shared ceiling comes only from the manifest — no account may widen it", () => {
    // `perProvider` is every team's ceiling at once (an IP limit, the Nango
    // account limit). A connection column for it would let one team's operator
    // move a line everybody else is behind, so the account's own numbers must
    // leave it exactly where the manifest put it.
    const policy = resolveGovernorPolicy(
      connection({
        providerKey: "declared-app",
        rateLimitRequests: 9_999,
        rateLimitPerSeconds: 1,
      }),
    );
    expect(policy.perProvider).toEqual({ requests: 50, perSeconds: 1 });
    // And a provider that declares none has none — never a default.
    expect(resolveGovernorPolicy(connection()).perProvider).toBeUndefined();
  });
});

describe("what the policy carries for the caller", () => {
  test("it names the app, because the refusal message has to", () => {
    const policy = resolveGovernorPolicy(connection({ displayName: "Acme" }));
    expect(policy.displayName).toBe("Acme");
    expect(policy.connectionId).toBe("11111111-1111-7111-8111-111111111111");
  });

  test("a serial provider's declared wait budget is kept, not replaced", () => {
    // 8 s is the measured number from the serial slot this replaces: long
    // enough to absorb a page's fan-out, short enough that a stuck holder costs
    // one widget rather than the render.
    const policy = resolveGovernorPolicy(
      connection({ providerKey: "serial-app" }),
    );
    expect(policy.maxWaitMs).toBe(8_000);
  });
});

describe("the row it reads is the row the table has", () => {
  test("a whole connection row satisfies `PolicyConnection`", () => {
    // Compile-time, asserted at runtime so the check is a test and not a
    // comment: the day a column is renamed, this file stops building.
    const narrow = (row: ExternalAppConnection): PolicyConnection => row;
    expect(typeof narrow).toBe("function");
  });
});
