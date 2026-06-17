/**
 * Unit tests for C8b per-team model resolution — the pure tier/role helpers
 * in `model-registry/resolve.ts` plus the DB-backed `team-model.ts`. The
 * team settings read is mocked so the test never pulls in Postgres/Redis.
 *
 * Registry facts these tests pin (from the live profiles registry):
 *   - workhorse: default `deepseek-v4-flash`, also-selectable `gpt-oss-120b`
 *   - utility:   default `gpt-oss-20b`,        also-selectable `gpt-4o-mini`
 *   - `minimax-m3` is flagship-only → wrong-tier for workhorse.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Drive the mocked settings read. MUST be registered before importing
// `team-model` (which transitively imports `@fretik/shared/db`).
let settings: {
  flagshipProfileKey: string | null;
  workhorseProfileKey: string | null;
  utilityProfileKey: string | null;
} | null = null;
let shouldThrow = false;

void mock.module(
  "@fretik/shared/services/team-ai-settings/get-for-team",
  () => ({
    getTeamAiSettings: (_teamId: string) => {
      if (shouldThrow) throw new Error("settings store down");
      return Promise.resolve(settings);
    },
  }),
);

const { resolveModel, resolveModelForRoleProfile, resolveTierProfileKey } =
  await import("../../../src/lib/model-registry/resolve");
const { resolveModelForTeam, cheapModelIdForTeam } =
  await import("../../../src/lib/model-registry/team-model");

beforeEach(() => {
  settings = null;
  shouldThrow = false;
});

describe("resolveTierProfileKey", () => {
  test("unset key → tier default, no fallback flag", () => {
    expect(resolveTierProfileKey("workhorse", null)).toEqual({
      profileKey: "deepseek-v4-flash",
      fellBack: false,
    });
    expect(resolveTierProfileKey("workhorse", undefined)).toEqual({
      profileKey: "deepseek-v4-flash",
      fellBack: false,
    });
  });

  test("valid selectable key is honoured", () => {
    expect(resolveTierProfileKey("workhorse", "gpt-oss-120b")).toEqual({
      profileKey: "gpt-oss-120b",
      fellBack: false,
    });
  });

  test("unknown key degrades to the tier default", () => {
    expect(resolveTierProfileKey("workhorse", "nope-9000")).toEqual({
      profileKey: "deepseek-v4-flash",
      fellBack: true,
    });
  });

  test("wrong-tier key (flagship-only) degrades to the tier default", () => {
    expect(resolveTierProfileKey("workhorse", "minimax-m3")).toEqual({
      profileKey: "deepseek-v4-flash",
      fellBack: true,
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
    settings = {
      flagshipProfileKey: "deepseek-v4-pro",
      workhorseProfileKey: "gpt-oss-120b",
      utilityProfileKey: "gpt-4o-mini",
    };
    // `vision` is a fixed role (never user-overridable).
    expect(await resolveModelForTeam("vision", "team-1")).toBe(
      resolveModel("vision"),
    );
  });

  test("team with no settings row → code default", async () => {
    settings = null;
    expect(await resolveModelForTeam("pre-extract", "team-1")).toBe(
      resolveModel("pre-extract"),
    );
  });

  test("null override field → code default", async () => {
    settings = {
      flagshipProfileKey: null,
      workhorseProfileKey: null,
      utilityProfileKey: null,
    };
    expect(await resolveModelForTeam("pre-extract", "team-1")).toBe(
      resolveModel("pre-extract"),
    );
  });

  test("unknown override → code default", async () => {
    settings = {
      flagshipProfileKey: null,
      workhorseProfileKey: "nope-9000",
      utilityProfileKey: null,
    };
    expect(await resolveModelForTeam("pre-extract", "team-1")).toBe(
      resolveModel("pre-extract"),
    );
  });

  test("valid workhorse override → the override instance, not the default", async () => {
    settings = {
      flagshipProfileKey: null,
      workhorseProfileKey: "gpt-oss-120b",
      utilityProfileKey: null,
    };
    const resolved = await resolveModelForTeam("pre-extract", "team-1");
    expect(resolved).toBe(
      resolveModelForRoleProfile("pre-extract", "gpt-oss-120b"),
    );
    expect(resolved).not.toBe(resolveModel("pre-extract"));
  });

  test("settings read throwing → code default (defensive)", async () => {
    shouldThrow = true;
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

  test("valid utility override → that profile's catalog id", async () => {
    settings = {
      flagshipProfileKey: null,
      workhorseProfileKey: null,
      utilityProfileKey: "gemini-3.1-flash-lite",
    };
    expect(await cheapModelIdForTeam("team-1")).toBe(
      resolveModelForRoleProfile("cheap-tasks", "gemini-3.1-flash-lite").profile
        .catalog.id,
    );
  });
});
