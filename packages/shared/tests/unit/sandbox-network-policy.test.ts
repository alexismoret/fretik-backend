import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ORGANIZATION_SANDBOX_POLICY,
  type OrganizationSandboxPolicy,
} from "../../src/schemas/sandbox-policy";
import {
  SANDBOX_EGRESS_TIERS,
  buildSandboxNetworkPolicy,
  detectBackendHost,
  policyFingerprint,
} from "../../src/services/e2b/network-policy";

/**
 * The sandbox egress policy — the one list standing between agent-authored
 * code and an exfiltration channel.
 *
 * Every assertion here is about a TIER being present or absent for a given
 * input, so deleting a tier or widening a mode turns a test red. The two
 * negative ones matter most: the retired `b2b` block (18 vendor domains, zero
 * measured requests, gists and Slack webhooks among them) must not come back,
 * and `api.github.com` must stay out of the package tier.
 */

const BACKEND = "api.fretik.com";

const mode = (
  egressMode: OrganizationSandboxPolicy["egressMode"],
  extraDomains: string[] = [],
): OrganizationSandboxPolicy => ({ egressMode, extraDomains });

describe("buildSandboxNetworkPolicy — tiers", () => {
  test("platform host is present in every mode, including the most closed", () => {
    for (const m of [
      "platform_only",
      "packages",
      "packages_plus_domains",
    ] as const) {
      const policy = buildSandboxNetworkPolicy({
        backendHost: BACKEND,
        orgPolicy: mode(m),
      });
      expect(policy.allowOut).toContain(BACKEND);
    }
  });

  test("a missing backend host drops the tier instead of guessing", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: null,
      orgPolicy: mode("packages"),
    });
    expect(policy.allowOut).not.toContain(BACKEND);
    expect(policy.allowOut).toEqual([...SANDBOX_EGRESS_TIERS.packages].sort());
  });

  test("provider hosts ride in every mode — the connection is what gates them", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("platform_only"),
      providerHosts: ["*.sharepoint.com"],
    });
    expect(policy.allowOut).toContain("*.sharepoint.com");
  });

  test("no connections means no provider hosts at all", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages"),
      providerHosts: [],
    });
    expect(policy.allowOut).not.toContain("*.sharepoint.com");
  });

  test("platform_only withholds the package registries", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("platform_only"),
    });
    expect(policy.allowOut).not.toContain("pypi.org");
    expect(policy.allowOut).toEqual([BACKEND]);
  });

  test("packages adds the registries and nothing else", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages", ["files.example.com"]),
    });
    expect(policy.allowOut).toContain("pypi.org");
    expect(policy.allowOut).toContain("deb.debian.org");
    // The domains exist on the org but the mode does not honour them.
    expect(policy.allowOut).not.toContain("files.example.com");
  });

  test("packages_plus_domains is the only mode that honours admin domains", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages_plus_domains", ["files.example.com"]),
    });
    expect(policy.allowOut).toContain("files.example.com");
    expect(policy.allowOut).toContain("pypi.org");
  });

  test("an org that never opened the page gets the default mode", () => {
    const withDefault = buildSandboxNetworkPolicy({ backendHost: BACKEND });
    const explicit = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: DEFAULT_ORGANIZATION_SANDBOX_POLICY,
    });
    expect(withDefault.allowOut).toEqual(explicit.allowOut);
    expect(withDefault.allowOut).toContain("pypi.org");
  });

  test("deny-all is always the floor", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages_plus_domains", ["files.example.com"]),
    });
    expect(policy.denyOut).toEqual(["0.0.0.0/0"]);
  });

  test("entries are deduplicated and sorted, so an unchanged policy is stable", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: "pypi.org",
      orgPolicy: mode("packages_plus_domains", ["pypi.org"]),
      providerHosts: ["pypi.org"],
    });
    expect(policy.allowOut.filter((h) => h === "pypi.org")).toHaveLength(1);
    expect(policy.allowOut).toEqual([...policy.allowOut].sort());
  });
});

describe("buildSandboxNetworkPolicy — what must NOT be reachable", () => {
  test("the retired b2b vendor block is gone", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages"),
    });
    for (const retired of [
      "*.google.com",
      "*.googleapis.com",
      "*.microsoft.com",
      "*.office.com",
      "*.sharepoint.com",
      "slack.com",
      "*.slack.com",
      "api.notion.com",
      "api.airtable.com",
      "*.salesforce.com",
      "api.hubapi.com",
      "api.stripe.com",
      "api.linear.app",
      "*.atlassian.com",
      "*.atlassian.net",
      "*.zendesk.com",
      "*.intercom.io",
      "*.fretik.com",
      "*.tunnl.gg",
    ]) {
      expect(policy.allowOut).not.toContain(retired);
    }
  });

  test("the package tier reaches no GitHub write surface", () => {
    // `api.github.com` is where a compromised turn POSTs a gist, and nothing
    // installs through it. The wildcard it used to hide behind is gone too.
    expect(SANDBOX_EGRESS_TIERS.packages).not.toContain("api.github.com");
    expect(SANDBOX_EGRESS_TIERS.packages).not.toContain("*.github.com");
    expect(SANDBOX_EGRESS_TIERS.packages).toContain("github.com");
    expect(SANDBOX_EGRESS_TIERS.packages).toContain("codeload.github.com");
  });

  test("apt is reachable, which the prompt has always claimed", () => {
    expect(SANDBOX_EGRESS_TIERS.packages).toContain("deb.debian.org");
    // Read off the running template: the security suite lives under
    // deb.debian.org/debian-security, so this host would be a dead entry.
    expect(SANDBOX_EGRESS_TIERS.packages).not.toContain("security.debian.org");
  });
});

describe("buildSandboxNetworkPolicy — brokered credential", () => {
  test("no JWT means no rules at all", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages"),
    });
    expect(policy.rules).toBeUndefined();
  });

  test("a JWT becomes one Authorization rule on the backend host only", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages"),
      brokeredJwt: "jwt-value",
    });
    expect(Object.keys(policy.rules ?? {})).toEqual([BACKEND]);
    expect(policy.rules).toEqual({
      [BACKEND]: [
        { transform: { headers: { Authorization: "Bearer jwt-value" } } },
      ],
    });
  });

  test("a JWT with nowhere to send it brokers nothing", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: null,
      orgPolicy: mode("packages"),
      brokeredJwt: "jwt-value",
    });
    expect(policy.rules).toBeUndefined();
  });

  test("an empty JWT is not a credential", () => {
    const policy = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages"),
      brokeredJwt: "",
    });
    expect(policy.rules).toBeUndefined();
  });
});

describe("policyFingerprint", () => {
  test("identical policies fingerprint identically", () => {
    const input = {
      backendHost: BACKEND,
      orgPolicy: mode("packages_plus_domains", [
        "b.example.com",
        "a.example.com",
      ]),
    };
    expect(policyFingerprint(buildSandboxNetworkPolicy(input))).toBe(
      policyFingerprint(buildSandboxNetworkPolicy(input)),
    );
  });

  test("a changed allowlist changes the fingerprint", () => {
    const before = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages"),
    });
    const after = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages_plus_domains", ["files.example.com"]),
    });
    expect(policyFingerprint(before)).not.toBe(policyFingerprint(after));
  });

  test("the credential itself never enters the fingerprint", () => {
    const one = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages"),
      brokeredJwt: "first-token",
    });
    const two = buildSandboxNetworkPolicy({
      backendHost: BACKEND,
      orgPolicy: mode("packages"),
      brokeredJwt: "second-token",
    });
    expect(policyFingerprint(one)).toBe(policyFingerprint(two));
    expect(policyFingerprint(one)).not.toContain("first-token");
  });
});

describe("detectBackendHost", () => {
  const withUrl = <T>(value: string | undefined, fn: () => T): T => {
    const previous = Bun.env.FRETIK_BACKEND_INTERNAL_URL;
    if (value === undefined) delete Bun.env.FRETIK_BACKEND_INTERNAL_URL;
    else Bun.env.FRETIK_BACKEND_INTERNAL_URL = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete Bun.env.FRETIK_BACKEND_INTERNAL_URL;
      else Bun.env.FRETIK_BACKEND_INTERNAL_URL = previous;
    }
  };

  test("takes the exact host, not a wildcard over its parent", () => {
    // The old version turned any dev tunnel into `*.tunnl.gg`, which allowed
    // an attacker's tunnel too. The policy is re-applied every turn now, so
    // a rotated subdomain is picked up without that trade.
    expect(withUrl("https://abc-123.tunnl.gg", detectBackendHost)).toBe(
      "abc-123.tunnl.gg",
    );
  });

  test("localhost, empty and unparseable all resolve to no tier", () => {
    expect(withUrl("http://localhost:3000", detectBackendHost)).toBeNull();
    expect(withUrl("", detectBackendHost)).toBeNull();
    expect(withUrl(undefined, detectBackendHost)).toBeNull();
    expect(withUrl("not a url", detectBackendHost)).toBeNull();
  });
});
