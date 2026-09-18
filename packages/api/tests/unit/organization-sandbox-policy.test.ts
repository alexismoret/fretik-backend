import "@hono/zod-openapi";
import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "../lib/mock-module";

/**
 * `/organization/sandbox-policy` — who may widen what the code sandbox reaches.
 *
 * The setting decides the egress allowlist of a VM that runs agent-authored
 * code, so the write is the whole security surface: a domain added here is a
 * host that code can talk to on every subsequent turn, for every member of the
 * org. Two guards stand in front of it and both are asserted below — the admin
 * check, and the domain schema that refuses a shared-platform wildcard
 * (`*.com`, `*.amazonaws.com`) no admin can have meant to grant.
 *
 * Reading is deliberately open to any member: the page answers "why did my
 * script fail to reach that host", which is a question a non-admin asks.
 *
 * The session wall itself is not re-tested here — `auth-boundary.test.ts`
 * probes every mounted router for it, this one included. What is doubled is
 * the middleware (identity is an input, not the subject) and the service (a DB
 * + Redis boundary); the route, its schema and the admin gate are real.
 */

const scenario: {
  isAdmin: boolean;
  stored: { egressMode: string; extraDomains: string[] };
  writes: unknown[];
} = {
  isAdmin: true,
  stored: { egressMode: "packages", extraDomains: [] },
  writes: [],
};

await mockModule("@fretik/shared/lib/auth-middleware", {
  authMiddleware: async (
    c: {
      set: (key: string, value: unknown) => void;
    },
    next: () => Promise<void>,
  ): Promise<void> => {
    c.set("user", { id: "user-1" });
    c.set("organization", { id: "org-1" });
    c.set("team", { id: "team-1", organizationId: "org-1" });
    await next();
  },
});

await mockModule("@fretik/shared/services/organization/member-role", {
  isOrgAdmin: (): Promise<boolean> => Promise.resolve(scenario.isAdmin),
});

await mockModule("@fretik/shared/services/organization/sandbox-policy", {
  getOrganizationSandboxPolicy: (): Promise<unknown> =>
    Promise.resolve(scenario.stored),
  setOrganizationSandboxPolicy: (input: unknown): Promise<unknown> => {
    scenario.writes.push(input);
    return Promise.resolve(scenario.stored);
  },
});

const { organizationRoutes } = await import("../../src/handlers/organization");

interface PolicyResponse {
  policy?: { egressMode: string; extraDomains: string[] };
  defaults?: { egressMode: string };
  limits?: { maxDomains: number };
  alwaysAllowed?: { platform: string[]; packages: string[] };
}

const get = async (): Promise<Response> =>
  organizationRoutes.request("/sandbox-policy");

const patch = async (body: unknown): Promise<Response> =>
  organizationRoutes.request("/sandbox-policy", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  scenario.isAdmin = true;
  scenario.stored = { egressMode: "packages", extraDomains: [] };
  scenario.writes = [];
});

describe("GET /organization/sandbox-policy", () => {
  test("returns the stored policy and the tiers an admin cannot change", async () => {
    scenario.stored = {
      egressMode: "packages_plus_domains",
      extraDomains: ["files.example.org"],
    };
    const response = await get();
    expect(response.status).toBe(200);

    const body = (await response.json()) as PolicyResponse;
    expect(body.policy?.egressMode).toBe("packages_plus_domains");
    expect(body.policy?.extraDomains).toEqual(["files.example.org"]);
    // The registries are what makes `pip install` work; the page states them
    // rather than claiming them.
    expect(body.alwaysAllowed?.packages).toContain("pypi.org");
    expect(body.limits?.maxDomains).toBe(50);
    expect(body.defaults?.egressMode).toBe("packages");
  });

  test("a member who is not an admin can read it", async () => {
    scenario.isAdmin = false;
    expect((await get()).status).toBe(200);
  });
});

describe("PATCH /organization/sandbox-policy", () => {
  test("an admin's patch reaches the service, scoped to their org", async () => {
    const response = await patch({
      egressMode: "packages_plus_domains",
      extraDomains: ["files.example.org"],
    });
    expect(response.status).toBe(200);
    expect(scenario.writes).toEqual([
      {
        organizationId: "org-1",
        patch: {
          egressMode: "packages_plus_domains",
          extraDomains: ["files.example.org"],
        },
      },
    ]);
  });

  test("a non-admin is refused and writes nothing", async () => {
    scenario.isAdmin = false;
    const response = await patch({ egressMode: "packages_plus_domains" });
    expect(response.status).toBe(403);
    expect(scenario.writes).toHaveLength(0);
  });

  test("a wildcard over a shared platform is refused", async () => {
    // `*.com` would allow every host on the internet; `*.amazonaws.com` every
    // tenant of one bucket host. Both parse as valid domain patterns, which is
    // why the schema refuses them by name rather than by shape.
    for (const domain of ["*.com", "*.amazonaws.com", "*"]) {
      const response = await patch({ extraDomains: [domain] });
      expect(response.status).toBe(400);
    }
    expect(scenario.writes).toHaveLength(0);
  });

  test("more domains than the limit are refused", async () => {
    const domains = Array.from(
      { length: 51 },
      (_, i) => `host-${i.toString()}.example.org`,
    );
    expect((await patch({ extraDomains: domains })).status).toBe(400);
    expect(scenario.writes).toHaveLength(0);
  });

  test("an unknown egress mode is refused", async () => {
    expect((await patch({ egressMode: "everything" })).status).toBe(400);
    expect(scenario.writes).toHaveLength(0);
  });

  test("an IP address is not a domain", async () => {
    expect((await patch({ extraDomains: ["10.0.0.1"] })).status).toBe(400);
    expect((await patch({ extraDomains: ["10.0.0.0/8"] })).status).toBe(400);
    expect(scenario.writes).toHaveLength(0);
  });
});
