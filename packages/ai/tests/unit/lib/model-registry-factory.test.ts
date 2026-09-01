import { beforeAll, describe, expect, test } from "bun:test";
import {
  defaultChatbotAgentSet,
  getChatbotAgentSet,
} from "../../../src/agents/chatbot/index";
import {
  clearResolvedModelCache,
  resolveChatModelForProfile,
  resolveModel,
} from "../../../src/lib/model-registry/resolve";
import { installBoundFleet } from "../../lib/live-fleet";

beforeAll(() => {
  installBoundFleet();
  clearResolvedModelCache();
});

/**
 * C2 seams: per-profile chat resolution + the memoized agent-set factory. Both
 * are per-replica memoizations of stateless constructs — these tests pin the
 * memoization contracts the C3 eval header and per-team selection rely on.
 *
 * A third seam lived here until 2026-08-30: the per-family prompt-overlay
 * splice. It was removed with the mechanism, which had no producer — no profile
 * ever set `promptOverlayKey` and no overlay file was ever written — and which
 * a promoted model could not have used anyway, since synthesis emits no such
 * key.
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
      'No model profile for key "nope-9000"',
    );
  });
});

describe("getChatbotAgentSet", () => {
  test("no key → the default set, same instance as the default-set accessor", () => {
    expect(getChatbotAgentSet()).toBe(defaultChatbotAgentSet());
  });

  test("the default profile key resolves to the same memoized set", () => {
    const defaultKey = resolveModel("chat").profile.key;
    expect(getChatbotAgentSet(defaultKey)).toBe(defaultChatbotAgentSet());
  });

  test("a different profile gets its own set, memoized per key", () => {
    // minimax-m3 — a selectable flagship, distinct from the
    // deepseek-v4-flash chat default since the 2026-08-02 gated flip.
    const other = getChatbotAgentSet("minimax-m3");
    expect(other).not.toBe(defaultChatbotAgentSet());
    expect(getChatbotAgentSet("minimax-m3")).toBe(other);
    expect(other.toolNames).toEqual(defaultChatbotAgentSet().toolNames);
  });
});
