import { describe, expect, test } from "bun:test";
import { TOOL_ERROR_CODES } from "../../../src/lib/tool-error-codes";
import {
  areWebToolsEnabled,
  assertFetchableTargetWithPolicy,
  type EgressPolicy,
  hostFromUrl,
  isUrlDenied,
  pruneWebToolsIfUnavailable,
  WebEgressError,
} from "../../../src/lib/web-egress";

/**
 * Egress hardening for the chatbot web tools. The web stays OPEN by default;
 * these pin the always-on hygiene (scheme / private-IP / length) and the
 * opt-in denylist / allowlist toggles. Pure functions — no env, Redis, or net.
 */

const policy = (overrides: Partial<EgressPolicy> = {}): EgressPolicy => ({
  blockedDomains: [],
  allowedDomains: [],
  maxUrlLen: 2048,
  ...overrides,
});

/** Run the validator and return the WebEgressError it threw (or null if it passed). */
const blockOf = (
  url: string,
  p: EgressPolicy = policy(),
): WebEgressError | null => {
  try {
    assertFetchableTargetWithPolicy(url, p);
    return null;
  } catch (err) {
    if (err instanceof WebEgressError) return err;
    throw err;
  }
};

describe("assertFetchableTargetWithPolicy — always-on hygiene", () => {
  test("allows ordinary public http(s) URLs", () => {
    expect(blockOf("https://example.com")).toBeNull();
    expect(blockOf("http://docs.example.com/a/b?q=1#frag")).toBeNull();
    expect(blockOf("https://8.8.8.8/")).toBeNull();
    expect(blockOf("https://1.1.1.1/")).toBeNull();
  });

  test("rejects non-http(s) schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
      "ftp://example.com/x",
      "gopher://example.com/",
    ]) {
      const err = blockOf(url);
      expect(err?.detail.code).toBe(TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET);
    }
  });

  test("rejects private / loopback / link-local / metadata IPv4", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.100.100.200", // Alibaba metadata (within 100.64/10 CGNAT)
      "0.0.0.0",
    ]) {
      const err = blockOf(`http://${host}/`);
      expect(err?.detail.code).toBe(TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET);
    }
  });

  test("allows public IPv4 outside the private ranges", () => {
    expect(blockOf("http://172.32.0.1/")).toBeNull(); // just past 172.16/12
    expect(blockOf("http://100.63.0.1/")).toBeNull(); // just before CGNAT
    expect(blockOf("http://100.128.0.1/")).toBeNull(); // just past CGNAT
  });

  test("rejects private / loopback IPv6 (incl. IPv4-mapped + ULA)", () => {
    for (const host of [
      "[::1]",
      "[fd00:ec2::254]",
      "[fc00::1]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      const err = blockOf(`http://${host}/`);
      expect(err?.detail.code).toBe(TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET);
    }
  });

  test("rejects internal hostnames and single-label hosts", () => {
    for (const host of [
      "localhost",
      "foo.localhost",
      "svc.internal",
      "printer.local",
      "intranet",
    ]) {
      const err = blockOf(`http://${host}/`);
      expect(err?.detail.code).toBe(TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET);
    }
  });

  test("rejects URLs longer than maxUrlLen", () => {
    const long = `https://example.com/?q=${"a".repeat(3000)}`;
    expect(blockOf(long)?.detail.code).toBe(
      TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET,
    );
    expect(blockOf(long, policy({ maxUrlLen: 10_000 }))).toBeNull();
  });

  test("rejects unparseable URLs", () => {
    expect(blockOf("not a url")?.detail.code).toBe(
      TOOL_ERROR_CODES.WEB_FETCH_BLOCKED_TARGET,
    );
  });
});

describe("homograph / punycode normalization", () => {
  test("IDN homographs normalize to their xn-- form, defeating lookalikes", () => {
    // "аmazon.com" with a Cyrillic 'а' (U+0430).
    const homograph = "https://аmazon.com/";
    const host = hostFromUrl(homograph);
    expect(host).not.toBe("amazon.com");
    expect(host?.startsWith("xn--")).toBe(true);
    // An allowlist of the real domain does NOT admit the lookalike.
    expect(
      blockOf(homograph, policy({ allowedDomains: ["amazon.com"] }))?.detail
        .code,
    ).toBe(TOOL_ERROR_CODES.WEB_FETCH_DOMAIN_BLOCKED);
  });
});

describe("denylist (opt-in, off by default)", () => {
  test("empty denylist blocks nothing", () => {
    expect(blockOf("https://evil.com/")).toBeNull();
  });

  test("a listed domain blocks the apex and its subdomains", () => {
    const p = policy({ blockedDomains: ["evil.com"] });
    expect(blockOf("https://evil.com/", p)?.detail.code).toBe(
      TOOL_ERROR_CODES.WEB_FETCH_DOMAIN_BLOCKED,
    );
    expect(blockOf("https://sub.evil.com/", p)?.detail.code).toBe(
      TOOL_ERROR_CODES.WEB_FETCH_DOMAIN_BLOCKED,
    );
    expect(blockOf("https://good.com/", p)).toBeNull();
  });

  test("a wildcard pattern blocks only subdomains", () => {
    const p = policy({ blockedDomains: ["*.evil.com"] });
    expect(blockOf("https://sub.evil.com/", p)?.detail.code).toBe(
      TOOL_ERROR_CODES.WEB_FETCH_DOMAIN_BLOCKED,
    );
    expect(blockOf("https://evil.com/", p)).toBeNull();
  });
});

describe("allowlist (dormant, off by default)", () => {
  test("empty allowlist allows everything (web stays open)", () => {
    expect(blockOf("https://anything.example/")).toBeNull();
  });

  test("a non-empty allowlist flips to deny-by-default", () => {
    const p = policy({ allowedDomains: ["example.com"] });
    expect(blockOf("https://example.com/", p)).toBeNull();
    expect(blockOf("https://docs.example.com/", p)).toBeNull();
    expect(blockOf("https://other.com/", p)?.detail.code).toBe(
      TOOL_ERROR_CODES.WEB_FETCH_DOMAIN_BLOCKED,
    );
  });
});

describe("isUrlDenied (discovered-URL filter)", () => {
  test("never denies when neither list is set", () => {
    expect(isUrlDenied("https://evil.com/", policy())).toBe(false);
  });

  test("denies hosts matching the denylist", () => {
    const p = policy({ blockedDomains: ["evil.com"] });
    expect(isUrlDenied("https://evil.com/x", p)).toBe(true);
    expect(isUrlDenied("https://a.evil.com/x", p)).toBe(true);
    expect(isUrlDenied("https://ok.com/x", p)).toBe(false);
  });

  /**
   * The allowlist governs discovery too: surfacing a hit `webFetch` would
   * refuse wastes a credit and pushes the model to cite an unreadable page.
   */
  test("denies hosts outside a configured allowlist", () => {
    const p = policy({ allowedDomains: ["example.com"] });
    expect(isUrlDenied("https://example.com/x", p)).toBe(false);
    expect(isUrlDenied("https://docs.example.com/x", p)).toBe(false);
    expect(isUrlDenied("https://other.com/x", p)).toBe(true);
  });

  test("denylist wins over the allowlist", () => {
    const p = policy({
      allowedDomains: ["example.com"],
      blockedDomains: ["bad.example.com"],
    });
    expect(isUrlDenied("https://bad.example.com/x", p)).toBe(true);
  });

  test("returns false for unparseable URLs", () => {
    expect(
      isUrlDenied("nonsense", policy({ blockedDomains: ["evil.com"] })),
    ).toBe(false);
  });
});

describe("areWebToolsEnabled", () => {
  test("defaults to enabled, disabled only on the exact string 'false'", () => {
    const original = process.env.AI_WEB_TOOLS_ENABLED;
    try {
      delete process.env.AI_WEB_TOOLS_ENABLED;
      expect(areWebToolsEnabled()).toBe(true);
      process.env.AI_WEB_TOOLS_ENABLED = "true";
      expect(areWebToolsEnabled()).toBe(true);
      process.env.AI_WEB_TOOLS_ENABLED = "false";
      expect(areWebToolsEnabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.AI_WEB_TOOLS_ENABLED;
      else process.env.AI_WEB_TOOLS_ENABLED = original;
    }
  });
});

/**
 * The kill switch has to reach the registries built once at boot (sub-agents,
 * workflow runs) — they install no `prepareStep`, so without this they kept
 * calling Tavily after an operator disabled the web.
 */
describe("pruneWebToolsIfUnavailable", () => {
  const registry = { searchWeb: 1, webFetch: 2, webMap: 3, querySql: 4 };

  const withEnv = (
    env: { enabled?: string; key?: string },
    run: () => void,
  ): void => {
    const originalEnabled = process.env.AI_WEB_TOOLS_ENABLED;
    const originalKey = process.env.TAVILY_API_KEY;
    try {
      if (env.enabled === undefined) delete process.env.AI_WEB_TOOLS_ENABLED;
      else process.env.AI_WEB_TOOLS_ENABLED = env.enabled;
      if (env.key === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = env.key;
      run();
    } finally {
      if (originalEnabled === undefined)
        delete process.env.AI_WEB_TOOLS_ENABLED;
      else process.env.AI_WEB_TOOLS_ENABLED = originalEnabled;
      if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = originalKey;
    }
  };

  test("keeps every tool when enabled with a key (the normal case)", () => {
    withEnv({ key: "tvly-test" }, () => {
      expect(pruneWebToolsIfUnavailable(registry)).toEqual(registry);
    });
  });

  test("strips the web tools when the operator disables them", () => {
    withEnv({ enabled: "false", key: "tvly-test" }, () => {
      expect(pruneWebToolsIfUnavailable(registry)).toEqual({ querySql: 4 });
    });
  });

  test("strips the web tools when no Tavily key is configured", () => {
    withEnv({}, () => {
      expect(pruneWebToolsIfUnavailable(registry)).toEqual({ querySql: 4 });
    });
  });

  test("leaves the caller's registry untouched", () => {
    withEnv({}, () => {
      pruneWebToolsIfUnavailable(registry);
      expect(Object.keys(registry)).toHaveLength(4);
    });
  });
});
