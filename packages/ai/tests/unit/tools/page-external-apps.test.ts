import "@hono/zod-openapi";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mockModule } from "../../lib/mock-module";

/**
 * What the builder is told about a connected app, before it writes a dataset.
 *
 * The build this exists for (Langfuse `01a03e9b…`, 2026-08-26) declared its
 * datasets with the app's PYTHON MODULE name instead of its connection key,
 * got `needs_connection` five times, and wrote 78 invented rows. Two facts
 * would have stopped it, and neither could reach a delegate: the key as it must
 * be written, and whether the team is connected at all.
 */

const realConnections =
  await import("@fretik/shared/services/pages/validate-connections");
const realSkills = await import("../../../src/skills/read-skill-file");

let connected = new Set<string>(["acme-crm"]);
await mockModule("@fretik/shared/services/pages/validate-connections", {
  teamConnectedProviderKeys: async () => connected,
});

// Keyed by the path it is ASKED for, so a wrongly folded key resolves to
// nothing here exactly as it would on disk — the property this file exploits.
const SKILLS: Record<string, string> = {
  "skills/acme-crm/SKILL.md": "# Acme CRM\n\nlist_deals(status) → rows",
  "skills/other-app/SKILL.md": "# Other App",
};
await mockModule("../../../src/skills/read-skill-file", {
  readSkillWorkspaceFile: async (_conversationId: string, path: string) =>
    SKILLS[path] ?? null,
});

afterAll(() => {
  void mock.module(
    "@fretik/shared/services/pages/validate-connections",
    () => realConnections,
  );
  void mock.module("../../../src/skills/read-skill-file", () => realSkills);
});

const { describeExternalApps } =
  await import("../../../src/tools/page-external-apps");

const describe_ = (keys: string[]) =>
  describeExternalApps({ keys, conversationId: "conv-1", teamId: "team-1" });

describe("describeExternalApps", () => {
  test("folds the key the way the connection list writes it, and says so", async () => {
    // `acme_crm` is the module name; `acme-crm` is the key. The build that
    // confused the two never loaded a row.
    const result = await describe_(["acme_crm"]);

    expect(result.unknown).toEqual([]);
    expect(result.block).toContain("## acme-crm");
    expect(result.block).toContain("`acme-crm`");
    expect(result.block).toContain("list_deals");
  });

  test("an app the team is not connected to is a refusal, not a caveat", async () => {
    connected = new Set<string>();
    const result = await describe_(["acme-crm"]);
    connected = new Set<string>(["acme-crm"]);

    expect(result.block).toContain("NO active connection");
    expect(result.block).toContain("never fill it with rows of your own");
  });

  test("a key nothing answers to is reported, never guessed at", async () => {
    const result = await describe_(["nosuchapp"]);

    expect(result.unknown).toEqual(["nosuchapp"]);
    expect(result.block).toBeNull();
  });

  test("no keys, no block — the builder pays nothing for a page with no app", async () => {
    const result = await describe_([]);
    expect(result.block).toBeNull();
  });
});
