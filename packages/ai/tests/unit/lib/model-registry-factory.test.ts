import { describe, expect, test } from "bun:test";
import {
  chatbotAgentSet,
  getChatbotAgentSet,
} from "../../../src/agents/chatbot/index";
import { insertPromptOverlay } from "../../../src/agents/shared/prompt-renderer";
import {
  resolveChatModelForProfile,
  resolveModel,
} from "../../../src/lib/model-registry/resolve";

/**
 * C2 seams: per-profile chat resolution + memoized agent-set factory +
 * prompt-overlay splice. All three are per-replica memoizations of
 * stateless constructs — these tests pin the memoization contracts the
 * C3 eval header and C8 selection will rely on.
 */

describe("resolveChatModelForProfile", () => {
  test("default chat profile reuses the role-memoized instance", () => {
    const viaRole = resolveModel("chat");
    expect(resolveChatModelForProfile(viaRole.profile.key)).toBe(viaRole);
  });

  test("non-default profiles memoize per key under the chat envelope", () => {
    const first = resolveChatModelForProfile("minimax-m3");
    expect(resolveChatModelForProfile("minimax-m3")).toBe(first);
    expect(first.profile.catalog.id).toBe("minimax/minimax-m3");
    expect(first.binding.settingsKind).toBe("chat");
    expect(first.binding.wrapCache).toBe(true);
  });

  test("unknown profile keys fail loudly", () => {
    expect(() => resolveChatModelForProfile("nope-9000")).toThrow(
      'Unknown model profile key: "nope-9000"',
    );
  });
});

describe("getChatbotAgentSet", () => {
  test("no key → the default set, same instance as the chatbotAgentSet export", () => {
    expect(getChatbotAgentSet()).toBe(chatbotAgentSet);
  });

  test("the default profile key resolves to the same memoized set", () => {
    const defaultKey = resolveModel("chat").profile.key;
    expect(getChatbotAgentSet(defaultKey)).toBe(chatbotAgentSet);
  });

  test("a different profile gets its own set, memoized per key", () => {
    // minimax-m3 — a selectable flagship, distinct from the
    // deepseek-v4-flash chat default since the 2026-08-02 gated flip.
    const other = getChatbotAgentSet("minimax-m3");
    expect(other).not.toBe(chatbotAgentSet);
    expect(getChatbotAgentSet("minimax-m3")).toBe(other);
    expect(other.toolNames).toEqual(chatbotAgentSet.toolNames);
  });
});

describe("insertPromptOverlay", () => {
  const doc = [
    "static section",
    "",
    "<!--",
    "DYNAMIC SUFFIX — every section below is re-rendered with per-turn data",
    "-->",
    "",
    "dynamic {{placeholder}}",
  ].join("\n");

  test("empty overlay returns the text untouched (byte-identical prompt)", () => {
    expect(insertPromptOverlay(doc, "")).toBe(doc);
  });

  test("overlay lands at the end of the static prefix, above the marker", () => {
    const out = insertPromptOverlay(doc, "OVERLAY LINE");
    const overlayAt = out.indexOf("OVERLAY LINE");
    expect(overlayAt).toBeGreaterThan(out.indexOf("static section"));
    expect(overlayAt).toBeLessThan(out.indexOf("<!--"));
    // Dynamic suffix untouched.
    expect(out.endsWith("dynamic {{placeholder}}")).toBe(true);
  });

  test("falls back to appending when the marker is absent", () => {
    const out = insertPromptOverlay("just text", "OVERLAY");
    expect(out).toBe("just text\n\nOVERLAY\n");
  });
});
