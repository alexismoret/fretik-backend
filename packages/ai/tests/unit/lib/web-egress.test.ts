import { describe, expect, test } from "bun:test";
import { TOOL_ERROR_CODES } from "../../../src/lib/tool-error-codes";
import {
  areWebToolsEnabled,
  assertFetchableTargetWithPolicy,
  type EgressPolicy,
  hostFromUrl,
  isUrlDenied,
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

describe("isUrlDenied (searchWeb result filter)", () => {
  test("never denies when denylist is empty", () => {
    expect(isUrlDenied("https://evil.com/", [])).toBe(false);
  });

  test("denies hosts matching the denylist", () => {
    expect(isUrlDenied("https://evil.com/x", ["evil.com"])).toBe(true);
    expect(isUrlDenied("https://a.evil.com/x", ["evil.com"])).toBe(true);
    expect(isUrlDenied("https://ok.com/x", ["evil.com"])).toBe(false);
  });

  test("returns false for unparseable URLs", () => {
    expect(isUrlDenied("nonsense", ["evil.com"])).toBe(false);
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
