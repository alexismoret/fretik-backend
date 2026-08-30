/**
 * Per-team model resolution — the pure function/role helpers in
 * `model-registry/resolve.ts` plus the DB-backed `team-model.ts`. The team
 * settings read is mocked so the test never pulls in Postgres/Redis.
 *
 * Registry facts these tests pin (from the live profiles registry):
 *   - documents:   default `deepseek-v4-flash`
 *   - quick-tasks: default `gpt-oss-20b`
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { setTeamAiSettingsDouble } from "../../lib/team-ai-settings-double";

// The settings read is stubbed globally from `tests/preload.ts` (see that
// file + `tests/lib/team-ai-settings-double.ts` for why a per-file
// `mock.module()` here isn't reliable — team-model.ts is reachable from many
// other test files' import chains, so whichever one runs first wins the
// module cache). `setTeamAiSettingsDouble` drives that shared stub.
const { resolveModel, resolveModelForRoleProfile, resolveFunctionProfileKey } =
  await import("../../../src/lib/model-registry/resolve");
const { resolveModelForTeam, cheapModelIdForTeam, resolveTeamFlagship } =
  await import("../../../src/lib/model-registry/team-model");

beforeEach(() => {
  setTeamAiSettingsDouble(null);
});

describe("resolveFunctionProfileKey", () => {
  test("unset key → function default, no fallback flag", () => {
    expect(resolveFunctionProfileKey("documents", null)).toEqual({
      profileKey: "deepseek-v4-flash",
      fellBack: false,
    });
    expect(resolveFunctionProfileKey("documents", undefined)).toEqual({
      profileKey: "deepseek-v4-flash",
      fellBack: false,
    });
  });

  test("valid selectable key is honoured", () => {
    expect(resolveFunctionProfileKey("documents", "gpt-oss-120b")).toEqual({
      profileKey: "gpt-oss-120b",
      fellBack: false,
    });
  });

  test("unknown key degrades to the function default", () => {
    expect(resolveFunctionProfileKey("documents", "nope-9000")).toEqual({
      profileKey: "deepseek-v4-flash",
      fellBack: true,
    });
  });

  test("an UNMEASURED key is honoured — absent evidence never refuses", () => {
    // With no live snapshot there is no intelligence figure for `gpt-oss-20b`,
    // so `documents` returns `unknown` rather than `ineligible` and the team's
    // choice stands. The tier rule it replaces refused on a missing band,
    // which took a model away from a team on the strength of no measurement.
    expect(resolveFunctionProfileKey("documents", "gpt-oss-20b")).toEqual({
      profileKey: "gpt-oss-20b",
      fellBack: false,
    });
  });
});

describe("resolveModelForRoleProfile", () => {
  test("the role default short-circuits to the role-memoized instance", () => {
    expect(resolveModelForRoleProfile("pre-extract", "deepseek-v4-flash")).toBe(
      resolveModel("pre-extract"),
    );
  });

  test("a non-default key preserves the ROLE's envelope, not the chat one", () => {
    const r = resolveModelForRoleProfile("pre-extract", "gpt-oss-120b");
    expect(r.profile.key).toBe("gpt-oss-120b");
    expect(r.binding.role).toBe("pre-extract");
    expect(r.binding.settingsKind).toBe("preextract");
    expect(r.binding.settingsKind).not.toBe("chat");
  });

  test("memoized per (role, profileKey)", () => {
    const first = resolveModelForRoleProfile("pre-extract", "gpt-oss-120b");
    expect(resolveModelForRoleProfile("pre-extract", "gpt-oss-120b")).toBe(
      first,
    );
  });
});

describe("resolveModelForTeam", () => {
  test("no teamId → code default", async () => {
    expect(await resolveModelForTeam("pre-extract", undefined)).toBe(
      resolveModel("pre-extract"),
    );
  });

  test("fixed-tier role ignores team settings → code default", async () => {
    setTeamAiSettingsDouble({
      functionProfileKeys: {
        assistant: "deepseek-v4-pro",
        documents: "gpt-oss-120b",
        "quick-tasks": "gpt-4o-mini",
      },
    });
    // `vision` is a fixed role (never user-overridable).
    expect(await resolveModelForTeam("vision", "team-1")).toBe(
      resolveModel("vision"),
    );
  });

  test("team with no settings row → code default", async () => {
    setTeamAiSettingsDouble(null);
    expect(await resolveModelForTeam("pre-extract", "team-1")).toBe(
      resolveModel("pre-extract"),
    );
  });

  test("null override field → code default", async () => {
    setTeamAiSettingsDouble({
      functionProfileKeys: {},
    });
    expect(await resolveModelForTeam("pre-extract", "team-1")).toBe(
      resolveModel("pre-extract"),
    );
  });

  test("unknown override → code default", async () => {
    setTeamAiSettingsDouble({
      functionProfileKeys: { documents: "nope-9000" },
    });
    expect(await resolveModelForTeam("pre-extract", "team-1")).toBe(
      resolveModel("pre-extract"),
    );
  });

  test("a valid documents override → the override instance, not the default", async () => {
    setTeamAiSettingsDouble({
      functionProfileKeys: { documents: "gpt-oss-120b" },
    });
    const resolved = await resolveModelForTeam("pre-extract", "team-1");
    expect(resolved).toBe(
      resolveModelForRoleProfile("pre-extract", "gpt-oss-120b"),
    );
    expect(resolved).not.toBe(resolveModel("pre-extract"));
  });

  test("settings read throwing → code default (defensive)", async () => {
    setTeamAiSettingsDouble(null, true);
    expect(await resolveModelForTeam("pre-extract", "team-1")).toBe(
      resolveModel("pre-extract"),
    );
  });
});

describe("cheapModelIdForTeam", () => {
  test("no teamId → the cheap-tasks code-default catalog id", async () => {
    expect(await cheapModelIdForTeam(undefined)).toBe(
      resolveModel("cheap-tasks").profile.catalog.id,
    );
  });

  test("a valid quick-tasks override → that profile's catalog id", async () => {
    setTeamAiSettingsDouble({
      functionProfileKeys: { "quick-tasks": "gemini-3.1-flash-lite" },
    });
    expect(await cheapModelIdForTeam("team-1")).toBe(
      resolveModelForRoleProfile("cheap-tasks", "gemini-3.1-flash-lite").profile
        .catalog.id,
    );
  });
});

/**
 * The chat/workflow entry point (2026-07-27). Two things changed together and
 * both are pinned here: an unpinned conversation now follows the TEAM's model
 * pick (before, the prompt-bar picker stamped it at creation — that picker is
 * gone), and the team's thinking depth travels alongside the model it was
 * chosen for.
 */
describe("resolveTeamFlagship", () => {
  const codeDefault = "deepseek-v4-flash";

  test("no team in scope → code default, nothing stored", async () => {
    expect(await resolveTeamFlagship(undefined, null)).toEqual({
      profileKey: codeDefault,
      fellBack: false,
      storedReasoningLevel: null,
    });
  });

  test("unpinned conversation follows the TEAM's assistant pick", async () => {
    // The regression this guards: with the prompt-bar picker removed, new
    // conversations carry no pin, and resolving straight to the code default
    // would silently ignore the team's choice in settings.
    setTeamAiSettingsDouble({
      functionProfileKeys: { assistant: "deepseek-v4-pro" },
    });
    expect(await resolveTeamFlagship("team-1", null)).toEqual({
      profileKey: "deepseek-v4-pro",
      fellBack: false,
      storedReasoningLevel: null,
    });
  });

  test("an explicit pin wins over the team pick", async () => {
    setTeamAiSettingsDouble({
      functionProfileKeys: { assistant: "deepseek-v4-pro" },
    });
    const resolved = await resolveTeamFlagship("team-1", "glm-5.2");
    expect(resolved.profileKey).toBe("glm-5.2");
    expect(resolved.fellBack).toBe(false);
  });

  test("an unusable pin degrades to the code default and says so", async () => {
    const resolved = await resolveTeamFlagship("team-1", "retired-model");
    expect(resolved).toEqual({
      profileKey: codeDefault,
      fellBack: true,
      storedReasoningLevel: null,
    });
  });

  test("the stored depth rides along when the team's own flagship serves", async () => {
    setTeamAiSettingsDouble({
      functionProfileKeys: { assistant: "glm-5.2" },
      assistantReasoningLevel: "xhigh",
    });
    expect(await resolveTeamFlagship("team-1", null)).toEqual({
      profileKey: "glm-5.2",
      fellBack: false,
      storedReasoningLevel: "xhigh",
    });
  });

  test("the stored depth does NOT leak onto a differently-pinned model", async () => {
    // A depth is chosen against one model's cost and latency. A workflow pinned
    // elsewhere uses its own `reasoningLevel` column, not the team's.
    setTeamAiSettingsDouble({
      functionProfileKeys: { assistant: "glm-5.2" },
      assistantReasoningLevel: "xhigh",
    });
    const resolved = await resolveTeamFlagship("team-1", "deepseek-v4-pro");
    expect(resolved.profileKey).toBe("deepseek-v4-pro");
    expect(resolved.storedReasoningLevel).toBeNull();
  });

  test("settings read throwing → code default, no depth (defensive)", async () => {
    setTeamAiSettingsDouble(null, true);
    expect(await resolveTeamFlagship("team-1", null)).toEqual({
      profileKey: codeDefault,
      fellBack: false,
      storedReasoningLevel: null,
    });
  });
});
