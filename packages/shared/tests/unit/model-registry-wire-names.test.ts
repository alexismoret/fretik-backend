import { describe, expect, test } from "bun:test";
import {
  normalizeProviderName,
  toWireNames,
  wireNameIndex,
} from "../../src/model-registry/provider-names";
import type { EndpointStat } from "../../src/model-registry/types";

/**
 * An identity is not a filter token, and the gap between them is where a
 * quarantine goes quiet.
 *
 * Every pairing below was read off the live APIs on 2026-08-29 — OpenRouter's
 * `tag` head against `GET /api/v1/providers`, and the gateway's own refusal
 * message, which enumerates the names it accepts.
 */

const stat = (
  provider: string,
  wireNames: EndpointStat["wireNames"],
): EndpointStat => ({
  provider,
  displayName: provider,
  wireNames,
  contextLength: 131_072,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools"],
});

/** The four hosts the two catalogues genuinely disagree about. */
const DIVERGENT = [
  stat("together", { openrouter: "together", gateway: "togetherai" }),
  stat("bedrock", { openrouter: "amazon-bedrock", gateway: "bedrock" }),
  stat("claudeaws", { openrouter: "claude-on-aws", gateway: "claudeaws" }),
  stat("google", { openrouter: "google-ai-studio", gateway: "google" }),
];

describe("the identity is not the wire name", () => {
  test("normalisation folds the very names the APIs require", () => {
    // This is the whole trap in three lines: the identity is a DIFFERENT
    // string from what either API accepts, so normalising on the way out —
    // which reads like a safety measure — is what breaks the request.
    expect(normalizeProviderName("togetherai")).toBe("together");
    expect(normalizeProviderName("Amazon Bedrock")).toBe("bedrock");
    expect(normalizeProviderName("Claude Platform on AWS")).toBe("claudeaws");
  });

  test("the two spellings of Anthropic-on-AWS land on one identity", () => {
    // OpenRouter's display name and its slug disagree; both must resolve, or
    // rows captured either side of the switch would count as two companies.
    expect(normalizeProviderName("claude-on-aws")).toBe(
      normalizeProviderName("Claude Platform on AWS"),
    );
  });

  test("Vertex and AI Studio stay APART, which display names cannot do", () => {
    // OpenRouter labels its Vertex route plainly `Google`. Folding that gives
    // `google` — the same identity as AI Studio — so a quarantine aimed at one
    // would silently take out the other. The slugs separate them, which is why
    // identities are derived from slugs.
    expect(normalizeProviderName("Google")).toBe(
      normalizeProviderName("Google AI Studio"),
    );
    expect(normalizeProviderName("google-vertex")).toBe("vertex");
    expect(normalizeProviderName("google-ai-studio")).toBe("google");
    expect(normalizeProviderName("google-vertex")).not.toBe(
      normalizeProviderName("google-ai-studio"),
    );
  });

  test("Vertex-for-Gemini and Vertex-for-Anthropic remain distinct", () => {
    // Same cloud, different upstream contract; the gateway names them apart
    // and so do we.
    expect(normalizeProviderName("vertexAnthropic")).not.toBe(
      normalizeProviderName("google-vertex"),
    );
  });
});

describe("wireNameIndex", () => {
  test("maps identity to the spelling of the transport asked for", () => {
    const or = wireNameIndex(DIVERGENT, "openrouter");
    expect(or.get("together")).toBe("together");
    expect(or.get("bedrock")).toBe("amazon-bedrock");
    expect(or.get("claudeaws")).toBe("claude-on-aws");

    const gw = wireNameIndex(DIVERGENT, "gateway");
    expect(gw.get("together")).toBe("togetherai");
    expect(gw.get("bedrock")).toBe("bedrock");
  });

  test("a host on several routes yields one entry", () => {
    // Fireworks serves glm-5.2 under `fireworks`, `fireworks/fast` and
    // `fireworks/fast-us`; they share a filter token.
    const index = wireNameIndex(
      [
        stat("fireworks", { openrouter: "fireworks" }),
        stat("fireworks", { openrouter: "fireworks" }),
        stat("fireworks", { openrouter: "fireworks" }),
      ],
      "openrouter",
    );
    expect(index.size).toBe(1);
    expect(index.get("fireworks")).toBe("fireworks");
  });

  test("a transport with no spelling on record is simply absent", () => {
    const index = wireNameIndex(
      [stat("together", { gateway: "togetherai" })],
      "openrouter",
    );
    expect(index.has("together")).toBe(false);
  });
});

describe("toWireNames translates a pool", () => {
  test("an allow-list DROPS what it cannot spell", () => {
    // The gateway refuses the entire request on an unknown `only` member, so a
    // name we cannot spell must never be sent.
    const { names, unresolved } = toWireNames(
      ["together", "mystery-host"],
      wireNameIndex(DIVERGENT, "gateway"),
      "drop",
    );
    expect(names).toEqual(["togetherai"]);
    expect(unresolved).toEqual(["mystery-host"]);
  });

  test("an exclusion list KEEPS what it cannot spell", () => {
    // OpenRouter discards an unrecognised `ignore` member, so passing the
    // identity costs nothing and may still match — while dropping it would
    // silently lift the quarantine.
    const { names, unresolved } = toWireNames(
      ["bedrock", "mystery-host"],
      wireNameIndex(DIVERGENT, "openrouter"),
      "keep",
    );
    expect(names).toEqual(["amazon-bedrock", "mystery-host"]);
    expect(unresolved).toEqual(["mystery-host"]);
  });

  test("unresolved names are reported even when they are kept", () => {
    // Silence here is the failure: the caller must be able to say the
    // quarantine may not have landed.
    const { unresolved } = toWireNames(["ghost"], new Map(), "keep");
    expect(unresolved).toEqual(["ghost"]);
  });

  test("two identities that map to one token collapse to one entry", () => {
    const index = new Map([
      ["fireworks", "fireworks"],
      ["fireworksfast", "fireworks"],
    ]);
    const { names } = toWireNames(
      ["fireworks", "fireworksfast"],
      index,
      "drop",
    );
    expect(names).toEqual(["fireworks"]);
  });

  test("order is preserved, because `order` is a routing preference", () => {
    const { names } = toWireNames(
      ["google", "bedrock", "together"],
      wireNameIndex(DIVERGENT, "openrouter"),
      "drop",
    );
    expect(names).toEqual(["google-ai-studio", "amazon-bedrock", "together"]);
  });

  test("an empty pool stays empty rather than becoming a wildcard", () => {
    const { names, unresolved } = toWireNames([], new Map(), "drop");
    expect(names).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});
