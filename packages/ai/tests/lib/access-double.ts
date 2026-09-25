import type { UserPrincipal } from "@fretik/shared/authz/principal";
import { mock } from "bun:test";
import { mockModule } from "./mock-module";

/**
 * The access engine, doubled for the unit tests of a tool.
 *
 * A tool asks two things before it acts: who the turn acts for
 * (`actingPrincipal`, which reads the database and Redis) and whether that
 * person may (`requireAccess`, `resolveAccess`, `requireCapability`,
 * `hasCapability`). The rules themselves have their own suites —
 * `@fretik/shared`'s `authz-rules`, `authz-capabilities` and the integration
 * tests against a real database. What a tool's unit test asserts is what the
 * tool DOES once allowed, so here every gate lets the call through, unless a
 * test hands it a refusal (`refuseNext`), and every gate asked is recorded.
 *
 * Module mocks are process-wide: `restore()` belongs in the file's `afterAll`.
 */

/** A member of `team-1` in `org-1`, with the full access members get. */
export const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  userId: "user-1",
  organizationId: "org-1",
  orgRole: "member",
  isOrgAdmin: false,
  isGuest: false,
  teamRoles: new Map([["team-1", "member"]]),
  teamContentLevels: new Map([["team-1", "full"]]),
  projectLevels: new Map(),
};

export interface AccessDouble {
  /** Every gate asked, in order: its name and its argument. */
  readonly calls: { gate: string; args: unknown[] }[];
  /** The next gate throws this instead of letting the call through. */
  refuseNext: (error: Error) => void;
  /** Put the real modules back. */
  restore: () => void;
}

export const installAccessDouble = async (): Promise<AccessDouble> => {
  const realActing = await import("../../src/agents/shared/acting-principal");
  const realAccess = await import("@fretik/shared/authz/access");
  const realGates = await import("@fretik/shared/authz/gates");

  const calls: AccessDouble["calls"] = [];
  let refusal: Error | null = null;
  const record = (gate: string, args: unknown[]): void => {
    calls.push({ gate, args });
    if (refusal !== null) {
      const error = refusal;
      refusal = null;
      throw error;
    }
  };
  const resolved = { level: "full" as const, node: null };

  await mockModule("../../src/agents/shared/acting-principal", {
    actingPrincipal: async () => TEST_PRINCIPAL,
  });
  await mockModule("@fretik/shared/authz/access", {
    requireAccess: async (...args: unknown[]) => {
      record("requireAccess", args);
      return resolved;
    },
    resolveAccess: async (...args: unknown[]) => {
      record("resolveAccess", args);
      return resolved;
    },
  });
  await mockModule("@fretik/shared/authz/gates", {
    requireCapability: async (...args: unknown[]) => {
      record("requireCapability", args);
    },
    hasCapability: async (...args: unknown[]) => {
      record("hasCapability", args);
      return true;
    },
  });

  return {
    calls,
    refuseNext: (error) => {
      refusal = error;
    },
    restore: () => {
      void mock.module(
        new URL("../../src/agents/shared/acting-principal", import.meta.url)
          .pathname,
        () => realActing,
      );
      void mock.module("@fretik/shared/authz/access", () => realAccess);
      void mock.module("@fretik/shared/authz/gates", () => realGates);
    },
  };
};
