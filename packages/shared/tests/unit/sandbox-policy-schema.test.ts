import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ORGANIZATION_SANDBOX_POLICY,
  SANDBOX_MAX_EXTRA_DOMAINS,
  organizationSandboxPolicySchema,
  resolveSandboxPolicy,
  sandboxDomainSchema,
  sandboxHostPatternSchema,
} from "../../src/schemas/sandbox-policy";

/**
 * What an admin may type into the sandbox egress list.
 *
 * The rejections carry the weight: every one of them is a way to widen the
 * policy past what the page shows. An IP or a CIDR is not matchable by SNI at
 * all, and a wildcard over a shared platform reads like one rule while
 * granting every tenant on it.
 */

const accepts = (value: string): string => sandboxDomainSchema.parse(value);
const rejects = (value: string): boolean =>
  !sandboxDomainSchema.safeParse(value).success;

describe("sandboxDomainSchema — accepted shapes", () => {
  test("a plain hostname", () => {
    expect(accepts("files.example.com")).toBe("files.example.com");
  });

  test("a wildcard over a hostname the org controls", () => {
    expect(accepts("*.example.com")).toBe("*.example.com");
  });

  test("case and surrounding space are normalised, not rejected", () => {
    expect(accepts("  Files.EXAMPLE.com  ")).toBe("files.example.com");
  });

  test("a specific host under a shared platform stays allowed", () => {
    // Only the WILDCARD over a shared platform is refused: naming your own
    // tenant is exactly what an admin should be able to do.
    expect(accepts("contoso.sharepoint.com")).toBe("contoso.sharepoint.com");
    expect(accepts("my-bucket.s3.amazonaws.com")).toBe(
      "my-bucket.s3.amazonaws.com",
    );
  });
});

describe("sandboxDomainSchema — rejected shapes", () => {
  test("a bare wildcard is the whole internet", () => {
    expect(rejects("*")).toBe(true);
    expect(rejects("*.*")).toBe(true);
  });

  test("a wildcard over a public suffix is every site under it", () => {
    expect(rejects("*.com")).toBe(true);
    expect(rejects("*.co.uk")).toBe(true);
  });

  test("a wildcard over a shared platform is every tenant on it", () => {
    for (const value of [
      "*.sharepoint.com",
      "*.amazonaws.com",
      "*.vercel.app",
      "*.github.io",
      "*.workers.dev",
      "*.googleapis.com",
    ]) {
      expect(rejects(value)).toBe(true);
    }
  });

  test("addresses and ranges, which SNI cannot match", () => {
    expect(rejects("10.0.0.1")).toBe(true);
    expect(rejects("10.0.0.0/8")).toBe(true);
    expect(rejects("169.254.169.254")).toBe(true);
    expect(rejects("::1")).toBe(true);
  });

  test("anything carrying a scheme, a path or a port", () => {
    expect(rejects("https://example.com")).toBe(true);
    expect(rejects("example.com/path")).toBe(true);
    expect(rejects("example.com:443")).toBe(true);
  });

  test("a partial-label wildcard, which E2B does not support", () => {
    expect(rejects("api*.example.com")).toBe(true);
  });

  test("a hostname with no dot", () => {
    expect(rejects("localhost")).toBe(true);
  });
});

describe("sandboxHostPatternSchema — what manifests may declare", () => {
  test("it accepts the shared-platform wildcard the admin schema refuses", () => {
    // A manifest is code and is reviewed, and the host only reaches the
    // allowlist while a connection to that provider is live.
    expect(sandboxHostPatternSchema.parse("*.sharepoint.com")).toBe(
      "*.sharepoint.com",
    );
    expect(rejects("*.sharepoint.com")).toBe(true);
  });

  test("it still refuses what cannot be enforced", () => {
    expect(sandboxHostPatternSchema.safeParse("10.0.0.0/8").success).toBe(
      false,
    );
    expect(sandboxHostPatternSchema.safeParse("*").success).toBe(false);
  });
});

describe("organizationSandboxPolicySchema", () => {
  test("an empty object is the default policy", () => {
    expect(organizationSandboxPolicySchema.parse({})).toEqual(
      DEFAULT_ORGANIZATION_SANDBOX_POLICY,
    );
  });

  test("duplicates collapse and the list is sorted", () => {
    const parsed = organizationSandboxPolicySchema.parse({
      egressMode: "packages_plus_domains",
      extraDomains: ["b.example.com", "A.example.com", "a.example.com"],
    });
    expect(parsed.extraDomains).toEqual(["a.example.com", "b.example.com"]);
  });

  test("the list has a ceiling", () => {
    const tooMany = Array.from(
      { length: SANDBOX_MAX_EXTRA_DOMAINS + 1 },
      (_, i) => `host-${i.toString()}.example.com`,
    );
    expect(
      organizationSandboxPolicySchema.safeParse({
        egressMode: "packages_plus_domains",
        extraDomains: tooMany,
      }).success,
    ).toBe(false);
  });

  test("one bad entry rejects the write rather than being dropped", () => {
    expect(
      organizationSandboxPolicySchema.safeParse({
        egressMode: "packages_plus_domains",
        extraDomains: ["ok.example.com", "*.com"],
      }).success,
    ).toBe(false);
  });

  test("an unknown mode is not accepted", () => {
    expect(
      organizationSandboxPolicySchema.safeParse({ egressMode: "everything" })
        .success,
    ).toBe(false);
  });
});

describe("resolveSandboxPolicy", () => {
  test("a stored value written by an older shape never breaks a turn", () => {
    // This runs on the path of every code-running turn. Throwing here would
    // fail the turn that needed a sandbox, over a settings column.
    expect(resolveSandboxPolicy(null)).toEqual(
      DEFAULT_ORGANIZATION_SANDBOX_POLICY,
    );
    expect(resolveSandboxPolicy(undefined)).toEqual(
      DEFAULT_ORGANIZATION_SANDBOX_POLICY,
    );
    expect(resolveSandboxPolicy({ egressMode: "nonsense" })).toEqual(
      DEFAULT_ORGANIZATION_SANDBOX_POLICY,
    );
    expect(resolveSandboxPolicy("not an object")).toEqual(
      DEFAULT_ORGANIZATION_SANDBOX_POLICY,
    );
  });

  test("a partial row is completed, not discarded", () => {
    expect(resolveSandboxPolicy({ egressMode: "platform_only" })).toEqual({
      egressMode: "platform_only",
      extraDomains: [],
    });
  });
});
