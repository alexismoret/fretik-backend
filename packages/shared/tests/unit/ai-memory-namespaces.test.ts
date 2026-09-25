import { describe, expect, test } from "bun:test";
import { memoryNamespacesFor } from "../../src/services/ai-memory/namespaces";

/**
 * Which notes a turn reads and writes, by where it works and who writes in
 * it. The memory tool, the memory index and the sandbox mirror all ask this
 * one function, so a namespace offered in one is never refused by another.
 */
describe("memoryNamespacesFor", () => {
  test("a team's chat: the writer's own notes and the team's", () => {
    expect(memoryNamespacesFor({})).toEqual(["user", "team"]);
  });

  test("a project's chat adds the project's", () => {
    expect(memoryNamespacesFor({ projectId: "project-1" })).toEqual([
      "user",
      "team",
      "project",
    ]);
  });

  test("someone outside the team gets none of the team's", () => {
    expect(
      memoryNamespacesFor({ projectId: "project-1", outsideTeam: true }),
    ).toEqual(["user", "project"]);
    expect(memoryNamespacesFor({ outsideTeam: true })).toEqual(["user"]);
  });
});
