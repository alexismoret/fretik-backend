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
 * calling a provider after an operator disabled the web.
 *
 * Availability is PER TOOL since 2026-09, because the three no longer share a
 * backend: `searchWeb` needs a search key (either provider's), `webFetch`
 * needs Parallel's headless browser, and `webMap` needs nothing — it reads a
 * site's own `sitemap.xml`. The cases below are the partial setups an operator
 * actually lands in, and each one asserts that a missing key costs only the
 * tools it backs.
 */
describe("pruneWebToolsIfUnavailable", () => {
  const registry = { searchWeb: 1, webFetch: 2, webMap: 3, querySql: 4 };

  /**
   * Asserted on the KEYS, because the helper is typed `<T>(registry: T) => T`
   * — it promises the caller the same tool set back, which is what lets the
   * two boot-time registries spread its result. Comparing the pruned result to
   * a smaller literal therefore cannot typecheck, and the behaviour under test
   * is exactly "which tool names survive".
   */
  const survivingTools = (tools: Record<string, unknown>): string[] =>
    Object.keys(pruneWebToolsIfUnavailable(tools)).sort();

  const ENV_KEYS = [
    "AI_WEB_TOOLS_ENABLED",
    "AI_WEB_SEARCH_PROVIDER",
    "PERPLEXITY_API_KEY",
    "PARALLEL_API_KEY",
  ] as const;

  const withEnv = (
    env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
    run: () => void,
  ): void => {
    const original = Object.fromEntries(
      ENV_KEYS.map((k) => [k, process.env[k]]),
    );
    try {
      for (const key of ENV_KEYS) {
        const value = env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      run();
    } finally {
      for (const key of ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  test("keeps every tool when both keys are configured (the normal case)", () => {
    withEnv(
      { PERPLEXITY_API_KEY: "pplx-test", PARALLEL_API_KEY: "par-test" },
      () => {
        expect(pruneWebToolsIfUnavailable(registry)).toEqual(registry);
      },
    );
  });

  test("strips every web tool when the operator disables them", () => {
    withEnv(
      {
        AI_WEB_TOOLS_ENABLED: "false",
        PERPLEXITY_API_KEY: "pplx-test",
        PARALLEL_API_KEY: "par-test",
      },
      () => {
        expect(survivingTools(registry)).toEqual(["querySql"]);
      },
    );
  });

  /**
   * The one tool that survives a key-less deployment, and deliberately: it
   * reads `robots.txt` and `sitemap.xml` directly, so there is no vendor whose
   * absence could break it.
   */
  test("keeps webMap when no provider key is configured at all", () => {
    withEnv({}, () => {
      expect(survivingTools(registry)).toEqual(["querySql", "webMap"]);
    });
  });

  test("a search key without Parallel keeps search and map, drops fetch", () => {
    withEnv({ PERPLEXITY_API_KEY: "pplx-test" }, () => {
      expect(survivingTools(registry)).toEqual([
        "querySql",
        "searchWeb",
        "webMap",
      ]);
    });
  });

  /**
   * The likeliest partial setup: `PARALLEL_API_KEY` is required for `webFetch`
   * anyway, so an operator commonly has it before adding the preferred search
   * key. Reading only the CONFIGURED provider would prune `searchWeb` from a
   * deployment that can plainly search — hence `effectiveSearchProvider`.
   */
  test("Parallel alone still serves search, even when Perplexity is preferred", () => {
    withEnv(
      { AI_WEB_SEARCH_PROVIDER: "perplexity", PARALLEL_API_KEY: "par-test" },
      () => {
        expect(pruneWebToolsIfUnavailable(registry)).toEqual(registry);
      },
    );
  });

  test("leaves the caller's registry untouched", () => {
    withEnv({}, () => {
      pruneWebToolsIfUnavailable(registry);
      expect(Object.keys(registry)).toHaveLength(4);
    });
  });
});
